// Checks the automatic plan continuation: a turn of the agent's own chat or of a side thread that
// ends with open steps in the agent's plan runs once more with a short note, up to 8 times for one
// request. A turn with no open step runs once more, at most 2 times, when its answer only asks whether
// to continue or is short and ends on a next step that it did not do. Runs the real agent service on a temporary profile with a fake Codex app-server. The
// current message names its turns in `<<PLAN[...]PLAN>>`: each element is one turn, with its plan
// steps, its answer, its delay and its OpenBot tool calls. A continuation turn takes the next element
// of its thread.
// Checks:
//   1. A turn with open steps continues once, and the request completes when the plan is done.
//   2. A request continues at most 8 times.
//   3. A continuation that does not change the open steps stops the chain.
//   4. An answer whose last line asks a question does not continue. A question about a named action
//      does not continue either.
//   4a. An answer that only asks whether to continue keeps a plan with open steps going. An
//       approval question ("Proceed?"), a real question before it, or a wait does not continue.
//   4b. A turn with no plan continues when its answer ends on a next step or asks whether to
//       continue, at most 2 times for one request. A long report that ends on a next step does not.
//   5. A turn that opens a wait does not continue.
//   6. Stop during a continuation ends the chain. The next message works.
//   7. A message that waits in the queue stops the continuation and runs next.
//   8. A side thread continues in its own thread only.
//   9. A routine run does not continue.
//  10. A restart while a continuation waits completes the request with no new turn.
//  11. An MCP sign-in card stops an open plan in the main chat and a side thread. A new user
//      message can continue its plan even though the old card stays in that conversation.
// Not checked: a message sent in the short gap before a continuation starts. The drain starts the
// continuation at once, and a hidden agent refuses new messages. Check 7 covers the same rule.
// No provider, account or network is used. `bun run test:plan-continuation`.
// Writes .openbot-build/plan-continuation-e2e/report.json.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_PROVIDERS,
  type AgentEvent,
  type BrowserTab,
  mcpSignInEvent,
  PLAN_CONTINUATION_ITEM_TYPE,
  routineConversationEvent,
} from "@openbot/contracts/ipc";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { uiBlockAnswersFromResponse } from "@openbot/contracts/ui-blocks";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/plan-continuation-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-plan-continuation-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");
const NOTE_MARKER = "OpenBot note, not a message from the user";

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { agentWebhookRoutineWriter, HostEventsService } = await import("../src/main/host-events-service");

type StepStatus = "pending" | "inProgress" | "completed";

/** One turn of the fake: its plan, its answer, its delay and its OpenBot tool calls. */
interface FakeTurn {
  steps: [string, StepStatus][];
  answer?: string;
  answerPhase?: "commentary" | "final_answer";
  delayMs?: number;
  calls?: { tool: string; namespace?: "openbot" | "openbot_browser"; arguments: TeamProtocolV2Json }[];
}

const plan = (...turns: FakeTurn[]) => `<<PLAN${JSON.stringify(turns)}PLAN>>`;

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.166.0\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const session = require("node:crypto").randomUUID();
const NOTE = ${JSON.stringify(NOTE_MARKER)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
const waiting = new Map();
const timers = new Map();
/** The turns that each thread has still to run, from the message that named them. */
const scripts = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (turn) => {
  timers.delete(turn.turnId);
  const plan = (turn.script.steps || []).map(([step, status]) => ({ step, status }));
  if (plan.length > 0) write({ method: "turn/plan/updated", params: { threadId: turn.threadId, turnId: turn.turnId, plan } });
  const item = { type: "agentMessage", id: "message-" + turn.turnId, text: turn.script.answer || "Done.", phase: turn.script.answerPhase || "final_answer" };
  write({ method: "item/completed", params: { threadId: turn.threadId, turnId: turn.turnId, item } });
  write({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "completed" } } });
};
const callNext = (turn) => {
  const call = turn.calls.shift();
  if (!call) return timers.set(turn.turnId, setTimeout(() => finish(turn), turn.script.delayMs || 5));
  const id = "tool-" + turn.turnId + "-" + turn.calls.length;
  waiting.set(id, turn);
  write({ id, method: "item/tool/call", params: { threadId: turn.threadId, turnId: turn.turnId, callId: "call-" + id, namespace: call.namespace || "openbot", tool: call.tool, arguments: call.arguments } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + session + "-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const note = text.includes(NOTE);
      if (!note) {
        const named = /<<PLAN([\\s\\S]*?)PLAN>>/.exec(text.split("--- current message ---").at(-1));
        scripts.set(params.threadId, named ? JSON.parse(named[1]) : []);
      }
      const script = (scripts.get(params.threadId) || []).shift() || { steps: [] };
      log({ method: "turn", threadId: params.threadId, turnId, note, text });
      const turn = { threadId: params.threadId, turnId, script, calls: [...(script.calls || [])] };
      return callNext(turn);
    }
    case "turn/interrupt": {
      clearTimeout(timers.get(params.turnId));
      timers.delete(params.turnId);
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
      else if (!message.method && waiting.has(message.id)) {
        const turn = waiting.get(message.id);
        waiting.delete(message.id);
        log({ method: "toolResult", result: message.result });
        callNext(turn);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const report: {
  checks: { name: string; passed: boolean; detail?: unknown }[];
  notChecked: string[];
  passed: boolean;
  checkedAt?: string;
  error?: string;
} = {
  checks: [],
  notChecked: ["a message sent in the short gap before a continuation starts (check 7 covers the same rule)"],
  passed: false,
};

const unused = () => Effect.die(new Error("Not used by this check."));
const browserTabs: BrowserTab[] = [];
const browser: AgentBrowserHost = {
  listTabs: () => browserTabs,
  beginTakeover: () => Effect.void,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
  shareTab: () => undefined,
  unshareThread: () => undefined,
  agentTab: () => null,
};

/** Waits for a state of the service, its database or the fake's log. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

interface LoggedTurn {
  method: string;
  threadId: string;
  turnId: string;
  note: boolean;
  text: string;
}

function loggedTurns(): LoggedTurn[] {
  let text = "";
  try {
    text = readFileSync(fakeLog, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line): LoggedTurn => JSON.parse(line))
    .filter((entry) => entry.method === "turn");
}

async function check(name: string, run: () => Promise<unknown>) {
  const detail = await run();
  report.checks.push({ name, passed: true, detail });
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });

function openService() {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const service: InstanceType<typeof AgentService> = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
    webhookRoutines: () => agentWebhookRoutineWriter(hostEvents),
    marketplaceAppServer: (appId) => {
      const config = service.listMcpServers().find((row) => row.name === appId);
      return config ? { config, setupSteps: ["Start the service in its settings."] } : null;
    },
  });
  const hostEvents = new HostEventsService({
    routines: service.routineRecords,
    cipher: {
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
    },
    relay: {
      connected: () => true,
      setEnabled: () => {},
      setAccountActive: () => {},
      refresh: () => {},
      registerRoute: (id) => Effect.succeed(`https://signal.example.test/v1/webhooks/${id}`),
      revokeRoute: () => Effect.void,
    },
    accountPrincipal: () => "plan-check",
  });
  const events: AgentEvent[] = [];
  service.on("event", (event) => events.push(event));
  return { database, store, mailbox, service, events, hostEvents };
}

let current = openService();

const ended = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";

async function createAgent(name: string) {
  const { service } = current;
  const agent = await runCauseEffect(
    service.createAgent({
      name,
      description: "Checks the automatic plan continuation.",
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor(`${name}'s first turn`, () =>
    service.listQueue(agent.id).deliveries.every((delivery) => ended(delivery.status)),
  );
  return agent;
}

/** Sends a message, to the agent's own chat or to its side thread. Answers its delivery id. */
async function send(agentId: string, text: string, taskId?: string): Promise<string> {
  const receipt = await runCauseEffect(
    current.service.sendMessage({ agentId, text, attachmentDraftIds: [], ...(taskId ? { taskId } : {}) }),
  );
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId, "The message has a delivery.");
  return deliveryId;
}

/** Waits for the delivery to end, with all of its continuations, and answers its status. */
function settled(deliveryId: string, timeoutMs?: number) {
  return waitFor(
    `delivery ${deliveryId} to end`,
    () => {
      const value = current.mailbox.getDelivery(deliveryId)?.delivery.status;
      return ended(value) ? value : null;
    },
    timeoutMs,
  );
}

/** The messages of the agent's own chat or of one side thread, as the database holds them. */
function chatMessages(agentId: string, sideThreadId?: string) {
  const threadId = sideThreadId ?? current.store.list().find((agent) => agent.id === agentId)?.threadId ?? null;
  return current.database.readConversation(agentId, threadId).messages;
}

/** The continuation lines of the agent's own chat or of one side thread, as the database holds them. */
function continuationLines(agentId: string, sideThreadId?: string) {
  return chatMessages(agentId, sideThreadId).filter((message) => message.itemType === PLAN_CONTINUATION_ITEM_TYPE);
}

function errorsFor(agentId: string, since: number) {
  return current.events.slice(since).filter((event) => event.type === "error" && event.agentId === agentId);
}

const turnsSince = (mark: number) => loggedTurns().slice(mark);

try {
  await runCauseEffect(current.service.initialize());

  await check("a turn with open steps continues once, then the request completes", async () => {
    const agent = await createAgent("Finisher");
    const mark = loggedTurns().length;
    const since = current.events.length;
    const id = await send(
      agent.id,
      `Build it. ${plan(
        {
          steps: [
            ["Write the code", "completed"],
            ["Run the tests", "pending"],
          ],
          answer: "The code is written.",
        },
        {
          steps: [
            ["Write the code", "completed"],
            ["Run the tests", "completed"],
          ],
          answer: "The tests pass.",
        },
      )}`,
    );
    assert.equal(await settled(id), "completed");
    const turns = turnsSince(mark);
    assert.deepEqual(
      turns.map((turn) => turn.note),
      [false, true],
      "One continuation turn runs.",
    );
    const note = turns[1]?.text ?? "";
    assert.ok(note.includes("[pending] Run the tests"), "The note names the open step.");
    assert.ok(!note.includes("Write the code"), "The note does not name the done step.");
    assert.ok(note.includes("Automatic continuation 1 of 8."));
    assert.equal(continuationLines(agent.id).length, 1, "One continuation line shows.");
    assert.equal(errorsFor(agent.id, since).length, 0, "No error shows.");
    const completions = current.events
      .slice(since)
      .filter((event) => event.type === "turn-completed" && event.agentId === agent.id);
    assert.deepEqual(
      completions.map((event) => event.type === "turn-completed" && event.continues === true),
      [true, false],
      "Only the last turn of the request completes it.",
    );
    const messages = chatMessages(agent.id);
    assert.ok(!messages.some((message) => message.text?.includes(NOTE_MARKER)), "The note does not show as a message.");
    assert.ok(
      messages.some((message) => message.text === "The tests pass."),
      "The answer of the continuation shows.",
    );
    const shown = messages.flatMap((message) => {
      if (message.id === id) return ["request"];
      if (message.itemType === PLAN_CONTINUATION_ITEM_TYPE) return ["line"];
      return message.text === "The code is written." || message.text === "The tests pass." ? [message.text] : [];
    });
    assert.deepEqual(
      shown,
      ["request", "The code is written.", "line", "The tests pass."],
      "The first answer and the line show between the request and the continuation's answer.",
    );
    return { turns: turns.length, line: continuationLines(agent.id)[0]?.id, shown };
  });

  await check("a request continues at most 8 times", async () => {
    const agent = await createAgent("Capped");
    const mark = loggedTurns().length;
    const names = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
    const step = (done: number): FakeTurn => ({
      steps: names.map((text, index) => [text, index < done ? "completed" : "pending"]),
    });
    const id = await send(agent.id, `Do ten things. ${plan(...names.map((_, done) => step(done)))}`);
    assert.equal(await settled(id), "completed");
    const turns = turnsSince(mark);
    assert.deepEqual(
      turns.map((turn) => turn.note),
      [false, true, true, true, true, true, true, true, true],
      "Eight continuation turns run.",
    );
    assert.ok(turns[8]?.text.includes("Automatic continuation 8 of 8."));
    assert.equal(continuationLines(agent.id).length, 8, "Eight continuation lines show.");
    return { turns: turns.length };
  });

  await check("a continuation that does not change the open steps stops the chain", async () => {
    const agent = await createAgent("Stuck");
    const mark = loggedTurns().length;
    const stuck: FakeTurn = {
      steps: [
        ["Read", "completed"],
        ["Fix", "inProgress"],
      ],
    };
    const id = await send(agent.id, `Fix it. ${plan(stuck, stuck, stuck)}`);
    assert.equal(await settled(id), "completed");
    assert.equal(turnsSince(mark).length, 2, "One continuation turn runs.");
    assert.ok(turnsSince(mark)[1]?.text.includes("[in progress] Fix"));
    assert.equal(continuationLines(agent.id).length, 1);
    return { turns: turnsSince(mark).length };
  });

  await check("an answer whose last line asks a question does not continue", async () => {
    const agent = await createAgent("Asker");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `Plan the trip. ${plan({
        steps: [
          ["Pick dates", "completed"],
          ["Book hotel", "pending"],
        ],
        answer: "**Which hotel do you want?** Tell me and I book it.",
      })}`,
    );
    assert.equal(await settled(id), "completed");
    assert.equal(turnsSince(mark).length, 1, "No continuation turn runs.");
    assert.equal(continuationLines(agent.id).length, 0);
    return { turns: 1 };
  });

  await check("a question about a named action does not continue", async () => {
    const agent = await createAgent("Deployer");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `Ship it. ${plan({
        steps: [
          ["Build", "completed"],
          ["Deploy", "pending"],
        ],
        answer: "The build is ready. Should I proceed with the deploy?",
      })}`,
    );
    assert.equal(await settled(id), "completed");
    assert.equal(turnsSince(mark).length, 1, "No continuation turn runs.");
    assert.equal(continuationLines(agent.id).length, 0);
    return { turns: 1 };
  });

  await check("approval questions, hidden questions and waits do not continue", async () => {
    const agent = await createAgent("Careful");
    const answers = [
      "This drops the users table in production. Proceed?",
      "Should I go ahead?",
      "Do you want Postgres or SQLite? Shall I continue?",
      "Should I continue with the deploy?",
      "Should I continue with the rest of the deploy?",
      "I'll now wait for your approval.",
      "Next, I would restart the production service.",
      "The fix is in. Let me know if you need anything else.",
      "I'll implement it after your confirmation.",
      "I'll update you when the build finishes.",
      "I'll update you on the progress.",
      "Next, I'll implement it after your confirmation.",
      "Let me check with the team and get back to you.",
    ];
    // Each request opens a new step, so a step left open by an earlier answer does not hide the plan.
    for (const [index, answer] of answers.slice(0, 6).entries()) {
      const mark = loggedTurns().length;
      const id = await send(
        agent.id,
        `Check it. ${plan({
          steps: [
            ["Prepare", "completed"],
            [`Run part ${index + 1}`, "pending"],
          ],
          answer,
        })}`,
      );
      assert.equal(await settled(id), "completed");
      assert.equal(turnsSince(mark).length, 1, `No continuation turn runs after: ${answer}`);
    }
    for (const answer of answers.slice(4)) {
      const mark = loggedTurns().length;
      const id = await send(agent.id, `Check it again. ${plan({ steps: [], answer })}`);
      assert.equal(await settled(id), "completed");
      assert.equal(turnsSince(mark).length, 1, `No next-step turn runs after: ${answer}`);
    }
    const lines = continuationLines(agent.id);
    assert.equal(lines.length, 0);
    return { answers: answers.length };
  });

  await check("an answer that only asks whether to continue keeps the plan going", async () => {
    const agent = await createAgent("Permission");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `Migrate it. ${plan(
        {
          steps: [
            ["Move the files", "completed"],
            ["Fix the imports", "pending"],
          ],
          answer: "The files are moved.\n\n**Shall I continue with the next step?**",
        },
        {
          steps: [
            ["Move the files", "completed"],
            ["Fix the imports", "completed"],
          ],
          answer: "The imports are fixed.",
        },
      )}`,
    );
    assert.equal(await settled(id), "completed");
    const turns = turnsSince(mark);
    assert.deepEqual(
      turns.map((turn) => turn.note),
      [false, true],
      "One continuation turn runs.",
    );
    assert.ok(turns[1]?.text.includes("[pending] Fix the imports"), "The plan note names the open step.");
    assert.ok(turns[1]?.text.includes("Do not ask whether to continue."));
    return { turns: turns.length };
  });

  await check("explicit human dependencies survive a closing paragraph while runnable work continues", async () => {
    const agent = await createAgent("HumanDependencies");
    const cases: Array<[string, boolean]> = [
      [
        "OpenBot requires you to create signing keys from the routine cards before I can finish the sender setup.\n\nThe two webhook routines are ready.",
        true,
      ],
      [
        "Once you've copied the signing keys into the sending service, I can finish the setup.\n\nThe webhook URLs are ready.",
        true,
      ],
      ["I need you to sign in with the card.\n\nThe report outline is ready.", true],
      ["Which workspace should I use?\n\nThe report outline is ready.", true],
      ["Blocked until the signing keys are configured.\n\nThe routines are ready.", true],
      ["I cannot continue until you approve the account connection.\n\nThe rest is prepared.", true],
      ["You approved it; I can now run the tests.", false],
      ["After you signed in, I verified the account. I will now run the report.", false],
      ["The signing key is already configured. I'll now run the check.", false],
      ["I will generate a local test key and run the tests.", false],
      ["The build is still running. I'll now inspect its output.", false],
      ["> OpenBot requires you to create signing keys.\n\nThat is a quoted example. I'll now write the test.", false],
      ["```text\nPlease sign in.\nWhich account do you want?\n```\n\nI'll now write the test.", false],
      ['The documentation says "Please sign in". I can test the parser locally.', false],
      ["No user action is required. I'll now run the tests.", false],
    ];
    for (const [index, [answer, blocked]] of cases.entries()) {
      const mark = loggedTurns().length;
      const step = `Finish case ${index}`;
      const id = await send(
        agent.id,
        `Check this case. ${plan({ steps: [[step, "pending"]], answer }, { steps: [[step, "completed"]], answer: "Done." })}`,
      );
      assert.equal(await settled(id), "completed");
      assert.deepEqual(
        turnsSince(mark).map((turn) => turn.note),
        blocked ? [false] : [false, true],
        answer,
      );
    }
    return {
      blocked: cases.filter(([, blocked]) => blocked).length,
      runnable: cases.filter(([, blocked]) => !blocked).length,
    };
  });

  await check("a turn with no plan continues after it names a next step or asks to continue", async () => {
    const agent = await createAgent("Announcer");
    const mark = loggedTurns().length;
    const since = current.events.length;
    const id = await send(
      agent.id,
      `Fix the bug. ${plan(
        { steps: [], answer: "I found the cause in the parser. Let me fix it in src/parser.ts." },
        { steps: [], answer: "The fix is in. Do you want me to continue with the remaining files?" },
        { steps: [], answer: "The fix is in and the tests pass." },
      )}`,
    );
    assert.equal(await settled(id), "completed");
    const turns = turnsSince(mark);
    assert.deepEqual(
      turns.map((turn) => turn.note),
      [false, true, true],
      "Two next-step continuation turns run.",
    );
    assert.ok(turns[1]?.text.includes("Your last turn ended before the next step"), "The next-step note is sent.");
    assert.ok(turns[2]?.text.includes("Automatic continuation 2 of 2."), "The note counts next-step continuations.");
    const lines = continuationLines(agent.id);
    assert.equal(lines.length, 2, "Two continuation lines show.");
    assert.ok(lines[0]?.text?.includes("stopped before its next step"), "The line names the next-step reason.");
    assert.ok(lines[1]?.text?.includes("(2 of 2)"), "The line counts next-step continuations.");
    assert.equal(errorsFor(agent.id, since).length, 0, "No error shows.");
    assert.ok(
      chatMessages(agent.id).some((message) => message.text === "The fix is in and the tests pass."),
      "The last answer shows.",
    );
    return { turns: turns.length };
  });

  await check("a request with no plan continues at most 2 times for a next step", async () => {
    const agent = await createAgent("Repeater");
    const mark = loggedTurns().length;
    const stalled: FakeTurn = { steps: [], answer: "Next, I'll run the tests." };
    const id = await send(agent.id, `Test it. ${plan(stalled, stalled, stalled, stalled)}`);
    assert.equal(await settled(id), "completed");
    assert.deepEqual(
      turnsSince(mark).map((turn) => turn.note),
      [false, true, true],
      "Two next-step continuation turns run.",
    );
    return { turns: turnsSince(mark).length };
  });

  await check("short work promises and work status messages continue without a plan", async () => {
    const agent = await createAgent("InvoiceRetriever");
    const answers = [
      "I’m retrieving the PostHog Venn draft and its review link now.",
      "I’ll retrieve the invoice and its review link.",
      "I will fetch the invoice.",
      "I am checking the invoice details.",
    ];
    for (const answer of answers) {
      const mark = loggedTurns().length;
      const id = await send(
        agent.id,
        `Get the invoice. ${plan(
          { steps: [], answer },
          { steps: [], answer: "The invoice is ready: https://example.test/invoice/fixture." },
        )}`,
      );
      assert.equal(await settled(id), "completed");
      assert.deepEqual(
        turnsSince(mark).map((turn) => turn.note),
        [false, true],
        `One continuation runs after: ${answer}`,
      );
    }
    return { answers: answers.length };
  });

  await check("work promises do not bypass human dependencies or quoted reports", async () => {
    const agent = await createAgent("InvoiceDependencies");
    const answers = [
      "I’ll retrieve the invoice after you sign in.",
      "I’m waiting for your approval.",
      "I cannot continue until you approve. I’ll retrieve the invoice.",
      "> I’m retrieving the invoice now.",
      'The earlier message said "I’ll retrieve the invoice."',
      "```text\nI’m retrieving the invoice now.\n```",
      "The invoice is ready: https://example.test/invoice/fixture.",
      "The invoice is ready. I’ll keep this in mind.",
      `${"The invoice details match the saved record. ".repeat(12)}I’ll retrieve the invoice.`,
    ];
    for (const answer of answers) {
      const mark = loggedTurns().length;
      const id = await send(agent.id, `Check the invoice. ${plan({ steps: [], answer })}`);
      assert.equal(await settled(id), "completed");
      assert.equal(turnsSince(mark).length, 1, `No continuation runs after: ${answer}`);
    }
    return { answers: answers.length };
  });

  await check("a completed commentary-only work status continues without becoming a final answer", async () => {
    const agent = await createAgent("CommentaryRetriever");
    const announcement = "I’m retrieving the PostHog Venn draft and its review link now.";
    const answer = "The invoice is ready: https://example.test/invoice/fixture.";
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `Get the invoice. ${plan({ steps: [], answer: announcement, answerPhase: "commentary" }, { steps: [], answer })}`,
    );
    assert.equal(await settled(id), "completed");
    assert.deepEqual(
      turnsSince(mark).map((turn) => turn.note),
      [false, true],
    );
    const messages = chatMessages(agent.id);
    assert(messages.some((message) => message.text === announcement && message.itemType === "commentary"));
    assert(!messages.some((message) => message.text === announcement && message.itemType === "final_answer"));
    assert(messages.some((message) => message.text === answer && message.itemType === "final_answer"));
    for (const dependency of ["I’m waiting for your approval.", "Which invoice should I retrieve?"]) {
      const before = loggedTurns().length;
      const request = await send(
        agent.id,
        `Check the invoice. ${plan({ steps: [], answer: dependency, answerPhase: "commentary" })}`,
      );
      assert.equal(await settled(request), "completed");
      assert.equal(turnsSince(before).length, 1, "A commentary dependency must not continue.");
    }
    return { turns: 2, dependencies: 2 };
  });

  await check("a long report that ends on a next step does not continue", async () => {
    const agent = await createAgent("Reporter");
    const mark = loggedTurns().length;
    const report = `${"The parser reads each line and keeps the state of the open block. ".repeat(8)}I'll now wait for your review.`;
    const id = await send(agent.id, `Explain it. ${plan({ steps: [], answer: report })}`);
    assert.equal(await settled(id), "completed");
    assert.equal(turnsSince(mark).length, 1, "No continuation turn runs.");
    assert.equal(continuationLines(agent.id).length, 0);
    return { turns: 1 };
  });

  await check("steps left open by an earlier request do not start or extend a continuation", async () => {
    const agent = await createAgent("Switcher");
    const left: [string, StepStatus] = ["Book hotel", "pending"];
    const first = await send(
      agent.id,
      `Plan the trip. ${plan({ steps: [["Pick dates", "completed"], left], answer: "Which hotel do you want?" })}`,
    );
    assert.equal(await settled(first), "completed");
    const mark = loggedTurns().length;
    const second = await send(
      agent.id,
      `Fix the typo. ${plan({ steps: [left, ["Fix the typo", "completed"]], answer: "The typo is fixed." })}`,
    );
    assert.equal(await settled(second), "completed");
    assert.equal(turnsSince(mark).length, 1, "An old open step alone does not continue.");
    const third = await send(
      agent.id,
      `Ship it. ${plan(
        { steps: [left, ["Build", "completed"], ["Release", "pending"]], answer: "The build is done." },
        { steps: [left, ["Build", "completed"], ["Release", "completed"]], answer: "It is released." },
      )}`,
    );
    assert.equal(await settled(third), "completed");
    const turns = turnsSince(mark).slice(1);
    assert.deepEqual(
      turns.map((turn) => turn.note),
      [false, true],
      "Only the new open step continues, once.",
    );
    assert.ok(turns[1]?.text.includes("[pending] Release"), "The note names the new step.");
    assert.ok(!turns[1]?.text.includes("Book hotel"), "The note does not name the old step.");
    return { turns: turns.length };
  });

  await check("a turn that opens a wait does not continue", async () => {
    const agent = await createAgent("Waiter");
    const routine = current.service.createRoutine(
      {
        agentId: agent.id,
        name: "Build check",
        instruction: "Check the build.",
        active: false,
        timezone: "UTC",
        schedule: { kind: "custom", expression: "0 * * * *" },
      },
      { recordConversationEvent: false },
    );
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `Ship it. ${plan({
        steps: [
          ["Start the build", "completed"],
          ["Ship", "pending"],
        ],
        calls: [{ tool: "await_event", arguments: { note: "Wait for the build.", routineId: routine.id } }],
        answer: "I wait for the build.",
      })}`,
    );
    assert.equal(await settled(id), "completed");
    assert.equal(current.service.listWaits(agent.id).waits.length, 1, "The wait is open.");
    assert.equal(turnsSince(mark).length, 1, "No continuation turn runs.");
    assert.equal(continuationLines(agent.id).length, 0);
    return { turns: 1 };
  });

  for (const side of [false, true]) {
    for (const needsKey of [false, true]) {
      await check(
        `an MCP ${needsKey ? "key request" : "sign-in card"} stops the ${side ? "side thread" : "main chat"} plan until a new user request`,
        async () => {
          const server = createServer((_request, response) => {
            response.writeHead(401, {
              "content-type": "application/json",
              ...(needsKey ? {} : { "www-authenticate": 'Bearer realm="plan-check"' }),
            });
            response.end(JSON.stringify({ error: "unauthorized" }));
          });
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          try {
            const address = server.address();
            assert.ok(address && typeof address === "object");
            const name = `auth-${needsKey ? "key" : "sign-in"}-${side ? "side" : "main"}`;
            await runCauseEffect(
              current.service.saveMcpServer({
                config: {
                  id: "",
                  name,
                  transport: "http",
                  enabled: false,
                  url: `http://127.0.0.1:${address.port}/mcp`,
                  command: "",
                  args: [],
                  env: [],
                  envPassthrough: [],
                  workingDirectory: "",
                  headers: [],
                },
              }),
            );
            const config = current.service.listMcpServers().find((row) => row.name === name);
            assert.ok(config);
            const agent = await createAgent(side ? "SignInSide" : "SignInMain");
            const task = side
              ? await runCauseEffect(current.service.startTask({ agentId: agent.id, text: "Set up the account." }))
              : undefined;
            if (task)
              await waitFor(
                "the sign-in side thread setup",
                () =>
                  current.service.listTasks(agent.id).tasks.find((item) => item.id === task.id)?.outcome ===
                  "completed",
              );
            const mark = loggedTurns().length;
            const id = await send(
              agent.id,
              `Read the account. ${plan(
                {
                  steps: [["Read the account", "pending"]],
                  calls: [{ tool: "test_mcp_server", arguments: { name } }],
                  // This wording has no question or textual wait that the existing last-line rule catches.
                  answer: "The account connection is ready for setup. The account report comes next.",
                },
                { steps: [["Read the account", "completed"]], answer: "This turn must not run before sign-in." },
              )}`,
              task?.id,
            );
            assert.equal(await settled(id), "completed");
            const turns = turnsSince(mark);
            assert.deepEqual(
              turns.map((turn) => turn.note),
              [false],
              "An actual sign-in request does not auto-continue.",
            );
            const cards = chatMessages(agent.id, task?.threadId).filter(
              (message) => mcpSignInEvent(message)?.mcpServerId === config.id,
            );
            assert.equal(
              cards.length,
              needsKey ? 0 : 1,
              "Only the sign-in challenge posts a card; key setup still pauses without one.",
            );
            if (!needsKey)
              assert.equal(cards[0]?.turnId, turns[0]?.turnId, "The sign-in card belongs to the current turn.");
            assert.equal(continuationLines(agent.id, task?.threadId).length, 0);
            if (task)
              assert.equal(
                chatMessages(agent.id).filter((message) => mcpSignInEvent(message)).length,
                0,
                "The side thread's sign-in card stays out of the main chat.",
              );

            const resumedMark = loggedTurns().length;
            const next = await send(
              agent.id,
              `Now prepare the report. ${plan(
                {
                  steps: [
                    ["Read the account", "completed"],
                    ["Finish the report", "pending"],
                  ],
                  answer: "The account data is ready.",
                },
                {
                  steps: [
                    ["Read the account", "completed"],
                    ["Finish the report", "completed"],
                  ],
                  answer: "The report is complete.",
                },
              )}`,
              task?.id,
            );
            assert.equal(await settled(next), "completed");
            assert.deepEqual(
              turnsSince(resumedMark).map((turn) => turn.note),
              [false, true],
              "An earlier turn's sign-in card does not stop a new user request.",
            );
            return { signInTurn: turns[0]?.turnId, resumedTurns: turnsSince(resumedMark).length, sideThread: side };
          } finally {
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
          }
        },
      );
    }
  }

  for (const [side, crossAgent] of [
    [false, false],
    [true, false],
    [true, true],
  ] as const) {
    await check(
      `new ${crossAgent ? "cross-agent " : ""}webhook signing-key setup pauses the ${side ? "side thread" : "main chat"} without exposing its secret`,
      async () => {
        const agent = await createAgent(side ? "WebhookSide" : "WebhookMain");
        const target = crossAgent ? await createAgent("WebhookTarget") : agent;
        const task = side
          ? await runCauseEffect(current.service.startTask({ agentId: agent.id, text: "Set up signed webhooks." }))
          : undefined;
        if (task)
          await waitFor(
            "the webhook side thread setup",
            () =>
              current.service.listTasks(agent.id).tasks.find((item) => item.id === task.id)?.outcome === "completed",
          );
        const mark = loggedTurns().length;
        const name = `Signed events ${side ? "side" : "main"}`;
        const id = await send(
          agent.id,
          `Connect the event sender. ${plan(
            {
              steps: [
                ["Create the webhook", "completed"],
                ["Configure the event sender", "pending"],
              ],
              calls: [
                {
                  tool: "create_webhook_routine",
                  arguments: {
                    name,
                    instruction: "Summarize the event.",
                    active: false,
                    ...(crossAgent ? { agentId: target.id } : {}),
                  },
                },
              ],
              // Even a neutral final answer must respect the tool's structured human handoff.
              answer: "The webhook routine is ready. The sender setup is the remaining step.",
            },
            { steps: [["Configure the event sender", "completed"]], answer: "This must not run before key setup." },
          )}`,
          task?.id,
        );
        assert.equal(await settled(id), "completed");
        assert.deepEqual(
          turnsSince(mark).map((turn) => turn.note),
          [false],
        );
        const routine = (
          await Effect.runPromise(current.hostEvents.listRoutines({ owner: { kind: "agent", id: target.id } }))
        ).find((item) => item.name === name);
        assert.ok(routine?.trigger.kind === "webhook");
        assert.equal(routine.active, false);
        const messages = chatMessages(agent.id, task?.threadId);
        if (crossAgent) {
          assert.ok(
            !messages.some((message) => routineConversationEvent(message)?.routineId === routine.id),
            "Cross-agent creation uses the target settings, not a caller secret card.",
          );
          assert.ok(!JSON.stringify(chatMessages(target.id)).includes("whsec_"));
        } else
          assert.ok(
            messages.some(
              (message) =>
                routineConversationEvent(message)?.routineId === routine.id &&
                message.turnId === turnsSince(mark)[0]?.turnId,
            ),
          );
        assert.ok(!JSON.stringify(messages).includes("whsec_"), "The chat never contains the signing secret.");
        assert.equal(continuationLines(agent.id, task?.threadId).length, 0);

        // A later human request may update that webhook, create a schedule routine, and continue.
        const resumeMark = loggedTurns().length;
        const next = await send(
          agent.id,
          `The sender is configured. Finish the report. ${plan(
            {
              steps: [
                ["Configure the event sender", "completed"],
                ["Finish the report", "pending"],
              ],
              calls: [
                {
                  tool: "update_webhook_routine",
                  arguments: {
                    routineId: routine.id,
                    ...(crossAgent ? { agentId: target.id } : {}),
                    active: false,
                    eventType: "build.failed",
                  },
                },
                {
                  tool: "create_routine",
                  arguments: {
                    name: "Daily summary",
                    instruction: "Summarize events.",
                    active: false,
                    timezone: "UTC",
                    schedule: { kind: "daily", time: "09:00" },
                  },
                },
              ],
              answer: "The routine settings are saved. The report is next.",
            },
            { steps: [["Finish the report", "completed"]], answer: "The report is complete." },
          )}`,
          task?.id,
        );
        assert.equal(await settled(next), "completed");
        assert.deepEqual(
          turnsSince(resumeMark).map((turn) => turn.note),
          [false, true],
          "Old holds, webhook updates and schedule routine creation do not block runnable work.",
        );
        assert.ok(current.service.listRoutines(agent.id).some((item) => item.name === "Daily summary"));
        return { sideThread: side, crossAgent, resumedTurns: turnsSince(resumeMark).length };
      },
    );
  }

  await check("a marketplace install handoff pauses its plan", async () => {
    const agent = await createAgent("InstallHandoff");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `Connect GitHub and finish the report. ${plan(
        {
          steps: [["Connect GitHub", "pending"]],
          calls: [{ tool: "suggest_marketplace_app", arguments: { app: "github" } }],
          answer: "The connection card is ready. The report outline is prepared.",
        },
        { steps: [["Connect GitHub", "completed"]], answer: "This must not run." },
      )}`,
    );
    assert.equal(await settled(id), "completed");
    assert.deepEqual(
      turnsSince(mark).map((turn) => turn.note),
      [false],
    );
    assert.ok(chatMessages(agent.id).some((message) => message.itemType?.startsWith("marketplace-suggestion:")));
    return { turns: 1 };
  });

  await check("ready MCP and a disabled app remain runnable, while an app setup handoff pauses", async () => {
    let available = true;
    let probes = 0;
    const server = createServer((request, response) => {
      void (async () => {
        if (!available) {
          response.writeHead(503).end();
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        let text = "";
        for await (const chunk of request) text += chunk.toString();
        const message = JSON.parse(text);
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        probes += 1;
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "plan-check", version: "1" },
              }
            : {
                tools: [
                  {
                    name: "read_account",
                    description: "Read the account.",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      })().catch(() => response.writeHead(500).end());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const name = "github";
      const config = {
        id: "",
        name,
        transport: "http" as const,
        enabled: false,
        url: `http://127.0.0.1:${address.port}/mcp`,
        command: "",
        args: [],
        env: [],
        envPassthrough: [],
        workingDirectory: "",
        headers: [],
      };
      await runCauseEffect(current.service.saveMcpServer({ config }));
      const saved = current.service.listMcpServers().find((row) => row.name === name);
      assert.ok(saved);
      const agent = await createAgent("ReadyMcp");
      for (const mode of ["ready", "disabled", "setup"] as const) {
        available = mode !== "setup";
        if (mode === "setup")
          await runCauseEffect(current.service.setMcpServerEnabled({ mcpServerId: saved.id, enabled: true }));
        const mark = loggedTurns().length;
        const step = `Finish MCP ${mode}`;
        const call: NonNullable<FakeTurn["calls"]>[number] =
          mode === "ready"
            ? { tool: "test_mcp_server", arguments: { name } }
            : { tool: "suggest_marketplace_app", arguments: { app: name } };
        const id = await send(
          agent.id,
          `Prepare the report. ${plan({ steps: [[step, "pending"]], calls: [call], answer: "The report outline is prepared." }, { steps: [[step, "completed"]], answer: "The report is complete." })}`,
        );
        assert.equal(await settled(id), "completed");
        assert.deepEqual(
          turnsSince(mark).map((turn) => turn.note),
          mode === "setup" ? [false] : [false, true],
          mode,
        );
        if (mode === "ready") assert.ok(probes > 0, "The real MCP server was inspected successfully.");
      }
      await runCauseEffect(current.service.setMcpServerEnabled({ mcpServerId: saved.id, enabled: false }));
      return { cases: 3, probes };
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  await check("skipped questions and declined approvals pause while answered inputs permit continuation", async () => {
    const agent = await createAgent("AttentionDecisions");
    const config = current.service.listMcpServers()[0];
    assert.ok(config);
    for (const kind of ["question", "approval"] as const) {
      for (const accept of [false, true]) {
        const mark = loggedTurns().length;
        const since = current.events.length;
        const step = `Finish ${kind} ${accept}`;
        const call: NonNullable<FakeTurn["calls"]>[number] =
          kind === "question"
            ? {
                tool: "ask_user",
                arguments: {
                  questions: [
                    {
                      id: "account",
                      header: "Account",
                      question: "Which account should I use?",
                      options: [{ label: "Development", description: "Use the development account." }],
                    },
                  ],
                },
              }
            : { tool: "set_mcp_server_enabled", arguments: { name: config.name, enabled: false } };
        const id = await send(
          agent.id,
          `Prepare the report. ${plan({ steps: [[step, "pending"]], calls: [call], answer: "The report outline is ready." }, { steps: [[step, "completed"]], answer: "The report is complete." })}`,
        );
        if (kind === "question") {
          const pending = await waitFor("the user question", () =>
            current.events.slice(since).find((event) => event.type === "prompt" && event.agentId === agent.id),
          );
          assert.ok(pending.type === "prompt");
          await runCauseEffect(
            current.service.respondToPrompt({
              requestId: pending.requestId,
              answers: accept ? { account: ["Development"] } : {},
            }),
          );
        } else {
          const pending = await waitFor("the user approval", () =>
            current.events
              .slice(since)
              .find((event) => event.type === "approval" && event.approval.agentId === agent.id),
          );
          assert.ok(pending.type === "approval");
          await runCauseEffect(
            current.service.respondToApproval({
              requestId: pending.approval.requestId,
              decision: accept ? "accept" : "decline",
            }),
          );
        }
        assert.equal(await settled(id), "completed");
        assert.deepEqual(
          turnsSince(mark).map((turn) => turn.note),
          accept ? [false, true] : [false],
          `${kind}: ${accept ? "accepted" : "not accepted"}`,
        );
      }
    }
    return { cases: 4 };
  });

  await check("acknowledgement cancel stops the plan but start and a custom cancel-named choice do not", async () => {
    const agent = await createAgent("AcknowledgementDecisions");
    await runCauseEffect(current.service.updateAgent({ agentId: agent.id, quickAcknowledgement: true }));
    for (const mode of ["cancel", "start", "custom"] as const) {
      const mark = loggedTurns().length;
      const since = current.events.length;
      const step = `Finish acknowledgement ${mode}`;
      const call: NonNullable<FakeTurn["calls"]>[number] =
        mode === "custom"
          ? {
              tool: "ask_ui",
              arguments: {
                block: {
                  type: "confirm",
                  title: "Choose the example action.",
                  actions: [{ id: "cancel", label: "Use cancellation sample" }],
                },
              },
            }
          : {
              tool: "acknowledge_request",
              arguments: {
                message: "I can prepare the report.",
                steps: [{ label: "First", step: "Prepare the report." }],
                startLabel: "Start",
                cancelLabel: "Cancel",
              },
            };
      const id = await send(
        agent.id,
        `Prepare the report. ${plan({ steps: [[step, "pending"]], calls: [call], answer: "The report outline is ready." }, { steps: [[step, "completed"]], answer: "The report is complete." })}`,
      );
      const pending = await waitFor("the confirmation card", () =>
        current.events.slice(since).find((event) => event.type === "prompt" && event.agentId === agent.id),
      );
      assert.ok(pending.type === "prompt");
      const block = chatMessages(agent.id).find(
        (message) => message.turnId === pending.turnId && message.uiBlock,
      )?.uiBlock;
      assert.ok(block);
      const answers = uiBlockAnswersFromResponse(block.spec, { actionId: mode === "custom" ? "cancel" : mode });
      await runCauseEffect(current.service.respondToPrompt({ requestId: pending.requestId, answers }));
      assert.equal(await settled(id), "completed");
      assert.deepEqual(
        turnsSince(mark).map((turn) => turn.note),
        mode === "cancel" ? [false] : [false, true],
      );
    }
    return { cases: 3 };
  });

  await check("cancelled browser takeover pauses while a completed takeover permits continuation", async () => {
    const agent = await createAgent("BrowserDecisions");
    const threadId = current.store.list().find((row) => row.id === agent.id)?.threadId;
    assert.ok(threadId);
    browserTabs.push({
      id: "plan-check-tab",
      title: "Account",
      url: "https://account.example.test",
      loading: false,
      ownerAgentId: agent.id,
      ownerThreadId: threadId,
    });
    try {
      for (const decision of ["cancel", "complete"] as const) {
        const mark = loggedTurns().length;
        const since = current.events.length;
        const step = `Finish browser ${decision}`;
        const id = await send(
          agent.id,
          `Prepare the report. ${plan({ steps: [[step, "pending"]], calls: [{ namespace: "openbot_browser", tool: "request_takeover", arguments: { tabId: "plan-check-tab", reason: "login" } }], answer: "The report outline is ready." }, { steps: [[step, "completed"]], answer: "The report is complete." })}`,
        );
        const pending = await waitFor("the browser takeover", () =>
          current.events
            .slice(since)
            .find((event) => event.type === "browser-takeover-requested" && event.request.agentId === agent.id),
        );
        assert.ok(pending.type === "browser-takeover-requested");
        await runCauseEffect(
          current.service.respondToBrowserTakeover({ requestId: pending.request.requestId, decision }),
        );
        assert.equal(await settled(id), "completed");
        assert.deepEqual(
          turnsSince(mark).map((turn) => turn.note),
          decision === "cancel" ? [false] : [false, true],
        );
      }
      return { cases: 2 };
    } finally {
      browserTabs.length = 0;
    }
  });

  await check("Stop during a continuation ends the chain, and the next message works", async () => {
    const agent = await createAgent("Stopped");
    const mark = loggedTurns().length;
    const since = current.events.length;
    const id = await send(
      agent.id,
      `Migrate it. ${plan(
        {
          steps: [
            ["Copy", "completed"],
            ["Verify", "pending"],
            ["Clean", "pending"],
          ],
        },
        {
          steps: [
            ["Copy", "completed"],
            ["Verify", "completed"],
            ["Clean", "pending"],
          ],
          delayMs: 30_000,
        },
      )}`,
    );
    const continuation = await waitFor("the continuation turn", () => turnsSince(mark).find((turn) => turn.note));
    await runCauseEffect(current.service.interrupt(agent.id, continuation.turnId));
    const status = await settled(id);
    assert.equal(status, "interrupted", "The request ends as stopped.");
    assert.equal(turnsSince(mark).length, 2, "No other continuation turn runs.");
    const next = await send(agent.id, "Thanks.");
    assert.equal(await settled(next), "completed", "The next message completes.");
    assert.equal(turnsSince(mark).at(-1)?.note, false);
    assert.equal(continuationLines(agent.id).length, 1);
    assert.equal(errorsFor(agent.id, since).length, 0, "No error shows.");
    return { status };
  });

  await check("a message that waits in the queue stops the continuation and runs next", async () => {
    const agent = await createAgent("Queued");
    const mark = loggedTurns().length;
    const first = await send(
      agent.id,
      `Sort the files. ${plan({
        steps: [
          ["List", "completed"],
          ["Sort", "pending"],
        ],
        delayMs: 1_500,
      })}`,
    );
    await waitFor("the first turn", () => turnsSince(mark).length === 1);
    const second = await send(agent.id, "Use the date order.");
    assert.equal(await settled(first), "completed");
    assert.equal(await settled(second), "completed");
    const turns = turnsSince(mark);
    assert.deepEqual(
      turns.map((turn) => turn.note),
      [false, false],
      "No continuation turn runs.",
    );
    assert.ok(turns[1]?.text.includes("Use the date order."), "The waiting message runs next.");
    assert.equal(continuationLines(agent.id).length, 0);
    return { turns: turns.length };
  });

  await check("a side thread continues in its own thread only", async () => {
    const agent = await createAgent("Threads");
    const mark = loggedTurns().length;
    const task = await runCauseEffect(
      current.service.startTask({
        agentId: agent.id,
        text: `Check the links. ${plan(
          {
            steps: [
              ["Collect", "completed"],
              ["Check", "pending"],
            ],
          },
          {
            steps: [
              ["Collect", "completed"],
              ["Check", "completed"],
            ],
            answer: "All links work.",
          },
        )}`,
      }),
    );
    await waitFor("the side thread to finish", () =>
      current.service.readTask(agent.id, task.id).messages.some((message) => message.text === "All links work."),
    );
    assert.deepEqual(
      turnsSince(mark).map((turn) => turn.note),
      [false, true],
    );
    assert.equal(continuationLines(agent.id, task.threadId).length, 1, "The side thread shows the line.");
    assert.equal(continuationLines(agent.id).length, 0, "The agent's own chat shows no line.");
    return { taskId: task.id };
  });

  await check("a routine run does not continue", async () => {
    const agent = await createAgent("Routine");
    const routine = current.service.createRoutine(
      {
        agentId: agent.id,
        name: "Daily report",
        instruction: `Write the report. ${plan({
          steps: [
            ["Collect", "completed"],
            ["Write", "pending"],
          ],
          answer: "Collected.",
        })}`,
        active: false,
        timezone: "UTC",
        schedule: { kind: "custom", expression: "0 9 * * *" },
      },
      { recordConversationEvent: false },
    );
    const mark = loggedTurns().length;
    await runCauseEffect(current.service.testRoutine({ agentId: agent.id, routineId: routine.id }));
    await waitFor("the routine turn", () => turnsSince(mark).length >= 1);
    await waitFor("the routine run to end", () =>
      current.service.listQueue(agent.id).deliveries.every((delivery) => ended(delivery.status)),
    );
    assert.equal(turnsSince(mark).length, 1, "No continuation turn runs.");
    assert.equal(continuationLines(agent.id).length, 0);
    return { turns: 1 };
  });

  await check("a restart while a continuation waits completes the request with no new turn", async () => {
    const agent = await createAgent("Restart");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `Index it. ${plan(
        {
          steps: [
            ["Scan", "completed"],
            ["Index", "pending"],
          ],
          delayMs: 1_500,
        },
        {
          steps: [
            ["Scan", "completed"],
            ["Index", "completed"],
          ],
        },
      )}`,
    );
    await waitFor("the first turn", () => turnsSince(mark).length === 1);
    // A hidden agent finishes its turn, and its queue waits: the continuation waits too.
    await runCauseEffect(current.service.setAgentHidden({ agentId: agent.id, hidden: true }));
    await waitFor("the continuation to wait", () => continuationLines(agent.id).length === 1);
    assert.equal(
      current.mailbox.getDelivery(id)?.planContinuation?.queued,
      true,
      "The request waits for its continuation.",
    );
    await runCauseEffect(current.service.stop());
    current.database.close();
    current = openService();
    await runCauseEffect(current.service.initialize());
    const since = current.events.length;
    await runCauseEffect(current.service.setAgentHidden({ agentId: agent.id, hidden: false }));
    assert.equal(await settled(id), "completed", "The request completes.");
    assert.equal(turnsSince(mark).length, 1, "No continuation turn runs after the restart.");
    assert.equal(
      current.service.listQueue(agent.id).deliveries.filter((delivery) => !ended(delivery.status)).length,
      0,
      "Nothing waits in the queue.",
    );
    assert.equal(errorsFor(agent.id, since).length, 0, "No error shows.");
    return { turns: 1 };
  });

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(current.service.stop()).catch(() => {});
  report.checkedAt = new Date().toISOString();
  current.database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const entry of report.checks) process.stdout.write(`PASS ${entry.name}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}

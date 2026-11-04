// Exercises the real AgentService's stale MCP fingerprint path on disposable main, side and branch
// histories. The released manifest is SHA-256 text plus a JSON approval list. Its first line is made
// stale after shutdown; production adapter 10 -> 11 changes that same fingerprint automatically.
// A fake Codex 0.166 app-server records config and handoff requests. No account or model is used.
// Writes .openbot-build/codex-mcp-session-recovery-e2e/report.json.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AGENT_PROVIDERS, type ConversationMessage, type McpServerConfig } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const out = resolve(import.meta.dirname, "../.openbot-build/codex-mcp-session-recovery-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-mcp-recovery-"));
const userData = join(root, "profile");
const workspace = join(root, "workspace");
const executable = join(root, "codex");
const protocolLog = join(root, "codex.jsonl");
const previousExecutable = process.env.OPENBOT_CODEX_PATH;
process.env.OPENBOT_CODEX_PATH = executable;

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

const fakeCodex = `#!/usr/bin/env node
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.166.0\\n'); process.exit(0); }
const log = value => fs.appendFileSync(${JSON.stringify(protocolLog)}, JSON.stringify(value)+'\\n');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line), params=request.params || {};
 if(request.id===undefined)return;
 log({method:request.method, threadId:params.threadId, params});
 let result={};
 switch(request.method){
 case 'account/read': result={account:{type:'chatgpt',email:'fixture@example.test'}};break;
 case 'account/rateLimits/read': result={rateLimits:{limitId:'codex',primary:null,secondary:null},rateLimitsByLimitId:null};break;
 case 'model/list': result={data:[{model:'gpt-6.1-sol',displayName:'Fixture model'}]};break;
 case 'plugin/list': result={marketplaces:[]};break;
 case 'config/read': result={config:{mcp_servers:{}},layers:[{name:{type:'user',file:${JSON.stringify(join(root, "config.toml"))},profile:null},version:'1',config:{mcp_servers:{}}}]};break;
 case 'thread/start': {
  const id='fixture-'+randomUUID(); result={thread:{id,turns:[]}};
  log({method:'fixture-started',threadId:id,params});break;
 }
 case 'thread/resume':case 'thread/read': result={thread:{id:params.threadId,turns:[]}};break;
 case 'thread/turns/list':case 'thread/items/list': result={data:[],nextCursor:null};break;
 case 'thread/unsubscribe':result={status:'Unsubscribed'};break;
 case 'turn/start': {
  const id='turn-'+randomUUID();send({id:request.id,result:{turn:{id,status:'inProgress',items:[]}}});
  send({method:'turn/started',params:{threadId:params.threadId,turn:{id}}});
  send({method:'item/completed',params:{threadId:params.threadId,turnId:id,item:{id:'answer-'+id,type:'agentMessage',text:'Fixture answer '+id,phase:'final_answer'}}});
  send({method:'turn/completed',params:{threadId:params.threadId,turn:{id,status:'completed'}}});return;
 }
 }
 send({id:request.id,result});
});
`;
await writeFile(executable, fakeCodex, { mode: 0o755 });

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

function openService() {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, workspace, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, database);
  const service = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
    timezone: () => "UTC",
  });
  return { database, store, mailbox, service };
}
let current = openService();
async function closeService() {
  await runCauseEffect(current.service.stop());
  current.database.close();
}
async function waitFor<T>(label: string, read: () => T | null | undefined | false): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
    await delay(25);
  }
}
interface ProtocolEntry {
  method: string;
  threadId?: string;
  params?: DynamicRecord;
}
function entries(): ProtocolEntry[] {
  try {
    return readFileSync(protocolLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line): ProtocolEntry => JSON.parse(line));
  } catch {
    return [];
  }
}
async function send(agentId: string, text: string, taskId?: string) {
  const receipt = await runCauseEffect(
    current.service.sendMessage({ agentId, text, attachmentDraftIds: [], ...(taskId ? { taskId } : {}) }),
  );
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId);
  const delivery = await waitFor(text, () => {
    const saved = current.mailbox.getDelivery(deliveryId)?.delivery;
    return saved && ["completed", "failed", "interrupted", "cancelled"].includes(saved.status) ? saved : null;
  });
  assert.equal(delivery.status, "completed", delivery.error ?? text);
}
async function idleTask(agentId: string, taskId: string) {
  await waitFor("task completes", () => {
    const task = current.service.listTasks(agentId).tasks.find((candidate) => candidate.id === taskId);
    return task?.state === "idle" && task.outcome === "completed";
  });
}
const messages = (agentId: string, threadId: string) => current.database.readConversation(agentId, threadId).messages;
const manifest = (sessionId: string) =>
  join(userData, "provider-toolsets", createHash("sha256").update(sessionId).digest("hex"));
const activeSession = (threadId: string) => {
  const session = current.database.activeProviderSession(threadId, "codex");
  assert.ok(session, "The public thread has an active Codex session.");
  return session.externalSessionId;
};
function retained(before: ConversationMessage[], after: ConversationMessage[]) {
  for (const original of before) {
    const saved = after.find((message) => message.id === original.id);
    assert.ok(saved, "Every saved message id is retained.");
    assert.equal(saved.text, original.text, "Saved message text is retained.");
    assert.equal(saved.author, original.author);
  }
}
interface Lane {
  name: string;
  threadId: string;
  taskId?: string;
  initialSession: string;
  initialMessages: ConversationMessage[];
  replacedSession?: string;
}
const report: {
  passed: boolean;
  serverCount: number;
  lanes: DynamicRecord[];
  releasedManifestShapeVerified: boolean;
  publicIdsRetained: boolean;
  stableSecondRestart: boolean;
  error?: string;
} = {
  passed: false,
  serverCount: 40,
  lanes: [],
  releasedManifestShapeVerified: false,
  publicIdsRetained: false,
  stableSecondRestart: false,
};
let closed = false;
try {
  await runCauseEffect(current.service.initialize());
  for (let index = 0; index < report.serverCount; index += 1) {
    const config: McpServerConfig = {
      id: "",
      name: `fixture_${String(index).padStart(3, "0")}`,
      transport: "http",
      enabled: true,
      command: "",
      args: [],
      env: [],
      envPassthrough: [],
      workingDirectory: "",
      url: `http://127.0.0.1:9/mcp/${index}`,
      headers: [],
    };
    await runCauseEffect(current.service.saveMcpServer({ config }));
  }
  const agent = await runCauseEffect(
    current.service.createAgent({
      name: "MCP recovery fixture",
      description: "",
      initialMessage: "Start the isolated recovery fixture.",
      avatarSeed: "mcp-recovery",
      avatarHue: null,
      provider: "codex",
      model: "gpt-6.1-sol",
    }),
  );
  await send(agent.id, "Keep this main-history fixture fact.");
  const mainThreadId = current.store.list().find((saved) => saved.id === agent.id)?.threadId;
  assert.ok(mainThreadId);
  const side = await runCauseEffect(
    current.service.startTask({ agentId: agent.id, text: "Keep this side-history fixture fact." }),
  );
  await idleTask(agent.id, side.id);
  const branchPoint = messages(agent.id, side.threadId).findLast(
    (message) => message.author === "assistant" && message.turnId && message.status === "completed",
  );
  assert.ok(branchPoint);
  const branch = await runCauseEffect(
    current.service.branchTask(
      { agentId: agent.id, taskId: side.id, messageId: branchPoint.id, requestId: randomUUID() },
      "local",
    ),
  );
  await send(agent.id, "Keep this branch-only fixture fact.", branch.id);
  await idleTask(agent.id, branch.id);
  const lanes: Lane[] = [
    {
      name: "main",
      threadId: mainThreadId,
      initialSession: activeSession(mainThreadId),
      initialMessages: messages(agent.id, mainThreadId),
    },
    {
      name: "side",
      threadId: side.threadId,
      taskId: side.id,
      initialSession: activeSession(side.threadId),
      initialMessages: messages(agent.id, side.threadId),
    },
    {
      name: "branch",
      threadId: branch.threadId,
      taskId: branch.id,
      initialSession: activeSession(branch.threadId),
      initialMessages: messages(agent.id, branch.threadId),
    },
  ];
  const tasksBefore = current.service
    .listTasks(agent.id)
    .tasks.map((task) => ({ id: task.id, threadId: task.threadId }));
  await closeService();
  closed = true;
  for (const lane of lanes) {
    const path = manifest(lane.initialSession);
    const text = await readFile(path, "utf8");
    const newline = text.indexOf("\n");
    assert.match(text.slice(0, newline), /^[a-f0-9]{64}$/u);
    assert.ok(Array.isArray(JSON.parse(text.slice(newline + 1))), "The released approval-list shape is present.");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const stale = createHash("sha256").update(`released-adapter-10-fixture:${lane.initialSession}`).digest("hex");
    await writeFile(path, stale + text.slice(newline), { mode: 0o600 });
  }
  report.releasedManifestShapeVerified = true;
  const beforeRecovery = entries().length;
  current = openService();
  closed = false;
  await runCauseEffect(current.service.initialize());
  for (const lane of lanes) {
    retained(lane.initialMessages, messages(agent.id, lane.threadId));
    await send(agent.id, `Recover the ${lane.name} fixture with its saved facts.`, lane.taskId);
    lane.replacedSession = activeSession(lane.threadId);
    assert.notEqual(lane.replacedSession, lane.initialSession, "A stale provider session is replaced.");
    const history = current.database.listProviderSessions(lane.threadId);
    assert.equal(history.length, 2, "Only one replacement session is created.");
    assert.equal(history.filter((session) => session.state === "active").length, 1);
    retained(lane.initialMessages, messages(agent.id, lane.threadId));
    const start = entries()
      .slice(beforeRecovery)
      .find((entry) => entry.method === "fixture-started" && entry.threadId === lane.replacedSession);
    assert.ok(start?.params && isDynamicRecord(start.params.config));
    const config = start.params.config;
    assert.equal(config["features.code_mode_tool_search"], true);
    assert.ok(isDynamicRecord(config.mcp_servers));
    assert.equal(
      Object.values(config.mcp_servers).filter((server) => isDynamicRecord(server) && server.enabled === true).length,
      report.serverCount,
    );
    assert.ok(Array.isArray(config["features.code_mode.direct_only_tool_namespaces"]));
    assert.ok(
      !config["features.code_mode.direct_only_tool_namespaces"].some(
        (namespace) => typeof namespace === "string" && namespace.startsWith("mcp__fixture_"),
      ),
      "External MCP schemas are not forced direct.",
    );
    const turn = entries()
      .slice(beforeRecovery)
      .find((entry) => entry.method === "turn/start" && entry.threadId === lane.replacedSession);
    assert.ok(turn?.params);
    const handoff = JSON.stringify(turn.params);
    for (const message of lane.initialMessages.filter(
      (message) => message.author === "user" || message.author === "assistant",
    ))
      assert.ok(handoff.includes(message.text), "The replacement provider receives its saved conversation facts.");
    report.lanes.push({
      name: lane.name,
      replacedOnce: true,
      historyRetained: true,
      handoffRetained: true,
      nativeSearchEnabled: true,
      allServersEnabled: true,
      externalSchemasDeferred: true,
    });
  }
  assert.equal(current.store.list().find((saved) => saved.id === agent.id)?.threadId, mainThreadId);
  assert.deepEqual(
    current.service.listTasks(agent.id).tasks.map((task) => ({ id: task.id, threadId: task.threadId })),
    tasksBefore,
  );
  report.publicIdsRetained = true;
  await closeService();
  closed = true;
  const beforeStableResume = entries().length;
  current = openService();
  closed = false;
  await runCauseEffect(current.service.initialize());
  for (const lane of lanes) {
    await send(agent.id, `Resume the unchanged ${lane.name} fixture.`, lane.taskId);
    assert.equal(activeSession(lane.threadId), lane.replacedSession, "The later restart resumes the current session.");
    assert.equal(current.database.listProviderSessions(lane.threadId).length, 2);
    retained(lane.initialMessages, messages(agent.id, lane.threadId));
    assert.ok(
      entries()
        .slice(beforeStableResume)
        .some((entry) => entry.method === "thread/resume" && entry.threadId === lane.replacedSession),
    );
  }
  assert.equal(
    entries()
      .slice(beforeStableResume)
      .filter((entry) => entry.method === "thread/start").length,
    0,
  );
  report.stableSecondRestart = true;
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  if (!closed) await closeService().catch(() => undefined);
  if (previousExecutable === undefined) delete process.env.OPENBOT_CODEX_PATH;
  else process.env.OPENBOT_CODEX_PATH = previousExecutable;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
// Machine-readable: the report contains fixture assertions only, no prompts or provider credentials.
process.stdout.write(`${JSON.stringify(report)}\n`);

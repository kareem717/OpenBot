// Runs the real AgentService, mailbox, provider transport, and attention registry in a private profile.
// A stand-in Codex holds a browser tool result while accepting steering input, as the native protocol
// does. A successful user steer must release only its own handoff as cancelled; it must not accept a
// browser action, cancel another lane, discard an in-flight secret, or stop the user's new plan.
// bun scripts/browser-takeover-steer-e2e.ts
// Writes .openbot-build/browser-takeover-steer-e2e/report.json. No real account or browser page is used.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type BrowserTab } from "@openbot/contracts/ipc";
import { Deferred, Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/browser-takeover-steer-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-browser-steer-"));
const home = join(root, "home");
const userData = join(root, "data");
const executable = join(root, "codex");
const logPath = join(root, "protocol.jsonl");
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = executable;
mkdirSync(home, { recursive: true });
const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { runCauseEffect } = await import("../src/backend/effect-boundary");

const fake = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("codex-cli 0.166.0"); process.exit(0); }
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const log = (entry) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(entry) + "\n");
const config = {config:{mcp_servers:{}},layers:[{name:{type:"user",file:"/fake/.codex/config.toml",profile:null},version:"1",config:{mcp_servers:{}}}]};
const held = new Map();
let threads=0, turns=0, buffer="";
const finish = (turn) => {
  const plan = turn.options.plan && turn.steered ? [{step:"Finish the user's new request",status:"pending"}] : [{step:"Finish the request",status:"completed"}];
  write({method:"turn/plan/updated",params:{threadId:turn.threadId,turnId:turn.id,plan}});
  write({method:"item/completed",params:{threadId:turn.threadId,turnId:turn.id,item:{type:"agentMessage",id:"message-"+turn.id,text:turn.steered?"The revised work is started.":"The work is complete.",phase:"final_answer"}}});
  write({method:"turn/completed",params:{threadId:turn.threadId,turn:{id:turn.id,status:"completed"}}});
};
const answer = (message) => {
  const p=message.params||{};
  switch(message.method) {
    case "initialize": case "config/batchWrite": case "thread/unsubscribe": return write({id:message.id,result:{}});
    case "account/read": return write({id:message.id,result:{account:{type:"chatgpt",email:"fixture@example.test"}}});
    case "account/rateLimits/read": return write({id:message.id,result:{rateLimits:{limitId:"codex",primary:null,secondary:null},rateLimitsByLimitId:null}});
    case "model/list": return write({id:message.id,result:{data:[{model:"gpt-6-luna",displayName:"Fixture model"}]}});
    case "plugin/list": return write({id:message.id,result:{marketplaces:[]}});
    case "config/read": return write({id:message.id,result:config});
    case "thread/start": return write({id:message.id,result:{thread:{id:"thread-"+process.pid+"-"+(++threads),turns:[]}}});
    case "thread/resume": case "thread/read": return write({id:message.id,result:{thread:{id:p.threadId,turns:[]}}});
    case "thread/turns/list": case "thread/items/list": return write({id:message.id,result:{data:[],nextCursor:null}});
    case "turn/start": {
      const text=(p.input||[]).map(x=>x.text||"").join("\n");
      const match=/<<HANDOFF([\s\S]*?)HANDOFF>>/.exec(text.split("--- current message ---").at(-1));
      const continuation=text.includes("OpenBot note, not a message from the user");
      const options=match&&!continuation?JSON.parse(match[1]):{};
      const turn={id:"turn-"+process.pid+"-"+(++turns),threadId:p.threadId,options};
      log({event:"turn",threadId:p.threadId,turnId:turn.id,continuation});
      write({id:message.id,result:{turn:{id:turn.id,status:"inProgress",items:[]}}});
      write({method:"turn/started",params:{threadId:p.threadId,turn:{id:turn.id}}});
      if (!options.tab) return finish(turn);
      const id="tool-"+turn.id;
      held.set(id,turn);
      write({id,method:"item/tool/call",params:{threadId:p.threadId,turnId:turn.id,callId:id,namespace:"openbot_browser",tool:options.secret?"submit_secret":"request_takeover",arguments:{tabId:options.tab,reason:"login",method:"password",targets:[{kind:"css",selector:"#password"}],submission:"click",submitTarget:{kind:"css",selector:"#submit"}}}});
      return;
    }
    case "turn/steer": {
      const turn=[...held.values()].find(x=>x.id===p.expectedTurnId&&x.threadId===p.threadId);
      if (!turn||turn.options.reject) return write({id:message.id,error:{code:-32000,message:"The fixture refused this steer."}});
      log({event:"steer",threadId:p.threadId,turnId:turn.id});
      if (turn.options.timeout) return;
      turn.steered=true;
      return write({id:message.id,result:{turnId:turn.id}});
    }
    case "turn/interrupt": {
      for(const [id,turn] of held) if(turn.id===p.turnId) held.delete(id);
      write({id:message.id,result:{}});
      return write({method:"turn/completed",params:{threadId:p.threadId,turn:{id:p.turnId,status:"interrupted"}}});
    }
    default: return write({id:message.id,error:{code:-32601,message:"Unknown method: "+message.method}});
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{
  buffer+=chunk;
  for(let end; (end=buffer.indexOf("\n"))>=0;) {
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
    if(!line) continue;
    const message=JSON.parse(line);
    if(message.method&&message.id!==undefined) answer(message);
    else if(!message.method&&held.has(message.id)) {
      const turn=held.get(message.id);held.delete(message.id);
      const payload=JSON.parse(message.result.contentItems[0].text);
      log({event:"tool-result",threadId:turn.threadId,turnId:turn.id,status:payload.status});
      finish(turn);
    }
  }
});
`;
await writeFile(executable, fake, { mode: 0o755 });
const tabs: BrowserTab[] = [];
const endedTabs: string[] = [];
const secretCompletion = Deferred.makeUnsafe<"submitted">();
let secretSubmitting = false;
let secretCancelled = 0;
const unused = () => Effect.die(new Error("The fixture must not act on a browser page."));
const browser: AgentBrowserHost = {
  listTabs: () => tabs,
  beginTakeover: () => Effect.void,
  endTakeover: (tabId) => endedTabs.push(tabId),
  prepareSecret: () =>
    Effect.succeed({
      request: { method: "password", origin: "https://fixture.example.test", digits: 6 },
      agentScriptedOrigin: false,
      vaultFillable: false,
      submit: () =>
        Effect.sync(() => {
          secretSubmitting = true;
        }).pipe(Effect.andThen(Deferred.await(secretCompletion))),
      cancel: () => {
        secretCancelled += 1;
      },
    }),
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
};
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, database);
let busyMode: "queue" | "steer" = "steer";
const service = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  requestTimeoutMs: 1500,
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  busyMessageMode: () => busyMode,
});
const report: { passed: boolean; checks: string[]; error?: string } = { passed: false, checks: [] };
async function waitFor<T>(label: string, read: () => T | null | undefined | false): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 20));
  }
}
const ended = (status?: string) => status && ["completed", "failed", "interrupted", "cancelled"].includes(status);
const pending = () => service.getRuntimeSnapshot().pendingBrowserTakeovers;
const entries = (): Array<{
  event: string;
  threadId: string;
  turnId: string;
  status?: string;
  continuation?: boolean;
}> => {
  try {
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
async function settled(id: string) {
  const delivery = await waitFor("the message to finish", () => {
    const value = mailbox.getDelivery(id)?.delivery;
    return value && ended(value.status) ? value : null;
  });
  assert.equal(delivery.status, "completed", delivery.error ?? "The delivery must complete.");
}
async function send(agentId: string, text: string, taskId?: string) {
  const receipt = await runCauseEffect(
    service.sendMessage({ agentId, text, attachmentDraftIds: [], ...(taskId ? { taskId } : {}) }),
  );
  const id = receipt.deliveries[0]?.id;
  assert.ok(id);
  return id;
}
async function agent(name: string) {
  const created = await runCauseEffect(
    service.createAgent({
      name,
      description: "Isolated steering check",
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Start the fixture.",
    }),
  );
  await waitFor("the agent to be idle", () =>
    service.listQueue(created.id).deliveries.every((delivery) => ended(delivery.status)),
  );
  return created;
}
async function hold(
  agentId: string,
  threadId: string,
  taskId?: string,
  options: { plan?: boolean; reject?: boolean; timeout?: boolean; secret?: boolean } = {},
) {
  const tab = `tab-${tabs.length}`;
  tabs.push({
    id: tab,
    title: "Fixture",
    url: "https://fixture.example.test",
    loading: false,
    ownerAgentId: agentId,
    ownerThreadId: threadId,
  });
  const id = await send(
    agentId,
    `Wait at this inspected login. <<HANDOFF${JSON.stringify({ tab, ...options })}HANDOFF>>`,
    taskId,
  );
  const request = await waitFor("the browser handoff", () => pending().find((value) => value.tabId === tab));
  return { id, request, tab };
}
async function cancel(requestId: string | number) {
  await runCauseEffect(service.respondToBrowserTakeover({ requestId, decision: "cancel" }));
}
const pass = (name: string) => {
  report.checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
};
try {
  await runCauseEffect(service.initialize());
  const main = await agent("Steering");
  const mainThread = store.list().find((value) => value.id === main.id)?.threadId;
  assert.ok(mainThread);
  const first = await hold(main.id, mainThread, undefined, { plan: true });
  const before = entries().length;
  const revised = await send(main.id, "Also inspect the missing routines and continue with the revised work.");
  await settled(first.id);
  await settled(revised);
  assert.ok(!pending().some((value) => value.requestId === first.request.requestId));
  assert.equal(
    entries().find((value) => value.event === "tool-result" && value.turnId === first.request.turnId)?.status,
    "cancelled",
  );
  assert.ok(
    entries()
      .slice(before)
      .some((value) => value.event === "turn" && value.continuation),
    "The accepted user's plan may continue.",
  );
  assert.equal(endedTabs.filter((value) => value === first.tab).length, 1);
  pass("An automatic person steer releases its main-chat handoff as cancelled and permits revised plan work");

  const side = await runCauseEffect(service.startTask({ agentId: main.id, text: "Start a side-thread fixture." }));
  await waitFor(
    "the side thread to be idle",
    () => service.listTasks(main.id).tasks.find((value) => value.id === side.id)?.state === "idle",
  );
  const other = await agent("Other");
  const otherThread = store.list().find((value) => value.id === other.id)?.threadId;
  assert.ok(otherThread);
  const ownHold = await hold(main.id, mainThread);
  const sideHold = await hold(main.id, side.threadId, side.id);
  const otherHold = await hold(other.id, otherThread);
  busyMode = "queue";
  const sideRevised = await send(main.id, "Revise only this side thread.", side.id);
  await runCauseEffect(
    service.steerQueuedMessage({ agentId: main.id, deliveryId: sideRevised, expectedTurnId: sideHold.request.turnId }),
  );
  await settled(sideHold.id);
  await settled(sideRevised);
  assert.deepEqual(
    pending()
      .map((value) => value.requestId)
      .sort(),
    [ownHold.request.requestId, otherHold.request.requestId].sort(),
  );
  assert.ok(!endedTabs.includes(ownHold.tab) && !endedTabs.includes(otherHold.tab));
  pass("An explicit side-thread steer releases only its own handoff and preserves the other lane and agent");

  const receipt = await runCauseEffect(
    mailbox.enqueue({
      sender: { kind: "agent", agentId: other.id },
      recipientAgentIds: [main.id],
      text: "Another agent's update.",
    }),
  );
  const agentMessage = receipt.deliveries[0]?.id;
  assert.ok(agentMessage);
  await runCauseEffect(
    service.steerQueuedMessage({ agentId: main.id, deliveryId: agentMessage, expectedTurnId: ownHold.request.turnId }),
  );
  assert.ok(pending().some((value) => value.requestId === ownHold.request.requestId));
  pass("An accepted message from another agent leaves the person's browser handoff open");
  const externalDeliveries: string[] = [];
  const messaging = {
    linkId: "fixture-slack",
    authorId: "external-user",
    authorName: "External fixture",
    platformMessageId: "fixture-message",
  };
  for (const origin of [{ messaging }, { messagingReturn: messaging }, { channelId: "fixture-channel" }]) {
    const external = await runCauseEffect(
      mailbox.enqueue({
        sender: { kind: "user" },
        recipientAgentIds: [main.id],
        text: "External user-shaped input.",
        ...origin,
      }),
    );
    const id = external.deliveries[0]?.id;
    assert.ok(id);
    externalDeliveries.push(id);
    await runCauseEffect(
      service.steerQueuedMessage({ agentId: main.id, deliveryId: id, expectedTurnId: ownHold.request.turnId }),
    );
    assert.ok(pending().some((value) => value.requestId === ownHold.request.requestId));
  }
  pass("External messaging, messaging-return, and channel origins cannot release an owner handoff");
  await cancel(ownHold.request.requestId);
  await settled(ownHold.id);
  await settled(agentMessage);
  for (const id of externalDeliveries) await settled(id);
  await cancel(otherHold.request.requestId);
  await settled(otherHold.id);

  for (const mode of ["reject", "timeout"] as const) {
    const held = await hold(main.id, mainThread, undefined, { [mode]: true });
    const queued = await send(main.id, `This ${mode} steer must leave the handoff open.`);
    await assert.rejects(
      runCauseEffect(
        service.steerQueuedMessage({ agentId: main.id, deliveryId: queued, expectedTurnId: held.request.turnId }),
      ),
    );
    assert.ok(pending().some((value) => value.requestId === held.request.requestId));
    assert.equal(mailbox.getDelivery(queued)?.delivery.status, "queued");
    assert.ok(!endedTabs.includes(held.tab));
    await cancel(held.request.requestId);
    await settled(held.id);
    await settled(queued);
    pass(`A ${mode === "reject" ? "rejected" : "timed-out uncertain"} steer preserves the handoff and queued message`);
  }

  busyMode = "steer";
  const protectedHold = await hold(main.id, mainThread, undefined, { secret: true });
  const submitting = runCauseEffect(
    service.respondToBrowserSecret({
      agentId: main.id,
      requestId: protectedHold.request.requestId,
      decision: "submit",
      secret: "fixture-only-value",
    }),
  );
  await waitFor("the secure submission to start", () => secretSubmitting);
  const protectedSteer = await send(main.id, "Use this revised instruction after the current secure submission.");
  await waitFor(
    "the protected steer to be accepted",
    () => mailbox.getDelivery(protectedSteer)?.delivery.status === "running",
  );
  assert.ok(pending().some((value) => value.requestId === protectedHold.request.requestId));
  assert.equal(secretCancelled, 0);
  assert.ok(!endedTabs.includes(protectedHold.tab));
  Deferred.doneUnsafe(secretCompletion, Effect.succeed("submitted"));
  await submitting;
  await settled(protectedHold.id);
  await settled(protectedSteer);
  assert.equal(
    entries().find((value) => value.event === "tool-result" && value.turnId === protectedHold.request.turnId)?.status,
    "completed",
  );
  pass("Steering cannot cancel an in-flight secret submission or report it as an uncompleted login");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : "The steering regression failed.";
  process.exitCode = 1;
} finally {
  Deferred.doneUnsafe(secretCompletion, Effect.succeed("submitted"));
  await runCauseEffect(service.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
if (report.error) process.stdout.write(`${report.error}\n`);

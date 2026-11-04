// Runs the real service and SQLite mailbox in a private profile. A local Codex stand-in holds a
// question while it accepts steering. Accepted inputs must stay in main, side and branched history
// through later plan/text events, Stop and restart. Older missing inputs are repaired without replay.
// Writes .openbot-build/steer-history-e2e/report.json. No account or external service is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AGENT_PROVIDERS, type ConversationMessage } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const out = resolve(import.meta.dirname, "../.openbot-build/steer-history-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-steer-history-"));
const userData = join(root, "profile");
const workspace = join(root, "workspace");
const executable = join(root, "codex");
const protocolLog = join(root, "protocol.jsonl");
const ackRoot = join(root, "acks");
await mkdir(ackRoot);
const previousExecutable = process.env.OPENBOT_CODEX_PATH;
process.env.OPENBOT_CODEX_PATH = executable;
const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { runCauseEffect } = await import("../src/backend/effect-boundary");

await writeFile(
  executable,
  String.raw`#!/usr/bin/env node
const fs=require('node:fs'), {randomUUID}=require('node:crypto');
if(process.argv.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0);}
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const log=x=>fs.appendFileSync(${JSON.stringify(protocolLog)},JSON.stringify(x)+'\n');
const held=new Map();
const finish=(turn,status='completed')=>{
 send({method:'turn/plan/updated',params:{threadId:turn.threadId,turnId:turn.id,plan:[{step:'Finish the revised request',status:'completed'}]}});
 send({method:'item/completed',params:{threadId:turn.threadId,turnId:turn.id,item:{id:'answer-'+turn.id,type:'agentMessage',text:'The revised request is complete.',phase:'final_answer'}}});
 send({method:'turn/completed',params:{threadId:turn.threadId,turn:{id:turn.id,status}}});
};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),p=r.params||{};
 if(!r.method){const turn=held.get(r.id);if(turn){held.delete(r.id);finish(turn);}return;}
 if(r.id===undefined)return;
 let result={};
 switch(r.method){
 case 'account/read':result={account:{type:'chatgpt',email:'fixture@example.test'}};break;
 case 'account/rateLimits/read':result={rateLimits:{limitId:'codex',primary:null,secondary:null},rateLimitsByLimitId:null};break;
 case 'model/list':result={data:[{model:'gpt-6.1-sol',displayName:'Fixture model'}]};break;
 case 'plugin/list':result={marketplaces:[]};break;
 case 'config/read':result={config:{mcp_servers:{}},layers:[{name:{type:'user',file:'/fake/config.toml',profile:null},version:'1',config:{mcp_servers:{}}}]};break;
 case 'thread/start':result={thread:{id:'fixture-'+randomUUID(),turns:[]}};break;
 case 'thread/resume':case 'thread/read':result={thread:{id:p.threadId,turns:[]}};break;
 case 'thread/turns/list':case 'thread/items/list':result={data:[],nextCursor:null};break;
 case 'thread/unsubscribe':result={status:'Unsubscribed'};break;
 case 'turn/start':{
  const turn={id:'turn-'+randomUUID(),threadId:p.threadId};
  const text=(p.input||[]).map(x=>x.text||'').join('\n').split('--- current message ---').at(-1);
  log({method:r.method,threadId:p.threadId,turnId:turn.id});
  send({id:r.id,result:{turn:{id:turn.id,status:'inProgress',items:[]}}});
  send({method:'turn/started',params:{threadId:p.threadId,turn:{id:turn.id}}});
  if(!text.includes('<<HOLD>>'))return finish(turn);
  const callId='question-'+turn.id;held.set(callId,turn);
  send({id:callId,method:'item/tool/call',params:{threadId:p.threadId,turnId:turn.id,callId,namespace:'openbot',tool:'ask_user',arguments:{questions:[{id:'code',header:'Code',question:'Enter the fixture verification code.',isSecret:true}]}}});return;
 }
 case 'turn/steer':{
  const turn=[...held.values()].find(x=>x.id===p.expectedTurnId&&x.threadId===p.threadId);
  if(!turn||(p.input||[]).some(x=>x.text?.includes('<<REJECT>>')))return send({id:r.id,error:{code:-32000,message:'Fixture steer refused.'}});
  log({method:r.method,threadId:p.threadId,turnId:turn.id,messageId:p.clientUserMessageId});
  if((p.input||[]).some(x=>x.text?.includes('<<TIMEOUT>>')))return;
  if((p.input||[]).some(x=>x.text?.includes('<<DELAY>>'))){
   const path=${JSON.stringify(ackRoot)}+'/'+p.clientUserMessageId;
   log({method:'fixture-await-ack',messageId:p.clientUserMessageId});
   fs.watchFile(path,{interval:20},stat=>{if(!stat.size)return;fs.unwatchFile(path);send({id:r.id,result:{turnId:turn.id}});});return;
  }
  send({id:r.id,result:{turnId:turn.id}});
  send({method:'turn/plan/updated',params:{threadId:turn.threadId,turnId:turn.id,plan:[{step:'Finish the revised request',status:'in_progress'}]}});
  send({method:'item/agentMessage/delta',params:{threadId:turn.threadId,turnId:turn.id,itemId:'progress-'+turn.id,delta:'The revised work has started.'}});return;
 }
 case 'turn/interrupt':{
  const entry=[...held.entries()].find(([,x])=>x.id===p.turnId&&x.threadId===p.threadId);
  send({id:r.id,result:{}});if(entry){held.delete(entry[0]);finish(entry[1],'interrupted');}return;
 }
 }
 send({id:r.id,result});
});
`,
  { mode: 0o755 },
);
const unused = () => Effect.die(new Error("The fixture does not use a browser."));
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
    busyMessageMode: () => "queue",
    requestTimeoutMs: 500,
  });
  return { database, store, mailbox, service };
}
let current = openService();
let closed = false;
const report: { passed: boolean; checks: string[]; error?: string } = { passed: false, checks: [] };
const pass = (name: string) => {
  report.checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
};
async function waitFor<T>(label: string, read: () => T | undefined | null | false): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}
const terminal = (status: string) => ["completed", "failed", "interrupted", "cancelled"].includes(status);
async function settled(id: string, expected = "completed") {
  const row = await waitFor("delivery end", () => {
    const row = current.mailbox.getDelivery(id)?.delivery;
    return row && terminal(row.status) ? row : null;
  });
  assert.equal(row.status, expected, row.error ?? id);
}
async function send(agentId: string, text: string, taskId?: string, attachmentDraftIds: string[] = []) {
  const result = await runCauseEffect(
    current.service.sendMessage({ agentId, text, attachmentDraftIds, ...(taskId ? { taskId } : {}) }),
  );
  const id = result.deliveries[0]?.id;
  assert.ok(id);
  return id;
}
async function idleTask(agentId: string, taskId: string) {
  await waitFor(
    "task idle",
    () => current.service.listTasks(agentId).tasks.find((row) => row.id === taskId)?.state === "idle",
  );
}
const stored = (agentId: string, threadId: string) => current.database.readConversation(agentId, threadId).messages;
function countStarts() {
  return readFileSync(protocolLog, "utf8")
    .split("\n")
    .filter((line) => line.includes('"method":"turn/start"')).length;
}
interface Lane {
  name: string;
  threadId: string;
  taskId?: string;
  steerId?: string;
  saved?: ConversationMessage;
  preserved?: ConversationMessage[];
}
function input(agentId: string, lane: Lane, id: string, text: string) {
  const rows = stored(agentId, lane.threadId).filter((message) => message.id === id);
  assert.equal(rows.length, 1, `${lane.name}: exactly one durable input`);
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.text, text);
  assert.equal(row.author, "user");
  assert.ok(row.turnId);
  assert.notEqual(row.delivery?.status, "queued");
  return row;
}
try {
  await runCauseEffect(current.service.initialize());
  const agent = await runCauseEffect(
    current.service.createAgent({
      name: "Steer history fixture",
      description: "",
      initialMessage: "Start the isolated fixture.",
      avatarSeed: "history",
      avatarHue: null,
      provider: "codex",
      model: "gpt-6.1-sol",
    }),
  );
  const seed = await send(agent.id, "Retain this main input.");
  await settled(seed);
  const mainThreadId = current.store.list().find((row) => row.id === agent.id)?.threadId;
  assert.ok(mainThreadId);
  const side = await runCauseEffect(current.service.startTask({ agentId: agent.id, text: "Retain this side input." }));
  await idleTask(agent.id, side.id);
  const point = stored(agent.id, side.threadId).findLast((row) => row.author === "assistant" && row.turnId);
  assert.ok(point);
  const branch = await runCauseEffect(
    current.service.branchTask(
      { agentId: agent.id, taskId: side.id, messageId: point.id, requestId: randomUUID() },
      "local",
    ),
  );
  const lanes: Lane[] = [
    { name: "main", threadId: mainThreadId },
    { name: "side", threadId: side.threadId, taskId: side.id },
    { name: "branch", threadId: branch.threadId, taskId: branch.id },
  ];
  for (const lane of lanes) {
    const heldId = await send(agent.id, `Wait here in ${lane.name}. <<HOLD>>`, lane.taskId);
    const prompt = await waitFor("private question", () =>
      current.service.getRuntimeSnapshot().pendingPrompts.find((row) => row.threadId === lane.threadId),
    );
    if (lane.name === "side") {
      const delayed = await send(agent.id, "Keep this delayed accepted input. <<DELAY>>", lane.taskId);
      const steering = runCauseEffect(
        current.service.steerQueuedMessage({ agentId: agent.id, deliveryId: delayed, expectedTurnId: prompt.turnId }),
      );
      await waitFor("pending native acknowledgement", () =>
        readFileSync(protocolLog, "utf8").includes(`"messageId":"${delayed}"`),
      );
      assert.ok(
        !current.service.readTask(agent.id, side.id).messages.some((row) => row.id === delayed),
        "Pending steering is not accepted history.",
      );
      await writeFile(join(ackRoot, delayed), "ack");
      await steering;
      input(agent.id, lane, delayed, "Keep this delayed accepted input. <<DELAY>>");
      const uncertain = await send(agent.id, "Keep this uncertain request queued. <<TIMEOUT>>", lane.taskId);
      await assert.rejects(
        runCauseEffect(
          current.service.steerQueuedMessage({
            agentId: agent.id,
            deliveryId: uncertain,
            expectedTurnId: prompt.turnId,
          }),
        ),
      );
      assert.equal(current.mailbox.getDelivery(uncertain)?.delivery.status, "queued");
      assert.ok(!current.service.readTask(agent.id, side.id).messages.some((row) => row.id === uncertain));
      await runCauseEffect(current.service.cancelQueuedMessage(agent.id, uncertain));
      pass("Pending and timed-out steers stay outside accepted task history until acknowledgement");
    }
    const drafts = await runCauseEffect(
      current.service.prepareImportedAttachments(
        [],
        [{ name: `${lane.name}.txt`, mimeType: "text/plain", bytes: Buffer.from("Synthetic retained attachment.") }],
      ),
    );
    const text = `Keep the revised ${lane.name} request exactly.`;
    const id = await send(
      agent.id,
      text,
      lane.taskId,
      drafts.map((row) => row.id),
    );
    lane.steerId = id;
    await runCauseEffect(
      current.service.steerQueuedMessage({ agentId: agent.id, deliveryId: id, expectedTurnId: prompt.turnId }),
    );
    const accepted = input(agent.id, lane, id, text);
    assert.equal(accepted.turnId, prompt.turnId);
    assert.equal(accepted.attachments?.length, 1);
    await waitFor("later plan event", () =>
      stored(agent.id, lane.threadId).find((row) => row.plan?.steps.some((step) => step.status === "inProgress")),
    );
    input(agent.id, lane, id, text);
    await runCauseEffect(current.mailbox.setReaction(agent.id, id, { kind: "user" }, "👍"));
    if (lane.taskId) current.service.readTask(agent.id, lane.taskId);
    const rejected = await send(agent.id, "This remains queued. <<REJECT>>", lane.taskId);
    await assert.rejects(
      runCauseEffect(
        current.service.steerQueuedMessage({ agentId: agent.id, deliveryId: rejected, expectedTurnId: prompt.turnId }),
      ),
    );
    assert.equal(current.mailbox.getDelivery(rejected)?.delivery.status, "queued");
    assert.ok(!stored(agent.id, lane.threadId).some((row) => row.id === rejected && row.delivery?.status !== "queued"));
    await runCauseEffect(current.service.cancelQueuedMessage(agent.id, rejected));
    if (lane.taskId)
      assert.ok(!current.service.readTask(agent.id, lane.taskId).messages.some((row) => row.id === rejected));
    await runCauseEffect(
      current.service.respondToPrompt({ requestId: prompt.requestId, answers: { code: ["654321"] } }),
    );
    await settled(heldId);
    await settled(id);
    if (lane.taskId) current.service.readTask(agent.id, lane.taskId);
    lane.saved = input(agent.id, lane, id, text);
    lane.preserved = stored(agent.id, lane.threadId).filter((row) => row.id !== id);
    assert.ok(!JSON.stringify(lane.preserved).includes("654321"), "Private answers remain masked in saved cards.");
    pass(
      `${lane.name}: accepted input survives plan and text events; rejected/cancelled inputs stay out; private answer masked`,
    );
  }
  const stopLane = lanes[1];
  assert.ok(stopLane?.taskId);
  const stopHeld = await send(agent.id, "Wait for the Stop check. <<HOLD>>", stopLane.taskId);
  const stopPrompt = await waitFor("Stop question", () =>
    current.service.getRuntimeSnapshot().pendingPrompts.find((row) => row.threadId === stopLane.threadId),
  );
  const stopped = await send(agent.id, "Retain this accepted input after Stop.", stopLane.taskId);
  await runCauseEffect(
    current.service.steerQueuedMessage({ agentId: agent.id, deliveryId: stopped, expectedTurnId: stopPrompt.turnId }),
  );
  await runCauseEffect(current.service.interrupt(agent.id, stopPrompt.turnId, stopLane.threadId));
  await settled(stopHeld, "interrupted");
  await settled(stopped, "interrupted");
  const stoppedSaved = input(agent.id, stopLane, stopped, "Retain this accepted input after Stop.");
  pass("Accepted input survives Stop with its original turn and interrupted delivery state");
  const raceHeld = await send(agent.id, "Wait for the acknowledgement race. <<HOLD>>", stopLane.taskId);
  const racePrompt = await waitFor("race question", () =>
    current.service.getRuntimeSnapshot().pendingPrompts.find((row) => row.threadId === stopLane.threadId),
  );
  const raceId = await send(agent.id, "Retain only after native acceptance. <<DELAY>>", stopLane.taskId);
  const raceSteer = runCauseEffect(
    current.service.steerQueuedMessage({ agentId: agent.id, deliveryId: raceId, expectedTurnId: racePrompt.turnId }),
  );
  await waitFor("pending race acknowledgement", () =>
    readFileSync(protocolLog, "utf8").includes(`"messageId":"${raceId}"`),
  );
  await runCauseEffect(current.service.interrupt(agent.id, racePrompt.turnId, stopLane.threadId));
  await settled(raceHeld, "interrupted");
  assert.ok(
    !current.service.readTask(agent.id, stopLane.taskId).messages.some((row) => row.id === raceId),
    "A turn end before ACK does not prove acceptance.",
  );
  await writeFile(join(ackRoot, raceId), "ack");
  await raceSteer;
  assert.equal(
    input(agent.id, stopLane, raceId, "Retain only after native acceptance. <<DELAY>>").delivery?.status,
    "interrupted",
  );
  pass("A turn end before the native acknowledgement cannot add an unaccepted input");
  const beforeRestart = countStarts();
  await runCauseEffect(current.service.stop());
  // Reproduce the two old projection failures while keeping the accepted mailbox rows intact.
  for (const lane of lanes.filter((row) => row.taskId)) {
    assert.ok(lane.steerId && lane.saved);
    const stale: ConversationMessage | null =
      lane.name === "branch"
        ? { ...lane.saved, turnId: undefined, delivery: { id: lane.steerId, status: "queued", position: 1 } }
        : null;
    current.database.persistConversationChanges({
      agentId: agent.id,
      threadId: lane.threadId,
      activeTurnId: null,
      changedMessages: stale ? [stale] : [],
      removedMessageIds: stale ? [] : [lane.steerId],
      eventType: "fixture.old-steer-projection",
      detail: {},
    });
  }
  current.database.persistConversationChanges({
    agentId: agent.id,
    threadId: stopLane.threadId,
    activeTurnId: null,
    changedMessages: [],
    removedMessageIds: [stopped],
    eventType: "fixture.old-stopped-steer-projection",
    detail: {},
  });
  current.database.close();
  closed = true;
  current = openService();
  closed = false;
  await runCauseEffect(current.service.initialize());
  for (const lane of lanes) {
    if (lane.taskId) current.service.readTask(agent.id, lane.taskId);
    assert.ok(lane.steerId && lane.saved);
    const repaired = input(agent.id, lane, lane.steerId, lane.saved.text);
    assert.equal(repaired.createdAt, lane.saved.createdAt);
    assert.equal(repaired.turnId, lane.saved.turnId);
    assert.deepEqual(repaired.attachments, lane.saved.attachments);
    assert.equal(repaired.delivery?.status, "completed");
    if (lane.taskId) assert.equal(repaired.reaction, "👍");
    for (const original of lane.preserved ?? []) {
      const retained = stored(agent.id, lane.threadId).find((row) => row.id === original.id);
      assert.ok(retained);
      assert.equal(retained.text, original.text);
      assert.deepEqual(retained.plan, original.plan);
      assert.deepEqual(retained.questionPrompt, original.questionPrompt);
    }
    if (lane.taskId) {
      const first = current.service.readTask(agent.id, lane.taskId);
      const second = current.service.readTask(agent.id, lane.taskId);
      assert.equal(first.revision, second.revision, "Repair is idempotent.");
    }
    pass(`${lane.name}: restart repairs retained input once with original identity, time, files and state`);
  }
  current.service.readTask(agent.id, stopLane.taskId);
  const restoredStop = input(agent.id, stopLane, stopped, stoppedSaved.text);
  assert.equal(restoredStop.delivery?.status, "interrupted");
  assert.equal(countStarts(), beforeRestart, "History repair does not resend accepted messages to the provider.");
  pass("Missing interrupted input is repaired; restart and repeated reads cause no provider replay");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : "Steer history check failed.";
  process.exitCode = 1;
} finally {
  if (!closed) {
    for (const prompt of current.service.getRuntimeSnapshot().pendingPrompts)
      await runCauseEffect(current.service.respondToPrompt({ requestId: prompt.requestId, answers: {} })).catch(
        () => {},
      );
    await waitFor("fixture turns to close", () => current.mailbox.unresolvedDeliveries().length === 0).catch(() => {});
    await runCauseEffect(current.service.stop()).catch(() => {});
    current.database.close();
  }
  if (previousExecutable === undefined) delete process.env.OPENBOT_CODEX_PATH;
  else process.env.OPENBOT_CODEX_PATH = previousExecutable;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(out, "report.json")}\n`);
if (report.error) process.stdout.write(`${report.error}\n`);

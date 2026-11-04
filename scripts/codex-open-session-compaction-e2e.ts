// Runs the real AgentService against a private Codex stand-in. A profile edit unloads a session
// while its provider process still owns it. Its compaction must update context and release queued
// work exactly once, preserving the public conversation and dirty standing instructions.
// Late events from a retired session must not change its replacement. No real account is used.
// Writes .openbot-build/codex-open-session-compaction-e2e/report.json.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const out = resolve(import.meta.dirname, "../.openbot-build/codex-open-session-compaction-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-compact-unloaded-"));
const fake = join(root, "codex"),
  log = join(root, "protocol.jsonl");
const previous = process.env.OPENBOT_CODEX_PATH;
process.env.OPENBOT_CODEX_PATH = fake;
const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
await writeFile(
  fake,
  String.raw`#!/usr/bin/env node
const fs=require('node:fs'),{randomUUID}=require('node:crypto');
if(process.argv.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0);}
const send=x=>process.stdout.write(JSON.stringify(x)+'\n'),log=x=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(x)+'\n');
const held=new Map(),compactions=new Map(),retired=new Set();
const usage=(threadId,turnId,totalTokens)=>send({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{last:{totalTokens},total:{totalTokens},modelContextWindow:475000}}});
const finish=t=>{send({method:'item/completed',params:{threadId:t.threadId,turnId:t.id,item:{id:'answer-'+t.id,type:'agentMessage',text:'Fixture work complete.',phase:'final_answer'}}});send({method:'turn/completed',params:{threadId:t.threadId,turn:{id:t.id,status:'completed'}}});};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),p=r.params||{};
 if(!r.method){const t=held.get(r.id);if(t){held.delete(r.id);finish(t);}return;}
 if(r.id===undefined)return;let result={};
 switch(r.method){
 case 'account/read':result={account:{type:'chatgpt',email:'fixture@example.test'}};break;
 case 'account/rateLimits/read':result={rateLimits:{limitId:'codex',primary:null,secondary:null},rateLimitsByLimitId:null};break;
 case 'model/list':result={data:[{model:'gpt-6.1-sol',displayName:'Fixture'}]};break;
 case 'plugin/list':result={marketplaces:[]};break;
 case 'config/read':result={config:{mcp_servers:{}},layers:[{name:{type:'user',file:'/fake/config.toml',profile:null},version:'1',config:{mcp_servers:{}}}]};break;
 case 'thread/start':result={thread:{id:'fixture-'+randomUUID(),turns:[]}};break;
 case 'thread/read':case 'thread/resume':result={thread:{id:p.threadId,turns:[]}};break;
 case 'thread/turns/list':case 'thread/items/list':result={data:[],nextCursor:null};break;
 case 'thread/unsubscribe':retired.add(p.threadId);result={status:'Unsubscribed'};break;
 case 'turn/start':{
  const t={id:'turn-'+randomUUID(),threadId:p.threadId};
  const text=(p.input||[]).map(x=>x.text||'').join('\n').split('--- current message ---').at(-1);
  log({event:'ordinary-start',threadId:t.threadId,pressure:text.includes('<<PRESSURE>>')});
  send({id:r.id,result:{turn:{id:t.id,status:'inProgress',items:[]}}});send({method:'turn/started',params:{threadId:t.threadId,turn:{id:t.id}}});
  usage(t.threadId,t.id,text.includes('<<PRESSURE>>')?403233:10000);
  for(const old of retired){
   const stale={threadId:old,turnId:'retired-turn',item:{type:'contextCompaction',id:'retired-item'}};
   send({method:'item/started',params:stale});usage(old,'retired-turn',474999);send({method:'item/completed',params:stale});
   log({event:'retired-events',threadId:old});
  }
  if(!text.includes('<<PRESSURE>>'))return finish(t);
  const id='question-'+t.id;held.set(id,t);
  send({id,method:'item/tool/call',params:{threadId:t.threadId,turnId:t.id,callId:id,namespace:'openbot',tool:'ask_user',arguments:{questions:[{id:'choice',header:'Choice',question:'Continue the fixture?'}]}}});return;
 }
 case 'thread/compact/start':{
  const n=(compactions.get(p.threadId)||0)+1;compactions.set(p.threadId,n);
  const t={id:'compact-'+randomUUID(),threadId:p.threadId};const item={type:'contextCompaction',id:'item-'+t.id};
  log({event:'compact',threadId:p.threadId,n});send({id:r.id,result:{}});
  send({method:'turn/started',params:{threadId:p.threadId,turn:{id:t.id}}});send({method:'item/started',params:{threadId:p.threadId,turnId:t.id,item}});
  if(n>=3)return;
  // The real0.166 protocol recomputes usage before completing the item.
  usage(p.threadId,t.id,77813);log({event:'recomputed-usage',threadId:p.threadId,tokens:77813});
  send({method:'item/completed',params:{threadId:p.threadId,turnId:t.id,item}});send({method:'turn/completed',params:{threadId:p.threadId,turn:{id:t.id,status:'completed'}}});return;
 }
 }
 send({id:r.id,result});
});
`,
  { mode: 0o755 },
);
const unused = () => Effect.die(new Error("No browser in this fixture."));
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
const database = new OpenBotDatabase(join(root, "data"));
const store = new AgentStore(join(root, "data"), join(root, "workspace"), database);
const mailbox = new MailboxStore(join(root, "data"), store.sharedRoot, database);
const service = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((p) => p !== "codex"),
  busyMessageMode: () => "queue",
  contextCompactionTimeoutMs: 1000,
});
interface Row {
  event: string;
  threadId: string;
  n?: number;
  tokens?: number;
  pressure?: boolean;
}
const rows = (): Row[] => {
  try {
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x));
  } catch {
    return [];
  }
};
async function waitFor<T>(label: string, read: () => T | null | undefined | false): Promise<T> {
  const end = Date.now() + 15000;
  for (;;) {
    const x = read();
    if (x) return x;
    if (Date.now() > end) throw new Error(`Timed out:${label}`);
    await delay(10);
  }
}
async function send(id: string, text: string) {
  const r = await runCauseEffect(service.sendMessage({ agentId: id, text, attachmentDraftIds: [] }));
  const d = r.deliveries[0]?.id;
  assert.ok(d);
  return d;
}
const completedUsage = new Map<string, number[]>();
service.on("event", (event) => {
  if (event.type !== "runtime-snapshot") return;
  for (const state of event.snapshot.contextStates ?? []) {
    if (state.compaction?.status !== "completed" || !state.usage) continue;
    const values = completedUsage.get(state.agentId) ?? [];
    values.push(state.usage.usedTokens);
    completedUsage.set(state.agentId, values);
  }
});
const report: {
  passed: boolean;
  cases: {
    invalidated: boolean;
    compactionRequests: number;
    reducedUsageObserved: boolean;
    queuedStatus: string;
    providerSessionReplaced: boolean;
    publicThreadRetained: boolean;
    historyRetained: boolean;
    retiredEventsRejected: boolean;
  }[];
  error?: string;
} = { passed: false, cases: [] };
try {
  await runCauseEffect(service.initialize());
  for (const invalidate of [false, true]) {
    const a = await runCauseEffect(
      service.createAgent({
        name: invalidate ? "Unloaded fixture" : "Loaded fixture",
        description: "Initial fixture profile.",
        avatarSeed: invalidate ? "unloaded" : "loaded",
        avatarHue: null,
        initialMessage: "Initialize fixture.",
        provider: "codex",
        model: "gpt-6.1-sol",
      }),
    );
    await waitFor("initialized", () => !mailbox.hasUnfinishedDelivery(a.id));
    const publicThread = store.list().find((row) => row.id === a.id)?.threadId;
    assert.ok(publicThread);
    const original = database.readConversation(a.id, publicThread).messages;
    const pressure = await send(a.id, "Hold this turn. <<PRESSURE>>");
    const prompt = await waitFor("question", () =>
      service.getRuntimeSnapshot().pendingPrompts.find((x) => x.agentId === a.id),
    );
    const session = store.activeProviderSession(a.id)?.externalSessionId;
    assert.ok(session);
    const queued = await send(a.id, "Run this queued fixture input.");
    if (invalidate)
      await runCauseEffect(
        service.updateAgent({ agentId: a.id, description: "Changed fixture profile while the pressure turn runs." }),
      );
    await runCauseEffect(service.respondToPrompt({ requestId: prompt.requestId, answers: { choice: ["Continue"] } }));
    await waitFor("queued input completes after one compaction", () => {
      const starts = rows().filter((x) => x.event === "compact" && x.threadId === session).length;
      assert.ok(starts <= 1, "Reduced context must not immediately compact again.");
      return mailbox.getDelivery(queued)?.delivery.status === "completed";
    });
    const n = rows().filter((x) => x.event === "compact" && x.threadId === session).length;
    const messages = database.readConversation(a.id, publicThread).messages;
    const currentSession = store.activeProviderSession(a.id)?.externalSessionId;
    const usage = service.getRuntimeSnapshot().contextStates?.find((x) => x.agentId === a.id)?.usage?.usedTokens;
    const result = {
      invalidated: invalidate,
      compactionRequests: n,
      reducedUsageObserved: completedUsage.get(a.id)?.includes(77813) ?? false,
      queuedStatus: mailbox.getDelivery(queued)?.delivery.status ?? "missing",
      providerSessionReplaced: currentSession !== session,
      publicThreadRetained: store.list().find((row) => row.id === a.id)?.threadId === publicThread,
      historyRetained: original.every((row) =>
        messages.some((saved) => saved.id === row.id && saved.text === row.text),
      ),
      retiredEventsRejected:
        !invalidate ||
        (rows().some((row) => row.event === "retired-events" && row.threadId === session) && usage === 10000),
    };
    report.cases.push(result);
    assert.equal(n, 1);
    assert.ok(result.reducedUsageObserved, "The compaction completion must show the native77,813-token count.");
    assert.equal(mailbox.getDelivery(pressure)?.delivery.status, "completed");
    assert.ok(result.publicThreadRetained && result.historyRetained);
    assert.equal(
      result.providerSessionReplaced,
      invalidate,
      "Dirty profile changes still reload before the next ordinary turn.",
    );
    assert.ok(result.retiredEventsRejected, "A retired session must not update its replacement's context.");
    process.stdout.write(
      `PASS ${invalidate ? "dirty" : "loaded"} session: one compaction, reduced usage, retained history and completed queue\n`,
    );
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(service.stop()).catch(() => {});
  database.close();
  if (previous === undefined) delete process.env.OPENBOT_CODEX_PATH;
  else process.env.OPENBOT_CODEX_PATH = previous;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(out, "report.json")}\n`);
if (report.error) process.stdout.write(`${report.error}\n`);

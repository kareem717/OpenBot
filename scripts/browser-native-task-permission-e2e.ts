// Runs the real AgentService, router and private SQLite stores. A local provider requests scoped
// native browser control. The browser port records permission decisions; no OS input is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AGENT_PROVIDERS,
  COMPUTER_USE_MCP_SERVER_ID,
  COMPUTER_USE_MCP_SERVER_NAME,
  type McpServerConfig,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { z } from "zod";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const output = resolve(import.meta.dirname, "../.openbot-build/browser-native-task-permission-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-native-permission-"));
const userData = join(root, "profile");
const executable = join(root, "codex");
const protocolLog = join(root, "observations.jsonl");
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
const fs=require('node:fs'),{randomUUID}=require('node:crypto');
if(process.argv.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0);}
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const log=x=>fs.appendFileSync(${JSON.stringify(protocolLog)},JSON.stringify(x)+'\n');
const pending=new Map(),threads=new Map();
const hasComputerUse=p=>{const entry=p.config?.mcp_servers?.[${JSON.stringify(COMPUTER_USE_MCP_SERVER_NAME)}];return Boolean(entry&&entry.enabled!==false);};
const finish=turn=>{
 send({method:'item/completed',params:{threadId:turn.threadId,turnId:turn.id,item:{id:'answer-'+turn.id,type:'agentMessage',text:'Fixture permission check completed.',phase:'final_answer'}}});
 send({method:'turn/completed',params:{threadId:turn.threadId,turn:{id:turn.id,status:'completed'}}});
};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),p=r.params||{};
 if(!r.method){
  const turn=pending.get(r.id);if(!turn)return;pending.delete(r.id);
  log({label:turn.label,success:r.result?.success===true,generalComputerUse:threads.get(turn.threadId)===true});return finish(turn);
 }
 if(r.id===undefined)return;
 let result={};
 switch(r.method){
 case 'account/read':result={account:{type:'chatgpt',email:'fixture@example.test'}};break;
 case 'account/rateLimits/read':result={rateLimits:{limitId:'codex',primary:null,secondary:null},rateLimitsByLimitId:null};break;
 case 'model/list':result={data:[{model:'gpt-6.1-sol',displayName:'Fixture model'}]};break;
 case 'plugin/list':result={marketplaces:[]};break;
 case 'config/read':result={config:{mcp_servers:{}},layers:[{name:{type:'user',file:'/fake/config.toml',profile:null},version:'1',config:{mcp_servers:{}}}]};break;
 case 'thread/start':{const id='fixture-'+randomUUID();threads.set(id,hasComputerUse(p));result={thread:{id,turns:[]}};break;}
 case 'thread/resume':threads.set(p.threadId,hasComputerUse(p));result={thread:{id:p.threadId,turns:[]}};break;
 case 'thread/read':result={thread:{id:p.threadId,turns:[]}};break;
 case 'thread/turns/list':case 'thread/items/list':result={data:[],nextCursor:null};break;
 case 'thread/unsubscribe':result={status:'Unsubscribed'};break;
 case 'turn/start':{
  const text=(p.input||[]).map(x=>x.text||'').join('\n').split('--- current message ---').at(-1);
  const label=[...text.matchAll(/<<NATIVE_PERMISSION:([a-z-]+)>>/g)].at(-1)?.[1];
  const turn={id:'turn-'+randomUUID(),threadId:p.threadId,label};
  send({id:r.id,result:{turn:{id:turn.id,status:'inProgress',items:[]}}});
  send({method:'turn/started',params:{threadId:p.threadId,turn:{id:turn.id}}});
  if(!label)return finish(turn);
  const id='call-'+randomUUID();pending.set(id,turn);
  send({id,method:'item/tool/call',params:{threadId:turn.threadId,turnId:turn.id,callId:id,namespace:'openbot',tool:'tool_call',arguments:{name:'openbot_browser.set_control_mode',arguments:{tabId:'fixture-owned-tab',mode:'native'}}}});return;
 }
 }
 send({id:r.id,result});
});
`,
  { mode: 0o755 },
);

const calls: { threadId: string; allowed: boolean }[] = [];
const activePermissions: (() => boolean)[] = [];
const unused = () => Effect.die(new Error("The permission fixture must not control a browser page."));
const browser: AgentBrowserHost = {
  shareTab: () => {},
  unshareThread: () => {},
  agentTab: () => null,
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: (params, hooks) =>
    Effect.sync(() => {
      assert.equal(params.namespace, "openbot_browser");
      assert.equal(params.tool, "set_control_mode");
      const allowed = hooks?.nativeControlAllowed;
      assert.ok(allowed, "The real router must supply a live native permission callback.");
      activePermissions.push(allowed);
      calls.push({ threadId: params.threadId, allowed: allowed() });
      return {
        success: allowed(),
        contentItems: [{ type: "inputText", text: JSON.stringify({ mode: "native", allowed: allowed() }) }],
      };
    }),
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};
const computerServer: McpServerConfig = {
  id: COMPUTER_USE_MCP_SERVER_ID,
  name: COMPUTER_USE_MCP_SERVER_NAME,
  transport: "stdio",
  enabled: true,
  command: process.execPath,
  args: [],
  env: [],
  envPassthrough: [],
  workingDirectory: "",
  url: "",
  headers: [],
};
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, join(root, "workspace"), database);
const mailbox = new MailboxStore(userData, store.sharedRoot, database);
const service = new AgentService({
  store,
  mailbox,
  browser,
  computerUseMcpServer: () => computerServer,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
});
const observationSchema = z.object({ label: z.string(), success: z.boolean(), generalComputerUse: z.boolean() });
function observations() {
  try {
    return readFileSync(protocolLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => observationSchema.parse(JSON.parse(line)));
  } catch {
    return [];
  }
}
async function waitFor<T>(read: () => T | false | null | undefined): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error("The native permission fixture did not reach its expected state.");
    await delay(20);
  }
}
async function settled(agentId: string): Promise<void> {
  await waitFor(() => !mailbox.hasUnfinishedDelivery(agentId));
}
async function verify(label: string, allowed: boolean, generalComputerUse: boolean): Promise<void> {
  const row = await waitFor(() => observations().find((entry) => entry.label === label));
  assert.equal(row.success, allowed, label);
  assert.equal(row.generalComputerUse, generalComputerUse, `${label}: general Computer Use MCP configuration`);
}
const report: { passed: boolean; checks: string[]; observations?: ReturnType<typeof observations>; error?: string } = {
  passed: false,
  checks: [],
};
try {
  await runCauseEffect(service.initialize());
  const agent = await runCauseEffect(
    service.createAgent({
      name: "Native permission fixture",
      description: "Private native browser permission check.",
      initialMessage: "Start the isolated fixture.",
      avatarSeed: "native-permission-fixture",
      avatarHue: null,
      provider: "codex",
      model: "gpt-6.1-sol",
    }),
  );
  await settled(agent.id);
  await runCauseEffect(service.updateAgent({ agentId: agent.id, computerUse: true }));
  assert.equal(store.list().find((row) => row.id === agent.id)?.computerUse, true);
  const send = async (label: string, taskId?: string) => {
    const receipt = await runCauseEffect(
      service.sendMessage({
        agentId: agent.id,
        text: `Check scoped native control. <<NATIVE_PERMISSION:${label}>>`,
        attachmentDraftIds: [],
        ...(taskId ? { taskId } : {}),
      }),
    );
    const id = receipt.deliveries[0]?.id;
    assert.ok(id);
    const delivery = await waitFor(() => {
      const row = mailbox.getDelivery(id)?.delivery;
      return row && ["completed", "failed", "interrupted", "cancelled"].includes(row.status) ? row : null;
    });
    assert.equal(delivery.status, "completed");
  };
  await send("main");
  await verify("main", true, true);
  const task = await runCauseEffect(
    service.startTask({ agentId: agent.id, text: "Check scoped native control. <<NATIVE_PERMISSION:task>>" }),
  );
  await waitFor(() => service.listTasks(agent.id).tasks.find((row) => row.id === task.id)?.state === "idle");
  await verify("task", true, false);
  const point = database
    .readConversation(agent.id, task.threadId)
    .messages.findLast((row) => row.author === "assistant" && row.turnId);
  assert.ok(point);
  const branch = await runCauseEffect(
    service.branchTask({ agentId: agent.id, taskId: task.id, messageId: point.id, requestId: randomUUID() }, "local"),
  );
  await send("branch", branch.id);
  await verify("branch", true, false);
  report.checks.push("Enabled parent permits scoped native browser control in main, task and branch threads.");
  report.checks.push("Task and branch provider configurations exclude the general Computer Use MCP server.");
  assert.equal(activePermissions.length, 3);
  assert.ok(activePermissions.every((allowed) => allowed()));
  await runCauseEffect(service.updateAgent({ agentId: agent.id, computerUse: false }));
  assert.equal(store.list().find((row) => row.id === agent.id)?.computerUse, false);
  assert.ok(
    activePermissions.every((allowed) => !allowed()),
    "Existing callbacks must read the revoked parent setting.",
  );
  await send("revoked-task", task.id);
  await verify("revoked-task", false, false);
  await send("disabled-main");
  await verify("disabled-main", false, false);
  report.checks.push("Persisted parent revocation rejects existing native callbacks and later main/task calls.");
  assert.equal(calls.length, 5);
  assert.equal(calls[1]?.threadId, task.threadId);
  assert.equal(calls[2]?.threadId, branch.threadId);
  report.passed = true;
  report.observations = observations();
} catch (error) {
  report.error = error instanceof Error ? error.message : "Native task permission check failed.";
  process.exitCode = 1;
} finally {
  await runCauseEffect(service.stop()).catch(() => {});
  database.close();
  if (previousExecutable === undefined) delete process.env.OPENBOT_CODEX_PATH;
  else process.env.OPENBOT_CODEX_PATH = previousExecutable;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(output, "report.json")}\n`);

// Uses the real AgentService/router, VaultService and AgentApiKeys in a private profile. A local
// Codex stand-in searches for DB credentials, lists a synthetic Vault key, and requests that existing
// key without a new form. Main, side, branch and a second workspace-only agent use the same key.
// No account, real credential, database connection or browser page is used.
// Writes .openbot-build/vault-credential-discovery-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AGENT_PROVIDERS, type AgentEvent } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentApiKeys } from "../src/backend/agent-api-keys";
import { VaultService } from "../src/main/vault-service";
import { VaultStore } from "../src/main/vault-store";

const out = resolve(import.meta.dirname, "../.openbot-build/vault-credential-discovery-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-vault-discovery-"));
const userData = join(root, "profile");
const workspace = join(root, "workspace");
const executable = join(root, "codex");
const protocolLog = join(root, "observations.jsonl");
const keyName = "SHARED_DB_CONN_STRING";
const syntheticKey = "postgresql://fixture:synthetic-vault-e2e-6d80bb9b@db.example.invalid/fixture";
const queries = [
  "database credentials",
  "vault database credentials",
  "DB credentials",
  "connection strings",
  "database password",
];
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
const pending=new Map();
const queries=${JSON.stringify(queries)};
const calls=[...queries.map(query=>({tool:'tool_search',arguments:{query}})),
 {tool:'tool_describe',arguments:{name:'openbot.list_api_keys'}},
 {tool:'tool_call',arguments:{name:'openbot.list_api_keys',arguments:{}}},
 {tool:'request_api_key',arguments:{name:${JSON.stringify(keyName)},title:'Use the existing fixture database credential.'}}];
const finish=turn=>{
 send({method:'item/completed',params:{threadId:turn.threadId,turnId:turn.id,item:{id:'answer-'+turn.id,type:'agentMessage',text:'The credential metadata is available through its saved file.',phase:'final_answer'}}});
 send({method:'turn/completed',params:{threadId:turn.threadId,turn:{id:turn.id,status:'completed'}}});
};
const next=turn=>{
 const call=calls[turn.step];if(!call)return finish(turn);
 const id='call-'+randomUUID();pending.set(id,turn);
 send({id,method:'item/tool/call',params:{threadId:turn.threadId,turnId:turn.id,callId:id,namespace:'openbot',...call}});
};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),p=r.params||{};
 if(!r.method){
  const turn=pending.get(r.id);if(!turn)return;pending.delete(r.id);
  const raw=JSON.stringify(r.result),leaked=raw.includes(${JSON.stringify(syntheticKey)});
  let payload={};try{payload=JSON.parse(r.result?.contentItems?.find(x=>x.type==='inputText')?.text||'{}');}catch{}
  const call=calls[turn.step];
  // Keep only safe metadata. Even a failing result must not copy a value to this log.
  const entry={event:'tool-result',label:turn.label,turnId:turn.id,step:turn.step,tool:call.tool,query:call.arguments.query,success:r.result?.success===true,leaked};
  if(!leaked){
   if(Array.isArray(payload.tools))entry.tools=payload.tools.map(x=>({name:x.name,hasSchema:x.inputSchema!==undefined}));
   if(Array.isArray(payload.keys))entry.keys=payload.keys.map(x=>({name:x.name,path:x.path,source:x.source}));
   if(typeof payload.status==='string')entry.status=payload.status;
   for(const field of ['name','path','source'])if(typeof payload[field]==='string')entry[field]=payload[field];
  }
  log(entry);turn.step++;return next(turn);
 }
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
  const text=(p.input||[]).map(x=>x.text||'').join('\n').split('--- current message ---').at(-1);
  const label=/<<CREDENTIAL_CHECK:([a-z-]+)>>/.exec(text)?.[1];
  const turn={id:'turn-'+randomUUID(),threadId:p.threadId,label,step:0};
  send({id:r.id,result:{turn:{id:turn.id,status:'inProgress',items:[]}}});
  send({method:'turn/started',params:{threadId:p.threadId,turn:{id:turn.id}}});
  if(!label)return finish(turn);
  log({event:'turn',label,sandboxType:p.sandboxPolicy?.type});return next(turn);
 }
 }
 send({id:r.id,result});
});
`,
  { mode: 0o755 },
);

const cipher = {
  encrypt: (value: string) => Buffer.from(value, "utf8").reverse(),
  decrypt: (value: Buffer) => Buffer.from(value).reverse().toString("utf8"),
};
const vault = new VaultService({ store: new VaultStore(join(root, "vault.json"), cipher), canPersist: () => true });
await runCauseEffect(vault.load());
await runCauseEffect(
  vault.save({ kind: "apiKey", id: null, name: keyName, notes: "Synthetic E2E only.", key: syntheticKey }),
);
const keysRoot = join(root, "agent-api-keys");
const apiKeys = new AgentApiKeys(keysRoot, () => vault.items.apiKeys());
const unused = () => Effect.die(new Error("This fixture must not act on a browser page."));
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
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, workspace, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, database);
const service = new AgentService({
  store,
  mailbox,
  browser,
  agentApiKeys: apiKeys,
  vaultItems: vault.items,
  passwordVault: vault.logins,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
});
const events: AgentEvent[] = [];
service.on("event", (event) => events.push(event));
interface Observation {
  event: "turn" | "tool-result";
  label: string;
  sandboxType?: string;
  step?: number;
  tool?: string;
  query?: string;
  success?: boolean;
  leaked?: boolean;
  tools?: { name: string; hasSchema: boolean }[];
  keys?: { name: string; path: string; source?: string }[];
  status?: string;
  name?: string;
  path?: string;
  source?: string;
}
function observations(): Observation[] {
  try {
    return readFileSync(protocolLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line): Observation => JSON.parse(line));
  } catch {
    return [];
  }
}
async function waitFor<T>(label: string, read: () => T | false | null | undefined): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (events.some((event) => event.type === "prompt"))
      throw new Error("An existing shared key must not open a credential form.");
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}
async function settled(id: string) {
  const row = await waitFor("delivery end", () => {
    const row = mailbox.getDelivery(id)?.delivery;
    return row && ["completed", "failed", "interrupted", "cancelled"].includes(row.status) ? row : null;
  });
  assert.equal(row.status, "completed", row.error ?? id);
}
async function send(agentId: string, text: string, taskId?: string) {
  const receipt = await runCauseEffect(
    service.sendMessage({ agentId, text, attachmentDraftIds: [], ...(taskId ? { taskId } : {}) }),
  );
  const id = receipt.deliveries[0]?.id;
  assert.ok(id);
  await settled(id);
}
async function create(name: string) {
  const agent = await runCauseEffect(
    service.createAgent({
      name,
      description: "Isolated credential discovery fixture.",
      initialMessage: "Start the isolated fixture.",
      avatarSeed: name.toLowerCase().replaceAll(" ", "-"),
      avatarHue: null,
      provider: "codex",
      model: "gpt-6.1-sol",
    }),
  );
  await waitFor("agent idle", () => !mailbox.hasUnfinishedDelivery(agent.id));
  return agent;
}
const report: {
  passed: boolean;
  checks: string[];
  lanes: { name: string; queries: string[]; keyName: string; source: string; newPrompts: number }[];
  error?: string;
} = { passed: false, checks: [], lanes: [] };
const pass = (name: string) => {
  report.checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
};
async function verify(label: string, agentId: string, threadId: string) {
  const rows = observations().filter((row) => row.label === label && row.event === "tool-result");
  assert.equal(rows.length, queries.length + 3, `${label}: every real router call answered`);
  assert.ok(
    rows.every((row) => row.success && !row.leaked),
    "Every tool result succeeds without the credential value.",
  );
  for (const query of queries) {
    const found = rows.find((row) => row.query === query);
    assert.ok(found, query);
    assert.ok(
      found.tools?.some((tool) => tool.name === "openbot.list_api_keys"),
      `${label}: ${query} discovers API-key access`,
    );
  }
  const described = rows.find((row) => row.tool === "tool_describe");
  assert.ok(
    described?.tools?.some((tool) => tool.name === "openbot.list_api_keys" && tool.hasSchema),
    "Describe loads the callable schema.",
  );
  const listed = rows.find((row) => row.tool === "tool_call");
  assert.ok(listed);
  assert.deepEqual(listed.keys, [{ name: keyName, path: join(keysRoot, ".vault", keyName), source: "vault" }]);
  const requested = rows.find((row) => row.tool === "request_api_key");
  assert.ok(requested);
  assert.equal(requested.status, "saved");
  assert.equal(requested.name, keyName);
  assert.equal(requested.path, listed.keys?.[0]?.path);
  assert.equal(requested.source, "vault");
  assert.equal(
    events.filter((event) => event.type === "prompt").length,
    0,
    "Reusing a shared key never asks for another value.",
  );
  const file = await stat(join(keysRoot, ".vault", keyName));
  assert.ok(file.size > 0);
  if (process.platform !== "win32") assert.equal(file.mode & 0o777, 0o600);
  assert.ok(
    !JSON.stringify(database.readConversation(agentId, threadId)).includes(syntheticKey),
    "Saved conversation excludes the credential value.",
  );
  report.lanes.push({ name: label, queries, keyName, source: "vault", newPrompts: 0 });
  pass(`${label}: DB credential searches lead to shared metadata and reuse without a form or exposed value`);
}
try {
  await runCauseEffect(service.initialize());
  const jan = await create("Jan fixture");
  const mainThread = store.list().find((row) => row.id === jan.id)?.threadId;
  assert.ok(mainThread);
  await send(jan.id, "Find the saved DB credential. <<CREDENTIAL_CHECK:main>>");
  await verify("main", jan.id, mainThread);
  const side = await runCauseEffect(
    service.startTask({ agentId: jan.id, text: "Find the saved DB credential. <<CREDENTIAL_CHECK:side>>" }),
  );
  await waitFor("side idle", () => service.listTasks(jan.id).tasks.find((row) => row.id === side.id)?.state === "idle");
  await verify("side", jan.id, side.threadId);
  const point = database
    .readConversation(jan.id, side.threadId)
    .messages.findLast((row) => row.author === "assistant" && row.turnId);
  assert.ok(point);
  const branch = await runCauseEffect(
    service.branchTask({ agentId: jan.id, taskId: side.id, messageId: point.id, requestId: randomUUID() }, "local"),
  );
  await send(jan.id, "Find the saved DB credential. <<CREDENTIAL_CHECK:branch>>", branch.id);
  await verify("branch", jan.id, branch.threadId);
  const other = await create("Second fixture");
  await runCauseEffect(service.updateAgent({ agentId: other.id, access: "workspace", computerUse: false }));
  const otherSaved = store.list().find((row) => row.id === other.id);
  assert.ok(otherSaved?.threadId);
  assert.equal(otherSaved.access, "workspace");
  assert.equal(otherSaved.computerUse, false);
  await send(other.id, "Find the saved DB credential. <<CREDENTIAL_CHECK:other-workspace>>");
  await verify("other-workspace", other.id, otherSaved.threadId);
  assert.equal(
    observations().find((row) => row.label === "other-workspace" && row.event === "turn")?.sandboxType,
    "workspaceWrite",
  );
  pass("A second agent shares the same file while Computer Use is off and its write sandbox is restricted");
  assert.ok(!JSON.stringify(events).includes(syntheticKey), "All service events exclude the credential value.");
  for (const agent of [jan, other]) {
    await assert.rejects(stat(join(keysRoot, agent.id, keyName)), "Reusing a Vault key creates no private copy.");
  }
  assert.equal(vault.state().items.length, 1, "Search and reuse create no additional Vault item.");
  assert.ok(!readFileSync(protocolLog, "utf8").includes(syntheticKey), "Observation artifacts contain metadata only.");
  pass("Shared credential remains a single Vault entry; results, events, history and artifacts contain no value");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : "Credential discovery check failed.";
  process.exitCode = 1;
} finally {
  await runCauseEffect(service.stop()).catch(() => {});
  database.close();
  if (previousExecutable === undefined) delete process.env.OPENBOT_CODEX_PATH;
  else process.env.OPENBOT_CODEX_PATH = previousExecutable;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(out, "report.json")}\n`);
if (report.error) process.stdout.write(`${report.error}\n`);

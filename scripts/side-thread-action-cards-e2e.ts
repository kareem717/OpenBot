// Runs the supplied real desktop package on a temporary profile. All account and MCP requests use
// one loopback fixture. No user account, provider, or external sign-in is used.
// CI: xvfb-run -a bun scripts/side-thread-action-cards-e2e.ts dist/linux-unpacked/openbot
// Mac: bun scripts/side-thread-action-cards-e2e.ts '/path/OpenBot.app/Contents/MacOS/OpenBot'
// Also checks live plans and accepted steering in main, side, and branch histories.
// Writes .openbot-build/side-thread-action-cards-e2e/report.json and one screenshot.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type ConversationMessage,
  type McpServerConfig,
  mcpSignInItemType,
  type OpenBotDesktopApi,
} from "@openbot/contracts/ipc";
import { translateFor } from "@openbot/i18n";
import { type Browser, chromium } from "playwright-core";
import { verifyBrowserOwnership } from "../scripts/dev-automation/cdp-client";
import { AgentStore } from "../src/backend/agent-store";
import { AgentThreadStore, copyBranchMessages } from "../src/backend/agent-threads/agent-thread-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { McpServerStore } from "../src/backend/mcp-server-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

declare global {
  interface Window {
    openbot: OpenBotDesktopApi;
  }
}
const executable = process.argv[2];
assert.ok(executable, "Pass the executable of the desktop package to verify.");
// A Linux runner has neither a desktop browser nor a session keyring. Keep both in this fixture;
// the account and MCP stores still use the packaged app's real encryption and OAuth paths.
if (process.platform === "linux" && process.env.OPENBOT_CARD_E2E_PRIVATE_DBUS !== "1") {
  const session = spawn("dbus-run-session", ["--", process.execPath, import.meta.filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, OPENBOT_CARD_E2E_PRIVATE_DBUS: "1" },
  });
  const [status] = await once(session, "exit");
  process.exit(typeof status === "number" ? status : 1);
}
const out = resolve(import.meta.dirname, "../.openbot-build/side-thread-action-cards-e2e");
await mkdir(out, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "openbot-action-cards-"));
const userData = join(root, "profile");
const english = translateFor("en");
const agentName = "Action Card Fixture";
const sideTitle = "API Keys fixture";
const branchTitle = "API Keys branch";
let primaryId = "";
let laterId = "";
const serverName = "Local AgentMail fixture";
const laterName = "Local branch fixture";
const code = "123456";
const user = {
  id: randomUUID(),
  email: "cards@example.test",
  name: agentName,
  avatarUrl: null,
  analyticsEnabled: false,
};
const report: {
  passed: boolean;
  checks: string[];
  failures: string[];
  pageErrors: string[];
  oauthRequests: number;
  discoveryRequests: number;
  registrations: number;
  tokenRequests: number;
} = {
  passed: false,
  checks: [],
  failures: [],
  pageErrors: [],
  oauthRequests: 0,
  discoveryRequests: 0,
  registrations: 0,
  tokenRequests: 0,
};
let origin = "";
let child: ChildProcess | undefined;
let keyring: ChildProcess | undefined;
let browser: Browser | undefined;

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/v1/auth/email/start")
      return json(response, 200, { challengeId: "fixture", expiresAt: Date.now() + 600_000, developmentCode: code });
    if (url.pathname === "/v1/auth/email/verify")
      return json(response, 200, { sessionToken: "local-fixture-session", user });
    if (["/v1/me", "/v1/me/profile", "/v1/me/analytics"].includes(url.pathname)) return json(response, 200, user);
    if (url.pathname === "/v2/remote/hosts/" || url.pathname === "/v2/remote/sessions/")
      return json(response, 200, { hosts: [], sessions: [] });
    if (url.pathname === "/health/live") return json(response, 200, { ok: true });
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      report.discoveryRequests += 1;
      return json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration"
    )
      return json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/register") {
      report.registrations += 1;
      const input: { redirect_uris: string[] } = JSON.parse(await body(request));
      return json(response, 201, {
        client_id: "local-fixture-client",
        token_endpoint_auth_method: "none",
        redirect_uris: input.redirect_uris,
      });
    }
    if (url.pathname === "/authorize") {
      report.oauthRequests += 1;
      const redirect = url.searchParams.get("redirect_uri");
      assert.ok(redirect);
      const target = new URL(redirect);
      assert.ok(
        target.hostname === "127.0.0.1" || target.hostname === "localhost",
        "The fixture must only redirect to a local callback.",
      );
      target.searchParams.set("code", "local-grant");
      target.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: target.toString() }).end();
      return;
    }
    if (url.pathname === "/token") {
      report.tokenRequests += 1;
      return json(response, 200, { access_token: "local-fixture-access", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname !== "/mcp") return json(response, 404, { error: "No fixture route." });
    if (request.headers.authorization !== "Bearer local-fixture-access")
      return json(
        response,
        401,
        { error: "Sign in required." },
        { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
      );
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const rpc: { id?: number | string; method: string } = JSON.parse(await body(request));
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "local-card-fixture", version: "1" },
          }
        : { tools: [] };
    return json(response, 200, { jsonrpc: "2.0", id: rpc.id, result });
  })().catch(() => json(response, 500, { error: "The local fixture failed." }));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address === "object");
origin = `http://127.0.0.1:${address.port}`;

const config = (id: string, name: string): McpServerConfig => ({
  id,
  name,
  transport: "http",
  enabled: true,
  url: `${origin}/mcp`,
  command: "",
  args: [],
  env: [],
  envPassthrough: [],
  workingDirectory: "",
  headers: [],
});
const marker = (mcpServerId: string): ConversationMessage => ({
  id: randomUUID(),
  turnId: randomUUID(),
  author: "system",
  source: "system",
  status: "completed",
  createdAt: new Date().toISOString(),
  itemType: mcpSignInItemType({ mcpServerId }),
  text: "The local fixture needs a sign-in.",
});
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, root, database);
await runCauseEffect(store.initialize());
const agent = await runCauseEffect(
  store.createAgent({ name: agentName, description: "", avatarSeed: "action-card-fixture", avatarHue: null }),
);
await runCauseEffect(store.updateAgent({ agentId: agent.id, provider: "codex", model: "gpt-6-luna" }));
const mainThreadId = await runCauseEffect(store.ensureThreadId(agent.id));
const mcpStore = new McpServerStore(database);
primaryId = mcpStore.save(config("", serverName)).id;
laterId = mcpStore.save({ ...config("", laterName), transport: "stdio", enabled: false, command: "node", url: "" }).id;
const mainMessages = [marker(primaryId)];
const persist = (threadId: string, messages: ConversationMessage[]) =>
  database.persistConversationChanges({
    agentId: agent.id,
    threadId,
    activeTurnId: null,
    changedMessages: messages,
    eventType: "fixture.cards",
    detail: {},
  });
persist(mainThreadId, mainMessages);
const threads = new AgentThreadStore(database);
const side = threads.create({ agentId: agent.id, origin: "user", title: sideTitle, titleSource: "agent" });
persist(side.threadId, [marker(primaryId)]);
const branch = threads.branch({
  agentId: agent.id,
  requestId: randomUUID(),
  threadId: `openbot-thread-${randomUUID()}`,
  title: branchTitle,
  sourceThreadId: mainThreadId,
  sourceMessageId: mainMessages[0]?.id ?? "missing-main-card",
  messages: copyBranchMessages(mainMessages, new Map()),
});
persist(branch.threadId, [marker(laterId)]);
database.close();
await writeFile(join(userData, "openbot-language-preference-v1.json"), JSON.stringify({ version: 1, language: "en" }));
await writeFile(
  join(userData, "openbot-setup-v2.json"),
  JSON.stringify({ version: 2, preferredProvider: "codex", completedAt: new Date().toISOString() }),
);
// The provider answers Continue locally. It never reads the user's provider configuration.
const fakeCodex = join(root, "codex-fixture");
const fakeSource = join(root, "codex-fixture.cjs");
const planControl = join(root, "plan-control.json");
const planTitle = "Routine fixture plan";
const planStart = "Start the controlled routine-plan fixture.";
await writeFile(planControl, "{}");
await writeFile(
  fakeSource,
  `
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.166.0\\n'); process.exit(0); }
const readline = require('node:readline'); const crypto = require('node:crypto'); const fs = require('node:fs');
const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
const config = {config:{mcp_servers:{}},layers:[{name:{type:'user',file:'/local/config.toml',profile:null},version:'1',config:{mcp_servers:{}}}]};
const held = new Map(); let lastCommand = '';
const plan = (turn, phase) => send({method:'turn/plan/updated',params:{threadId:turn.threadId,turnId:turn.id,explanation:${JSON.stringify(planTitle)},plan:['Inspect routines','Repair routine links','Verify stored history'].map((step,index)=>({step,status:phase==='finish'||(phase==='advance'&&index===0)?'completed':index===(phase==='advance'?1:0)?'inProgress':'pending'}))}});
const finish = (turn) => {
 send({method:'item/completed',params:{threadId:turn.threadId,turnId:turn.id,item:{id:'answer-'+turn.id,type:'agentMessage',text:'Local fixture continued.',phase:'final_answer'}}});
 send({method:'turn/completed',params:{threadId:turn.threadId,turn:{id:turn.id,status:'completed'}}});
};
setInterval(()=>{
 let command; try { const text=fs.readFileSync(${JSON.stringify(planControl)},'utf8');if(text===lastCommand)return;command=JSON.parse(text);lastCommand=text; } catch { return; }
 const turn=held.get(command.turnId);if(!turn)return;plan(turn,command.phase);
 if(command.phase==='finish'){held.delete(turn.id);finish(turn);}
},25).unref();
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line), p=m.params||{}; if(m.id===undefined)return;
 let r={};
 switch(m.method){
 case 'account/read': r={account:{type:'chatgpt',email:'provider@example.test'}};break;
 case 'account/rateLimits/read': r={rateLimits:{limitId:'codex',primary:null,secondary:null},rateLimitsByLimitId:null};break;
 case 'model/list': r={data:[{model:'gpt-6-luna',displayName:'GPT-6 Luna'}]};break;
 case 'plugin/list':r={marketplaces:[]};break;
 case 'config/read':r=config;break;
 case 'thread/start':r={thread:{id:'fixture-'+crypto.randomUUID(),turns:[]}};break;
 case 'thread/resume':case 'thread/read':r={thread:{id:p.threadId,turns:[]}};break;
 case 'thread/unsubscribe':r={status:'Unsubscribed'};break;
 case 'thread/turns/list':case 'thread/items/list':r={data:[],nextCursor:null};break;
 case 'turn/start': {
  const id='turn-'+crypto.randomUUID();send({id:m.id,result:{turn:{id,status:'inProgress',items:[]}}});
  send({method:'turn/started',params:{threadId:p.threadId,turn:{id}}});
  const turn={id,threadId:p.threadId};
  const text=(p.input||[]).map(x=>x.text||'').join('\\n').split('--- current message ---').at(-1);
  if(text.includes(${JSON.stringify(planStart)})){held.set(id,turn);plan(turn,'start');return;}
  finish(turn);return;
 }
 case 'turn/steer': {
  const turn=held.get(p.expectedTurnId);
  if(!turn||turn.threadId!==p.threadId){send({id:m.id,error:{code:-32000,message:'Fixture turn changed'}});return;}
  send({id:m.id,result:{turnId:turn.id}});return;
 }
 }
 send({id:m.id,result:r});
});
`,
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(fakeCodex, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakeSource)} "$@"\n`, { mode: 0o755 });

async function until<T>(
  label: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  limit = 45_000,
): Promise<T> {
  const end = Date.now() + limit;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
    await delay(100);
  }
}
function check(name: string) {
  report.checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
async function stopChild(process: ChildProcess | undefined) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  const exit = once(process, "exit");
  process.kill("SIGTERM");
  const ended = await Promise.race([exit.then(() => true), delay(10_000).then(() => false)]);
  if (!ended) {
    process.kill("SIGKILL");
    await exit;
  }
}

async function linuxDesktopEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== "linux") return process.env;
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, "Start the Linux fixture in its private D-Bus session.");
  const environment = {
    ...process.env,
    XDG_DATA_HOME: join(root, "desktop-data"),
    XDG_CONFIG_HOME: join(root, "desktop-config"),
    XDG_CACHE_HOME: join(root, "desktop-cache"),
    XDG_RUNTIME_DIR: join(root, "desktop-runtime"),
  };
  const control = join(environment.XDG_RUNTIME_DIR, "keyring");
  const applications = join(environment.XDG_DATA_HOME, "applications");
  const bin = join(root, "bin");
  for (const directory of [applications, environment.XDG_CONFIG_HOME, environment.XDG_CACHE_HOME, control, bin])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  keyring = spawn(
    "gnome-keyring-daemon",
    ["--foreground", "--unlock", "--components=secrets", `--control-directory=${control}`],
    {
      env: environment,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  // This password protects only disposable mock OAuth records in this fixture's temporary data dir.
  keyring.stdin?.end("openbot-local-fixture\n");
  await until(
    "the private Secret Service starts",
    () => {
      const probe = spawn(
        "dbus-send",
        [
          "--session",
          "--print-reply",
          "--dest=org.freedesktop.DBus",
          "/org/freedesktop/DBus",
          "org.freedesktop.DBus.GetNameOwner",
          "string:org.freedesktop.secrets",
        ],
        { env: environment, stdio: "ignore" },
      );
      return once(probe, "exit").then(([status]) => status === 0);
    },
    Boolean,
  );

  const openerSource = join(root, "local-browser.cjs");
  await writeFile(
    openerSource,
    `
const target = new URL(process.argv[2]);
if (target.origin !== ${JSON.stringify(origin)} || target.pathname !== '/authorize') process.exit(1);
(async () => {
  const response = await fetch(target, { redirect: 'manual' });
  if (response.status !== 302) throw new Error('The local authorization did not redirect.');
  const callback = new URL(response.headers.get('location'));
  if (callback.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(callback.hostname)) throw new Error('The callback is not local.');
  const completed = await fetch(callback, { redirect: 'error' });
  if (!completed.ok) throw new Error('The local callback failed.');
  await completed.arrayBuffer();
})().catch(() => { process.exitCode = 1; });
`,
  );
  const opener = join(bin, "xdg-open");
  await writeFile(opener, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(openerSource)} "$@"\n`, { mode: 0o755 });
  await writeFile(
    join(applications, "openbot-local-fixture.desktop"),
    `[Desktop Entry]\nType=Application\nName=OpenBot local OAuth fixture\nExec=${opener} %u\nMimeType=x-scheme-handler/http;x-scheme-handler/https;\nNoDisplay=true\n`,
  );
  await writeFile(
    join(environment.XDG_CONFIG_HOME, "mimeapps.list"),
    "[Default Applications]\nx-scheme-handler/http=openbot-local-fixture.desktop\nx-scheme-handler/https=openbot-local-fixture.desktop\n",
  );
  return { ...environment, PATH: `${bin}:${process.env.PATH ?? ""}`, BROWSER: opener };
}

try {
  const desktopEnvironment = await linuxDesktopEnvironment();
  child = spawn(
    resolve(executable),
    [
      `--user-data-dir=${userData}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      ...(process.platform === "linux" ? ["--password-store=gnome-libsecret"] : []),
    ],
    {
      stdio: "ignore",
      env: { ...desktopEnvironment, OPENBOT_AUTH_API_URL: origin, OPENBOT_CODEX_PATH: fakeCodex },
    },
  );
  const port = await until(
    "renderer CDP starts",
    () => readFile(join(userData, "DevToolsActivePort"), "utf8").catch(() => ""),
    (text) => /^\d+\n/u.test(text),
  );
  const cdpOrigin = `http://127.0.0.1:${port.split("\n")[0]}`;
  await until(
    "the app publishes its main renderer",
    async () => {
      const response = await fetch(`${cdpOrigin}/json/list`);
      const targets: Array<{ url: string }> = await response.json();
      return targets.some((target) => target.url.includes("index.html"));
    },
    Boolean,
  );
  browser = await chromium.connectOverCDP(cdpOrigin);
  assert.ok(
    child.pid && (await verifyBrowserOwnership(browser, child.pid)),
    "CDP must belong to this fixture's child process.",
  );
  const appPage = await until(
    "the app window opens",
    async () =>
      browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().includes("index.html")),
    (value) => value !== undefined,
  );
  assert.ok(appPage);
  const page = appPage;
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await page.waitForFunction(() => typeof window.openbot?.auth?.getState === "function");
  const auth = await page.evaluate(async () => {
    await window.openbot.auth.requestEmailCode("cards@example.test");
    return window.openbot.auth.verifyEmailCode({ challengeId: "fixture", code: "123456" });
  });
  assert.equal(auth.status, "signed_in");
  const whatsNew = page.getByRole("dialog", { name: english("update.whatsNew.title") });
  if (await whatsNew.isVisible()) await whatsNew.getByRole("button", { name: english("update.whatsNew.done") }).click();
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page
    .getByRole("navigation", { name: english("sidebar.nav.label") })
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(agentName)}[,.]`) })
    .first()
    .click();
  await page.evaluate(
    (agentId) => window.openbot.agent.updateAgentHostSettings({ agentId, busyMessageMode: "steer" }),
    agent.id,
  );
  async function checkPlan(lane: string, taskId?: string) {
    const input = { agentId: agent.id, taskId };
    const read = () =>
      page.evaluate(
        (target) =>
          target.taskId
            ? window.openbot.agent.readTask({ agentId: target.agentId, taskId: target.taskId })
            : window.openbot.agent.readConversation(target.agentId),
        input,
      );
    const send = (text: string) =>
      page.evaluate(
        (target) =>
          window.openbot.agent.sendMessage({
            agentId: target.agentId,
            text: target.text,
            attachmentDraftIds: [],
            ...(target.taskId ? { taskId: target.taskId } : {}),
            clientMessageId: crypto.randomUUID(),
          }),
        { ...input, text },
      );
    await send(planStart);
    const started = await until("the live plan starts", read, (snapshot) =>
      Boolean(
        snapshot.activeTurnId && snapshot.messages.some((message) => message.id === `${snapshot.activeTurnId}:plan`),
      ),
    );
    const turnId = started.activeTurnId;
    assert.ok(turnId);
    const row = page.locator(`[data-chat-search-message="${turnId}:plan"]`);
    const summary = (done: number) => english("chat.taskList.summary", { done, total: 3 });
    const control = (done: number) => row.getByRole("button", { name: new RegExp(escapeRegExp(summary(done))) });
    await row.getByRole("button", { name: new RegExp(escapeRegExp(planTitle)) }).waitFor();
    await control(0).waitFor();
    assert.equal(await control(0).getAttribute("aria-expanded"), "true");
    await row.getByRole("img", { name: english("chat.taskList.state.active"), exact: true }).waitFor();
    assert.equal(await row.getByRole("img", { name: english("chat.taskList.state.pending"), exact: true }).count(), 2);
    await control(0).click();
    assert.equal(await control(0).getAttribute("aria-expanded"), "false");
    await control(0).click();
    assert.equal(await control(0).getAttribute("aria-expanded"), "true");
    check(`${lane} history uses the same accessible plan controls and live step states`);

    const text = `Revise the ${lane} routine check without losing this steering message.`;
    const receipt = await send(text);
    const id = receipt.deliveries[0]?.id;
    assert.ok(id);
    const messageRow = page.locator(`[data-chat-search-message="${id}"]`);
    await until("the accepted steer is in its conversation", read, (snapshot) =>
      snapshot.messages.some((message) => message.id === id && message.delivery?.status === "running"),
    );
    await messageRow.getByText(text, { exact: true }).waitFor();
    await control(0).click();
    assert.equal(await control(0).getAttribute("aria-expanded"), "false");
    await writeFile(planControl, JSON.stringify({ turnId, phase: "advance" }));
    await control(1).waitFor();
    assert.equal(await control(1).getAttribute("aria-expanded"), "false");
    await control(1).click();
    await until(
      "the plan keeps one active step",
      () => row.getByRole("img", { name: english("chat.taskList.state.active"), exact: true }).count(),
      (count) => count === 1,
    );
    assert.equal(await control(1).getAttribute("aria-expanded"), "true");
    assert.equal(await row.getByRole("img", { name: english("chat.taskList.state.done"), exact: true }).count(), 1);
    await messageRow.getByText(text, { exact: true }).waitFor();
    await writeFile(planControl, JSON.stringify({ turnId, phase: "finish" }));
    await control(3).waitFor();
    const finished = await until(
      "the plan and accepted steer finish",
      read,
      (snapshot) =>
        snapshot.activeTurnId === null &&
        snapshot.messages.some((message) => message.id === id && message.delivery?.status === "completed"),
    );
    assert.equal(finished.messages.filter((message) => message.id === `${turnId}:plan`).length, 1);
    assert.equal(finished.messages.filter((message) => message.id === id && message.text === text).length, 1);
    assert.equal(await control(3).getAttribute("aria-expanded"), "true");
    await until(
      "all three plan steps finish",
      () => row.getByRole("img", { name: english("chat.taskList.state.done"), exact: true }).count(),
      (count) => count === 3,
    );
    await messageRow.getByText(text, { exact: true }).waitFor();
    check(`${lane} plan updates keep their ID, open state, and one visible accepted steering message`);
    return { id, text };
  }
  const signIn = (name: string, title?: string) => {
    const history = title
      ? page.getByRole("region", { name: english("conversation.threads.view.label", { title }), exact: true })
      : page;
    return history.getByRole("button", { name: english("chat.mcpSignIn.signInNamed", { name }), exact: true });
  };
  await signIn(serverName).waitFor();
  check("Main history renders its saved MCP sign-in card");
  await checkPlan("Main");
  // This row is added after the composer first loaded MCP configs. Opening its branch must reload them.
  await page.evaluate(
    (saved) => window.openbot.agent.saveMcpServer({ config: saved }, "local"),
    config(laterId, laterName),
  );
  async function openThread(title: string) {
    await page
      .getByRole("button", { name: english("conversation.threads.all"), exact: true })
      .first()
      .click();
    await page
      .getByRole("menuitem", { name: new RegExp(escapeRegExp(title)) })
      .first()
      .click();
  }
  await openThread(sideTitle);
  await signIn(serverName, sideTitle).waitFor();
  check("Side history renders its saved MCP sign-in card");
  const sideSteer = await checkPlan("Side", side.taskId);
  await openThread(branchTitle);
  await signIn(laterName, branchTitle).waitFor();
  check("Branch history reloads newly saved MCP configs and renders its sign-in card");
  const branchSteer = await checkPlan("Branch", branch.taskId);
  await openThread(sideTitle);
  await page
    .locator(`[data-chat-search-message="${sideSteer.id}"]`)
    .getByText(sideSteer.text, { exact: true })
    .waitFor();
  await openThread(branchTitle);
  await page
    .locator(`[data-chat-search-message="${branchSteer.id}"]`)
    .getByText(branchSteer.text, { exact: true })
    .waitFor();
  check("Accepted side and branch steering messages remain visible after reopening their histories");
  await signIn(laterName, branchTitle).click();
  await until(
    "the local fixture sign-in completes",
    () => page.evaluate(() => window.openbot.agent.listMcpSignIns("local")),
    (states) => states.some((state) => state.mcpServerId === laterId && state.signedIn),
  );
  assert.ok(report.oauthRequests > 0, "The card must use the local fixture's OAuth flow.");
  check("The branch card completes the local sign-in flow for its MCP server");
  await page.keyboard.press("Escape");
  const continueButton = page.getByRole("button", {
    name: english("chat.mcpSignIn.continueNamed", { name: laterName }),
    exact: true,
  });
  await continueButton.waitFor();
  const composer = page.getByRole("textbox", {
    name: english("conversation.threads.view.placeholder", { name: agentName, title: branchTitle }),
  });
  const draft = "Keep this unsent draft.";
  await composer.fill(draft);
  await continueButton.click();
  const continuation = english("chat.mcpSignIn.message", { name: laterName });
  await until(
    "Continue is stored in its branch",
    () => page.evaluate((input) => window.openbot.agent.readTask(input), { agentId: agent.id, taskId: branch.taskId }),
    (snapshot) => snapshot.messages.some((message) => message.author === "user" && message.text === continuation),
  );
  const untouched = await page.evaluate(
    async (input) => ({
      main: await window.openbot.agent.readConversation(input.agentId),
      side: await window.openbot.agent.readTask({ agentId: input.agentId, taskId: input.sideId }),
    }),
    { agentId: agent.id, sideId: side.taskId },
  );
  assert.ok(!untouched.main.messages.some((message) => message.author === "user" && message.text === continuation));
  assert.ok(!untouched.side.messages.some((message) => message.author === "user" && message.text === continuation));
  assert.equal((await composer.innerText()).trim(), draft);
  check("Continue is stored only in its branch and leaves its draft intact");
  await page.screenshot({ path: join(out, "branch-card.png") });
  assert.equal(report.pageErrors.length, 0, "The app emitted a renderer error.");
  report.passed = true;
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : "The action-card check failed.");
  const page = browser
    ?.contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("index.html"));
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await stopChild(child);
  await stopChild(keyring);
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(out, "report.json")}\n`);

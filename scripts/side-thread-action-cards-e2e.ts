// Runs the supplied real desktop package on a temporary profile. All account and MCP requests use
// one loopback fixture. No user account, provider, or external sign-in is used.
// CI: xvfb-run -a bun scripts/side-thread-action-cards-e2e.ts dist/linux-unpacked/openbot
// Mac: bun scripts/side-thread-action-cards-e2e.ts '/path/OpenBot.app/Contents/MacOS/OpenBot'
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
} = {
  passed: false,
  checks: [],
  failures: [],
  pageErrors: [],
  oauthRequests: 0,
};
let origin = "";
let child: ChildProcess | undefined;
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
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
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
    if (url.pathname === "/token")
      return json(response, 200, { access_token: "local-fixture-access", token_type: "Bearer", expires_in: 3600 });
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
await writeFile(
  fakeSource,
  `
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.160.1\\n'); process.exit(0); }
const readline = require('node:readline'); const crypto = require('node:crypto');
const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
const config = {config:{mcp_servers:{}},layers:[{name:{type:'user',file:'/local/config.toml',profile:null},version:'1',config:{mcp_servers:{}}}]};
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
  send({method:'item/completed',params:{threadId:p.threadId,turnId:id,item:{id:'answer-'+id,type:'agentMessage',text:'Local fixture continued.',phase:'final_answer'}}});
  send({method:'turn/completed',params:{threadId:p.threadId,turn:{id,status:'completed'}}});return;
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
async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  const ended = await Promise.race([exit.then(() => true), delay(10_000).then(() => false)]);
  if (!ended) {
    child.kill("SIGKILL");
    await exit;
  }
}
try {
  child = spawn(
    resolve(executable),
    [
      `--user-data-dir=${userData}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      ...(process.platform === "linux" ? ["--password-store=basic"] : []),
    ],
    {
      stdio: "ignore",
      env: { ...process.env, OPENBOT_AUTH_API_URL: origin, OPENBOT_CODEX_PATH: fakeCodex },
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
  const signIn = (name: string, title?: string) => {
    const history = title
      ? page.getByRole("region", { name: english("conversation.threads.view.label", { title }), exact: true })
      : page;
    return history.getByRole("button", { name: english("chat.mcpSignIn.signInNamed", { name }), exact: true });
  };
  await signIn(serverName).waitFor();
  check("Main history renders its saved MCP sign-in card");
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
  await openThread(branchTitle);
  await signIn(laterName, branchTitle).waitFor();
  check("Branch history reloads newly saved MCP configs and renders its sign-in card");
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
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await stopChild();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(out, "report.json")}\n`);

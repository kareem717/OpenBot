import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import type { AgentBrowserProfile } from "@openbot/contracts/ipc";
import { redactText } from "@openbot/logging";
import { app, BrowserWindow, session, type WebContents, webContents } from "electron";
import { z } from "zod";
import { BrowserHost } from "../src/backend/browser-host";
import { agentBrowserSessionKey } from "../src/backend/browser-state";
import { runCauseEffect } from "../src/backend/effect-boundary";

const argument = (name: string) => {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};
const fixtureRoot = argument("fixture-root");
const reportPath = argument("report-path");
const runId = argument("run-id");

const cases: string[] = [];
const statePath = join(fixtureRoot, "tabs.json");
const storedStateSchema = z.object({
  version: z.literal(2),
  activeTabId: z.string().nullable(),
  tabs: z.array(
    z.looseObject({
      id: z.string(),
      url: z.string(),
      agentSession: z.string().optional(),
      profile: z.string().optional(),
    }),
  ),
});

const storedValuesSchema = z.object({
  cookie: z.string(),
  local: z.string().nullable(),
  indexed: z.string().nullable(),
});
type StoredValues = z.infer<typeof storedValuesSchema>;

const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<!doctype html><meta charset="utf-8"><title>Fixture</title><p>Fixture</p>');
});

// Agents A and B have a session of their own. Agent C keeps the shared one. Agents D and E share the named
// profile CLIENT_ONE, agent F uses CLIENT_TWO, and agent G names a profile that does not exist.
const CLIENT_ONE = "11111111111111111111111111111111";
const CLIENT_TWO = "22222222222222222222222222222222";
const MISSING_PROFILE = "33333333333333333333333333333333";
const MIGRATED_AGENT = "agent-12345678-1234-4234-8234-123456789abc";
const OLD_AGENT = "bot-12345678-1234-4234-8234-123456789abc";
const profiles = new Set([CLIENT_ONE, CLIENT_TWO]);
const AGENT_PROFILES: Record<string, AgentBrowserProfile> = {
  "agent-a": { kind: "agent" },
  "agent-b": { kind: "agent" },
  "agent-d": { kind: "profile", profileId: CLIENT_ONE },
  "agent-e": { kind: "profile", profileId: CLIENT_ONE },
  "agent-f": { kind: "profile", profileId: CLIENT_TWO },
  "agent-g": { kind: "profile", profileId: MISSING_PROFILE },
};
const hostOptions = {
  browserProfile: (agentId: string): AgentBrowserProfile => AGENT_PROFILES[agentId] ?? { kind: "shared" },
  profileExists: (profileId: string) => profiles.has(profileId),
};

let browser: BrowserHost | undefined;
let currentPhase = "entry";

void main().catch((error) => {
  process.stderr.write(`${redactText(String(error))}\n`);
  app.exit(1);
});

async function main(): Promise<void> {
  app.setPath("userData", join(fixtureRoot, "profile"));
  app.setPath("sessionData", join(fixtureRoot, "session"));
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  phase("entry-start");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address === "object", "Fixture server address missing.");
    const origin = `http://127.0.0.1:${address.port}`;
    const page = (name: string) => `${origin}/${name}`;
    await app.whenReady();
    phase("electron-ready");

    browser = new BrowserHost(newWindow(), join(fixtureRoot, "downloads"), statePath, hostOptions);
    const first = browser;
    const a = await runCauseEffect(first.open(page("a"), "thread-a", "agent-a"));
    const b = await runCauseEffect(first.open(page("b"), "thread-b", "agent-b"));
    const c = await runCauseEffect(first.open(page("c"), "thread-c", "agent-c"));
    const shared = await runCauseEffect(first.open(page("shared")));
    const side = await runCauseEffect(first.open(page("side-a"), "thread-a-side", "agent-a"));
    phase("webmcp-check");
    await checkWebMcp(contentsFor(a.url));
    recordCases("managed-tab-exposes-native-webmcp-without-node-or-app-bridge");
    const appWindow = newWindow();
    await appWindow.loadURL(page("app-control"));
    assert.equal(await appWindow.webContents.executeJavaScript("typeof document.modelContext"), "undefined");
    appWindow.destroy();
    recordCases("webmcp-is-not-enabled-in-app-windows");
    // The last write wins in a session that two tabs share.
    await writeValues(contentsFor(a.url), "a");
    await writeValues(contentsFor(b.url), "b");
    await writeValues(contentsFor(c.url), "c");
    assert.deepEqual(await readValues(contentsFor(a.url)), values("a"));
    assert.deepEqual(await readValues(contentsFor(b.url)), values("b"));
    recordCases("own-sessions-isolate-cookies-storage-indexeddb");
    assert.deepEqual(await readValues(contentsFor(shared.url)), values("c"));
    recordCases("agent-without-setting-uses-shared-session");

    phase("named-profiles");
    const d = await runCauseEffect(first.open(page("d"), "thread-d", "agent-d"));
    const e = await runCauseEffect(first.open(page("e"), "thread-e", "agent-e"));
    const f = await runCauseEffect(first.open(page("f"), "thread-f", "agent-f"));
    await writeValues(contentsFor(d.url), "d");
    // Agent E did not write: it reads what agent D wrote, because they share a profile.
    assert.deepEqual(await readValues(contentsFor(e.url)), values("d"));
    recordCases("named-profile-shared-by-its-agents");
    await writeValues(contentsFor(f.url), "f");
    assert.deepEqual(await readValues(contentsFor(d.url)), values("d"));
    assert.deepEqual(await readValues(contentsFor(shared.url)), values("c"));
    assert.deepEqual(await readValues(contentsFor(a.url)), values("a"));
    recordCases("named-profiles-isolate-sessions");
    const tabCount = first.listTabs().length;
    await assert.rejects(runCauseEffect(first.open(page("g"), "thread-g", "agent-g")));
    assert.equal(first.listTabs().length, tabCount);
    assert(
      !webContents.getAllWebContents().some((item) => item.getURL() === page("g")),
      "A tab of a missing profile loaded its page.",
    );
    recordCases("missing-profile-fails-without-fallback");

    phase("popup");
    const popupUrl = page("popup-a");
    const popupOpened = loadedContents(first, popupUrl);
    await contentsFor(a.url).executeJavaScript(`window.open(${JSON.stringify(popupUrl)}, "_blank"); true`, true);
    const popupContents = await popupOpened;
    assert.deepEqual(await readValues(popupContents), values("a"));
    recordCases("popup-inherits-opener-session");
    await checkWebMcp(popupContents);
    recordCases("popup-exposes-native-webmcp");

    phase("restart");
    await runCauseEffect(first.destroy());
    browser = undefined;
    const saved = storedStateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    const savedSession = (id: string) => saved.tabs.find((tab) => tab.id === id)?.agentSession;
    assert.equal(savedSession(a.id), agentBrowserSessionKey("agent-a"));
    assert.equal(savedSession(b.id), agentBrowserSessionKey("agent-b"));
    assert.equal(savedSession(c.id), undefined);
    assert.equal(savedSession(shared.id), undefined);
    recordCases("saved-tabs-record-their-session");
    const savedProfile = (id: string) => saved.tabs.find((tab) => tab.id === id)?.profile;
    assert.equal(savedProfile(d.id), CLIENT_ONE);
    assert.equal(savedProfile(a.id), undefined);
    // An older build reads only `agentSession`, so a profile tab opens there in a session of its own.
    assert.equal(savedSession(d.id), agentBrowserSessionKey(`browser-profile:${CLIENT_ONE}`));
    recordCases("saved-profile-tabs-record-profile-and-older-build-key");
    // The profile of agent F is deleted while the app is closed.
    profiles.delete(CLIENT_TWO);
    // A tab a released build wrote has no session key, even when its agent now has a session of its own.
    // A key that is not a key drops the tab.
    saved.tabs.push(
      { id: "legacy-tab", url: page("legacy"), ownerThreadId: "thread-a", ownerAgentId: "agent-a" },
      {
        id: "renamed-primary-tab",
        url: page("renamed-primary"),
        ownerThreadId: `openbot-thread-${OLD_AGENT}`,
        ownerAgentId: OLD_AGENT,
      },
      {
        id: "renamed-task-tab",
        url: page("renamed-task"),
        ownerThreadId: "thread-migrated-side",
        ownerAgentId: OLD_AGENT,
      },
      {
        id: "malformed-tab",
        url: page("malformed"),
        ownerThreadId: "thread-a",
        ownerAgentId: "agent-a",
        agentSession: "../openbot-browser",
      },
    );
    await writeFile(statePath, `${JSON.stringify(saved, null, 2)}\n`);

    browser = new BrowserHost(newWindow(), join(fixtureRoot, "downloads"), statePath, hostOptions);
    const second = browser;
    await runCauseEffect(
      second.restore([
        { id: "agent-a", threadId: "thread-a" },
        { id: "agent-b", threadId: "thread-b" },
        { id: MIGRATED_AGENT, threadId: `openbot-thread-${MIGRATED_AGENT}` },
      ]),
    );
    const sideRestored = second.listTabs().find((tab) => tab.id === side.id);
    assert.equal(sideRestored?.ownerThreadId, "thread-a-side", "Restore moved a task tab to the primary chat.");
    assert.equal(sideRestored?.ownerAgentId, "agent-a");
    const toolTabs = async (threadId: string, ownerAgentId = "agent-a") => {
      const result = await runCauseEffect(
        second.handleDynamicTool({
          namespace: "openbot_browser",
          tool: "list_tabs",
          arguments: {},
          ownerAgentId,
          threadId,
          turnId: "restore-check",
          callId: `restore-${threadId}`,
        }),
      );
      assert(result.success);
      return result.contentItems.flatMap((item) => (item.type === "inputText" ? [item.text] : [])).join("\n");
    };
    assert((await toolTabs("thread-a-side")).includes(side.id), "The task cannot find its restored tab.");
    assert(!(await toolTabs("thread-a")).includes(side.id), "The primary chat gained a task's tab.");
    assert(!(await toolTabs("thread-a-side", "agent-b")).includes(side.id), "Another agent gained the task's tab.");
    recordCases("restored-task-tab-keeps-thread-and-tool-access");
    const renamedPrimary = second.listTabs().find((tab) => tab.id === "renamed-primary-tab");
    assert.equal(renamedPrimary?.ownerAgentId, MIGRATED_AGENT);
    assert.equal(renamedPrimary?.ownerThreadId, `openbot-thread-${MIGRATED_AGENT}`);
    const renamedTask = second.listTabs().find((tab) => tab.id === "renamed-task-tab");
    assert.equal(renamedTask?.ownerAgentId, MIGRATED_AGENT);
    assert.equal(renamedTask?.ownerThreadId, "thread-migrated-side");
    assert((await toolTabs("thread-migrated-side", MIGRATED_AGENT)).includes("renamed-task-tab"));
    recordCases("legacy-owner-rename-preserves-primary-and-task-threads");
    const restoredIds = second.listTabs().map((tab) => tab.id);
    assert(restoredIds.includes("legacy-tab"), "The legacy tab was not restored.");
    assert(!restoredIds.includes("malformed-tab"), "The tab with a malformed session key was restored.");
    recordCases("malformed-session-key-drops-tab");
    assert(!restoredIds.includes(f.id), "A tab of a deleted profile was restored.");
    assert(restoredIds.includes(d.id) && restoredIds.includes(e.id), "A tab of a named profile was not restored.");
    recordCases("deleted-profile-drops-tab");
    const reload = async (tabId: string, url: string) => {
      const loaded = loadedContents(second, url);
      await runCauseEffect(second.loadUrl(tabId, url));
      return loaded;
    };
    assert.deepEqual(await readValues(await reload(a.id, page("a-restored"))), values("a"));
    await checkWebMcp(contentsFor(page("a-restored")));
    recordCases("restored-tab-exposes-native-webmcp");
    assert.deepEqual(await readValues(await reload(b.id, page("b-restored"))), values("b"));
    assert.deepEqual(await readValues(await reload(shared.id, page("shared-restored"))), values("c"));
    recordCases("restored-tabs-keep-session-and-data");
    assert.deepEqual(await readValues(await reload(e.id, page("e-restored"))), values("d"));
    recordCases("restored-profile-tab-keeps-data");
    assert.deepEqual(await readValues(await reload("legacy-tab", page("legacy-restored"))), values("c"));
    recordCases("legacy-tab-stays-in-shared-session");

    phase("clear");
    const partitionCookies = (agentId: string) =>
      session.fromPartition(`persist:openbot-browser-agent-${agentBrowserSessionKey(agentId)}`).cookies.get({});
    // A tab that is still open keeps its session, and the call says so.
    await assert.rejects(runCauseEffect(second.clearAgentSession("agent-b")));
    assert.equal((await partitionCookies("agent-b")).length, 1);
    await runCauseEffect(second.close(b.id));
    await runCauseEffect(second.clearAgentSession("agent-b"));
    assert.equal((await partitionCookies("agent-b")).length, 0);
    assert.equal((await partitionCookies("agent-a")).length, 1);
    assert.deepEqual(await readValues(contentsFor(page("shared-restored"))), values("c"));
    recordCases("clear-agent-session-clears-only-that-agent");
    const partitionDirectory = (agentId: string) =>
      join(fixtureRoot, "session", "Partitions", `openbot-browser-agent-${agentBrowserSessionKey(agentId)}`);
    assert(existsSync(partitionDirectory("agent-a")), "The agent partition is not where the host looks for it.");
    await runCauseEffect(second.clearAgentSession("agent-c"));
    assert(!existsSync(partitionDirectory("agent-c")), "Clearing created a partition for an agent without one.");
    recordCases("clear-agent-session-creates-no-partition");
    const clientOne = { kind: "profile", profileId: CLIENT_ONE } as const;
    const profileCookies = () => session.fromPartition(`persist:openbot-browser-profile-${CLIENT_ONE}`).cookies.get({});
    await assert.rejects(runCauseEffect(second.clearTabSession(clientOne)));
    assert.deepEqual([...second.tabIdsInSession(clientOne)].sort(), [d.id, e.id].sort());
    await runCauseEffect(second.close(d.id));
    await runCauseEffect(second.close(e.id));
    await runCauseEffect(second.clearTabSession(clientOne));
    assert.equal((await profileCookies()).length, 0);
    assert.equal((await partitionCookies("agent-a")).length, 1);
    assert.deepEqual(await readValues(contentsFor(page("shared-restored"))), values("c"));
    recordCases("clear-profile-clears-only-that-profile");

    const report = {
      status: "passed",
      runId,
      sourceSha: argument("source-sha"),
      harnessRuntime: argument("harness-runtime"),
      bunVersion: argument("bun-version"),
      electron: process.versions.electron,
      cases,
      scope:
        "Owned hidden native process, temporary profile, and a loopback page. BrowserHost with agent sessions, named browser profiles, popups, a restart from the saved tab file, and session clearing. No provider calls, no agent service, no profile database, no Team API transport.",
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      `${JSON.stringify({ status: "failed", runId, sourceSha: argument("source-sha"), phase: currentPhase, cases, reason: redactText(String(error)) }, null, 2)}\n`,
    );
    process.exitCode = 1;
  } finally {
    phase("native-cleanup");
    if (browser) await runCauseEffect(browser.destroy());
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.exit(Number(process.exitCode ?? 0));
  }
}

function newWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    focusable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
}

async function checkWebMcp(contents: WebContents): Promise<void> {
  // Electron reports OS sandbox state on Mac and Windows. Linux has no metric for it.
  if (process.platform === "darwin" || process.platform === "win32") {
    const metric = app.getAppMetrics().find((item) => item.pid === contents.getOSProcessId());
    assert.equal(metric?.sandboxed, true);
  }
  const result = await contents.executeJavaScript(`(async () => {
    const api = document.modelContext;
    if (!api) return { available: false };
    const controller = new AbortController();
    await api.registerTool({
      name: "openbot_webmcp_fixture",
      description: "Read the isolated fixture's title",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: document.title }] })
    }, { signal: controller.signal });
    const tool = (await api.getTools()).find(item => item.name === "openbot_webmcp_fixture");
    const executed = tool && await api.executeTool(tool, "{}");
    controller.abort();
    const removed = !(await api.getTools()).some(item => item.name === "openbot_webmcp_fixture");
    return { available: true, executed: JSON.parse(executed), removed, node: typeof require, bridge: typeof window.openbot };
  })()`);
  assert.deepEqual(result, {
    available: true,
    executed: { content: [{ type: "text", text: "Fixture" }] },
    removed: true,
    node: "undefined",
    bridge: "undefined",
  });
}

function values(who: string): StoredValues {
  return { cookie: `who=${who}`, local: who, indexed: who };
}

function contentsFor(url: string): WebContents {
  const contents = webContents.getAllWebContents().find((item) => item.getURL() === url);
  assert(contents, `Missing contents for ${url}.`);
  return contents;
}

/** Resolves with the contents of `url` once its page has loaded, whichever tab it is in. */
function loadedContents(host: BrowserHost, url: string): Promise<WebContents> {
  return new Promise((resolve) => {
    const check = () => {
      const contents = webContents.getAllWebContents().find((item) => item.getURL() === url && !item.isLoading());
      if (!contents) return false;
      unsubscribe();
      resolve(contents);
      return true;
    };
    const unsubscribe = host.onChanged(() => void check());
    check();
  });
}

const INDEXED_DB = `new Promise((resolve, reject) => {
  const request = indexedDB.open("fixture", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("values");
  request.onerror = () => reject(request.error);
  request.onsuccess = () => resolve(request.result);
})`;

async function writeValues(contents: WebContents, who: string): Promise<void> {
  await contents.executeJavaScript(`(async () => {
    document.cookie = "who=${who}; max-age=3600; path=/";
    localStorage.setItem("who", "${who}");
    const db = await ${INDEXED_DB};
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("values", "readwrite");
      transaction.objectStore("values").put("${who}", "who");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  })()`);
}

async function readValues(contents: WebContents): Promise<StoredValues> {
  return storedValuesSchema.parse(
    await contents.executeJavaScript(`(async () => {
    const db = await ${INDEXED_DB};
    const indexed = await new Promise((resolve, reject) => {
      const request = db.transaction("values").objectStore("values").get("who");
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return { cookie: document.cookie, local: localStorage.getItem("who"), indexed };
  })()`),
  );
}

function phase(name: string): void {
  currentPhase = name;
  // Machine-readable: phase receipts contain no page data.
  process.stdout.write(`${JSON.stringify({ runId, phase: name, status: "running" })}\n`);
}

function recordCases(...names: string[]): void {
  for (const name of names) {
    cases.push(name);
    process.stdout.write(`${JSON.stringify({ runId, case: name, status: "passed" })}\n`);
  }
}

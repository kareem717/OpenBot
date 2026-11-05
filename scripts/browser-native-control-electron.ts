import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sourceText } from "@openbot/i18n/source";
import type { Effect } from "effect";
import { app, BrowserWindow, systemPreferences, type WebContents, webContents } from "electron";
import * as webSockets from "ws";
import { z } from "zod";
import { BrowserHost } from "../src/backend/browser-host";
import type { BrowserNativeInput } from "../src/backend/browser-native-control";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { DynamicToolCallParams, DynamicToolResult } from "../src/backend/protocol";
import { NativeBrowserControl } from "../src/main/browser-native-control";
import { CUA_DRIVER_VENDOR_CALLS_OFF } from "../src/main/cua-driver-artifact";
import { CuaDriverRuntime } from "../src/main/cua-driver-runtime";
import { createNativeBrowserWindow } from "../src/main/main-window";
import { withoutElectronRuntimeFlags } from "./electron-spawn-env";

function argument(name: string): string {
  const value = process.argv.find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3);
  assert.ok(value, `Missing ${name}.`);
  return value;
}
const fixtureRoot = argument("fixture-root");
const reportPath = argument("report-path");
const runId = argument("run-id");
const driverPath = argument("driver");
const cases: string[] = [];
const marker = "native-fixture-marker";
const observationSchema = z.object({
  nonce: z.uuid(),
  marker: z.literal(marker),
  cookie: z.literal(true),
  clicks: z.number().int(),
  text: z.string(),
  mouseTrusted: z.literal(true),
  inputTrusted: z.literal(true),
  keyTrusted: z.literal(true),
});
let observe: (value: z.infer<typeof observationSchema>) => void = () => {};
const observed = new Promise<z.infer<typeof observationSchema>>((resolve) => {
  observe = resolve;
});
const observers = new Set<(value: z.infer<typeof observationSchema>) => void>();
const server = createServer((request, response) => {
  if (request.url === "/observed" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      try {
        const result = observationSchema.safeParse(JSON.parse(body));
        if (!result.success) {
          response.writeHead(400).end();
          return;
        }
        observe(result.data);
        for (const listener of observers) listener(result.data);
        response.end("ok");
      } catch {
        response.writeHead(400).end();
      }
    });
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>Native fixture</title><style>body{margin:0}button,input{position:absolute;left:40px;width:240px;height:60px;font:20px sans-serif}button{top:40px}input{top:140px}</style><button id="increment">Increment</button><input id="field" aria-label="Fixture input"><script>
  window.fixtureNonce=crypto.randomUUID(); window.fixtureClicks=0; let mouseTrusted=false,inputTrusted=false;
  document.querySelector('#increment').onclick=e=>{ window.fixtureClicks++; mouseTrusted=e.isTrusted; };
  document.querySelector('#field').oninput=e=>{ inputTrusted=e.isTrusted; };
  document.querySelector('#field').onkeydown=e=>{if(e.key!=='Enter')return;e.preventDefault();fetch('/observed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:window.fixtureNonce,marker:sessionStorage.getItem('fixture-marker'),cookie:document.cookie.includes('fixture_cookie=kept'),clicks:window.fixtureClicks,text:e.target.value,mouseTrusted,inputTrusted,keyTrusted:e.isTrusted})});};
  </script>`);
});

function data(result: DynamicToolResult, tool = "browser tool") {
  assert.equal(
    result.success,
    true,
    `${tool}: ${result.contentItems
      .filter((item) => item.type === "inputText")
      .map((item) => item.text)
      .join("\n")}`,
  );
  const item = result.contentItems.find((entry) => entry.type === "inputText");
  assert.ok(item?.type === "inputText");
  return z.record(z.string(), z.json()).parse(JSON.parse(item.text));
}

function assertPagePreferences(page: WebContents): void {
  if (!("getLastWebPreferences" in page) || typeof page.getLastWebPreferences !== "function")
    throw new Error("Native preferences are unavailable.");
  const preferences = z
    .object({
      sandbox: z.literal(true),
      contextIsolation: z.literal(true),
      nodeIntegration: z.literal(false),
      preload: z.string().optional(),
    })
    .parse(page.getLastWebPreferences());
  assert.ok(!preferences.preload, "The native browser surface must have no preload bridge.");
}

async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Native fixture state did not arrive.")), 30_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let browser: BrowserHost | undefined;
let native: NativeBrowserControl | undefined;
let mainWindow: BrowserWindow | undefined;
let nativeWindow: BrowserWindow | undefined;
let contents: WebContents | undefined;
let restoreDebugger: (() => void) | undefined;
let stopPreview: (() => Effect.Effect<void>) | undefined;
let stopNativePreview: (() => Effect.Effect<void>) | undefined;

// Keep the fixture alive while failed-case cleanup writes its report.
app.on("window-all-closed", () => {});
let recorder: Client | undefined;
let recorderTransport: StdioClientTransport | undefined;
const recorderSession = `native-recorder-${randomUUID()}`;
let recording = false;

async function artifactFiles(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await artifactFiles(path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

void main().catch(async (error: unknown) => {
  await writeFile(
    reportPath,
    JSON.stringify(
      { status: "failed", runId, cases, reason: error instanceof Error ? error.message : String(error) },
      null,
      2,
    ),
  );
  process.stderr.write("Native browser fixture failed. See its report.\n");
  app.exit(1);
});

async function main(): Promise<void> {
  app.setPath("userData", join(fixtureRoot, "profile"));
  app.setPath("sessionData", join(fixtureRoot, "session"));
  await app.whenReady();
  if (
    process.platform === "darwin" &&
    (!systemPreferences.isTrustedAccessibilityClient(false) ||
      systemPreferences.getMediaAccessStatus("screen") !== "granted")
  ) {
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          status: "skipped",
          runId,
          cases,
          reason:
            "The isolated fixture lacks existing macOS Accessibility or Screen Recording access. No permission was requested.",
        },
        null,
        2,
      ),
    );
    app.quit();
    return;
  }
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    mainWindow = new BrowserWindow({
      show: false,
      width: 900,
      height: 650,
      frame: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    mainWindow.show();
    app.focus({ steal: true });
    mainWindow.focus();
    const host = new BrowserHost(mainWindow, join(fixtureRoot, "downloads"), join(fixtureRoot, "tabs.json"));
    browser = host;
    const environment = {
      ...CUA_DRIVER_VENDOR_CALLS_OFF,
      XDG_STATE_HOME: join(fixtureRoot, "state"),
      XDG_CONFIG_HOME: join(fixtureRoot, "config"),
      CUA_LOG: "off",
    };
    const driver = new CuaDriverRuntime({
      executable: driverPath,
      endpoint: { kind: "unix-socket", directory: join(fixtureRoot, "driver") },
      supported: true,
      hostBundleId: "app.openbot.native-fixture",
      platform: process.platform,
      displayEnvironment: {},
      stateEnvironment: environment,
    });
    native = new NativeBrowserControl({
      driver,
      ownsDriver: true,
      primaryReady: () => true,
      environment,
      platform: process.platform,
      windowTitle: "Native browser fixture",
      createWindow: (title) => {
        nativeWindow = createNativeBrowserWindow(title);
        return nativeWindow;
      },
    });
    host.setNativeControl(native);
    await runCauseEffect(host.setVisible({ visible: true, bounds: { x: 0, y: 0, width: 900, height: 650 } }));
    const tab = await runCauseEffect(host.open(`${origin}/fixture`, "native-thread", "native-agent"));
    contents = webContents.getAllWebContents().find((entry) => entry.getURL() === tab.url);
    assert.ok(contents);
    const page = contents;
    assertPagePreferences(page);
    assert.equal(
      await page.executeJavaScript("typeof window.openbot + ':' + typeof process + ':' + typeof require"),
      "undefined:undefined:undefined",
    );
    const nonce = z.uuid().parse(await page.executeJavaScript("window.fixtureNonce"));
    let sequence = 0;
    let nativeAllowed = true;
    const call = (tool: string, args: DynamicToolCallParams["arguments"], owner = "native-agent") =>
      runCauseEffect(
        host.handleDynamicTool(
          {
            namespace: "openbot_browser",
            tool,
            arguments: args,
            threadId: "native-thread",
            ownerAgentId: owner,
            turnId: "native-turn",
            callId: `native-${++sequence}`,
          },
          { nativeControlAllowed: () => nativeAllowed },
        ),
      );
    const post = async (url: string, body: string, origin?: string) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
          body,
          signal: AbortSignal.timeout(5_000),
        });
        await response.text();
        return response.status;
      } catch {
        return 0;
      }
    };
    let endpoint = z.string().parse(data(await call("connect_cdp", { tabId: tab.id })).endpoint);
    let cliSession = `native-fixture-${randomUUID()}`;
    const cli = async (...args: string[]) => {
      const child = spawn("bunx", ["agent-browser@0.41.2", "--session", cliSession, "--cdp", endpoint, ...args], {
        env: withoutElectronRuntimeFlags(process.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      const [code] = await deadline(once(child, "exit"));
      assert.equal(code, 0, "The real agent-browser CLI must complete.");
      return output;
    };
    assert.ok((await cli("snapshot", "-i")).includes("Increment"));
    await cli(
      "eval",
      `sessionStorage.setItem('fixture-marker',${JSON.stringify(marker)}); document.cookie='fixture_cookie=kept; Path=/';`,
    );
    await cli("click", "#increment");
    await cli("close");
    cases.push("real CDP client reads and changes the existing tab");
    nativeAllowed = false;
    assert.equal((await call("set_control_mode", { tabId: tab.id, mode: "native" })).success, false);
    nativeAllowed = true;
    assert.equal((await call("set_control_mode", { tabId: tab.id, mode: "native" }, "other-agent")).success, false);
    cases.push("native entry refuses disabled Computer Use and a different owner");
    let firstFrame: (() => void) | undefined;
    const frameReady = new Promise<void>((resolve) => {
      firstFrame = resolve;
    });
    stopPreview = await runCauseEffect(host.startView(tab.id, () => firstFrame?.()));
    await deadline(frameReady);
    assert.equal(page.debugger.isAttached(), true);
    cases.push("a live CDP preview is active before switching");
    const socket = new webSockets.WebSocket(endpoint);
    await deadline(once(socket, "open"));
    const socketClosed = once(socket, "close");
    const nativeMode = data(await call("set_control_mode", { tabId: tab.id, mode: "native" }));
    const nativeInputUrl = z.string().parse(nativeMode.nativeInputUrl);
    await deadline(socketClosed);
    assert.equal(page.debugger.isAttached(), false);
    cases.push("native entry revokes the endpoint and detaches the debugger");
    let nativeAttachments = 0;
    const attach = page.debugger.attach;
    page.debugger.attach = () => {
      nativeAttachments += 1;
      throw new Error("CDP must stay detached during native control.");
    };
    restoreDebugger = () => {
      page.debugger.attach = attach;
    };
    assert.ok((await runCauseEffect(host.screenshot(tab.id))).startsWith("data:image/"));
    let nativeFrame: (() => void) | undefined;
    const nativeReady = new Promise<void>((resolve) => {
      nativeFrame = resolve;
    });
    stopNativePreview = await runCauseEffect(
      host.startView(tab.id, () => nativeFrame?.(), undefined, { viewport: { width: 777, height: 555 } }),
    );
    await deadline(nativeReady);
    assert.equal(page.debugger.isAttached(), false);
    cases.push("passive screenshot and live preview use native capture without CDP");
    const snapshot = async () => {
      let result = await call("native_snapshot", { tabId: tab.id });
      for (
        let read = 1;
        read < 4 &&
        !result.success &&
        result.contentItems.some(
          (item) => item.type === "inputText" && item.text.includes(sourceText("error.backend.browserNativeChanged")),
        );
        read += 1
      )
        result = await call("native_snapshot", { tabId: tab.id });
      const metadata = z
        .object({ snapshotId: z.string(), width: z.number().positive(), height: z.number().positive() })
        .parse(data(result, "native_snapshot"));
      return { result, metadata };
    };
    const initial = await snapshot();
    assert.ok(nativeWindow && !nativeWindow.isDestroyed());
    const nativeFocusListeners = nativeWindow.listenerCount("focus");
    const pageFocusListeners = page.listenerCount("focus");
    assert.ok(["", "about:blank"].includes(nativeWindow.webContents.getURL()));
    assertPagePreferences(nativeWindow.webContents);
    assertPagePreferences(page);
    cases.push("the real native window factory keeps both WebContents sandboxed without preload access");
    const image = initial.result.contentItems.find((entry) => entry.type === "inputImage");
    assert.ok(image?.type === "inputImage");
    await writeFile(
      join(dirname(reportPath), "native-window.png"),
      Buffer.from(image.imageUrl.split(",")[1] ?? "", "base64"),
    );
    cases.push("the OS driver captures the exact owned native window");
    assert.equal(
      (
        await call("native_input", {
          tabId: tab.id,
          snapshotId: initial.metadata.snapshotId,
          input: { kind: "press", key: "Control+Q" },
        })
      ).success,
      false,
    );
    cases.push("an unsupported native key chord is refused");
    assert.ok(nativeWindow && !nativeWindow.isDestroyed());
    const deniedClick = {
      kind: "click",
      x: Math.round((160 * initial.metadata.width) / nativeWindow.getBounds().width),
      y: Math.round((70 * initial.metadata.height) / nativeWindow.getBounds().height),
    };
    nativeAllowed = false;
    assert.equal(
      (await call("native_input", { tabId: tab.id, snapshotId: initial.metadata.snapshotId, input: deniedClick }))
        .success,
      false,
    );
    assert.notEqual(
      await post(nativeInputUrl, JSON.stringify({ snapshotId: initial.metadata.snapshotId, input: deniedClick })),
      200,
    );
    nativeAllowed = true;
    cases.push("revoking Computer Use refuses tool and local HTTP input before native action");
    const input = async (action: BrowserNativeInput | { kind: "click"; logicalX: number; logicalY: number }) => {
      const current = await snapshot();
      assert.ok(nativeWindow && !nativeWindow.isDestroyed());
      const bounds = nativeWindow.getBounds();
      const value =
        action.kind === "click" && "logicalX" in action
          ? {
              kind: "click",
              x: Math.round((action.logicalX * current.metadata.width) / bounds.width),
              y: Math.round((action.logicalY * current.metadata.height) / bounds.height),
            }
          : action;
      data(
        await call("native_input", { tabId: tab.id, snapshotId: current.metadata.snapshotId, input: value }),
        `native_input ${value.kind}`,
      );
      assert.equal(page.debugger.isAttached(), false);
    };
    await input({ kind: "click", logicalX: 160, logicalY: 70 });
    await input({ kind: "click", logicalX: 160, logicalY: 170 });
    await input({ kind: "type", text: "Native text" });
    await input({ kind: "press", key: "Enter" });
    const confirmation = await deadline(observed);
    assert.equal(confirmation.nonce, nonce);
    assert.equal(confirmation.clicks, 2);
    assert.equal(confirmation.text, "Native text");
    assert.equal(
      await page.executeJavaScript("typeof window.openbot + ':' + typeof process + ':' + typeof require"),
      "undefined:undefined:undefined",
    );
    cases.push("native mouse and keyboard reach the same document as trusted events");
    assert.equal(nativeAttachments, 0);
    cases.push("no debugger attachment occurs during the native phase");
    await runCauseEffect(stopNativePreview());
    stopNativePreview = undefined;
    data(await call("set_control_mode", { tabId: tab.id, mode: "cdp" }));
    restoreDebugger();
    restoreDebugger = undefined;
    endpoint = z.string().parse(data(await call("connect_cdp", { tabId: tab.id })).endpoint);
    cliSession = `native-fixture-return-${randomUUID()}`;
    assert.ok(
      (
        await cli(
          "eval",
          `window.fixtureNonce===${JSON.stringify(nonce)} && sessionStorage.getItem('fixture-marker')===${JSON.stringify(marker)} && document.cookie.includes('fixture_cookie=kept') && document.querySelector('#field').value==='Native text'`,
        )
      ).includes("true"),
    );
    await cli("click", "#increment");
    assert.ok((await cli("eval", "window.fixtureClicks===3")).includes("true"));
    await cli("close");
    cases.push("return to CDP keeps document identity, cookies, storage, text, and click state");
    assert.equal(host.listTabs().length, 1);
    assert.equal(host.listTabs()[0]?.id, tab.id);
    cases.push("mode switches keep the same tab and owner");
    const sourceMode = data(await call("set_control_mode", { tabId: tab.id, mode: "native" }));
    const sourceUrl = z.string().parse(sourceMode.secretRegistrationUrl);
    const sourceInputUrl = z.string().parse(sourceMode.nativeInputUrl);
    await input({ kind: "click", logicalX: 160, logicalY: 170 });
    let sourceProof = (await snapshot()).metadata;
    assert.ok(nativeWindow && !nativeWindow.isDestroyed());
    const forbiddenClick = {
      kind: "click",
      x: Math.round((160 * sourceProof.width) / nativeWindow.getBounds().width),
      y: Math.round((70 * sourceProof.height) / nativeWindow.getBounds().height),
    };
    assert.equal(
      await post(
        sourceInputUrl,
        JSON.stringify({ snapshotId: sourceProof.snapshotId, input: forbiddenClick }),
        "https://untrusted.example",
      ),
      404,
    );
    assert.equal(await post(sourceInputUrl, "{broken"), 400);
    assert.equal(await post(sourceInputUrl, JSON.stringify({ snapshotId: randomUUID(), input: forbiddenClick })), 400);
    assert.equal(
      await post(
        sourceInputUrl,
        JSON.stringify({
          snapshotId: sourceProof.snapshotId,
          input: { kind: "type", text: "unregistered fixture value" },
        }),
      ),
      400,
    );
    cases.push("native HTTP refuses Origin, malformed input, stale proof, and unregistered text without OS input");
    const recordingDirectory = join(dirname(reportPath), "recording", runId);
    await mkdir(recordingDirectory, { recursive: true });
    const recorderConfig = driver.mcpServerConfig();
    assert.ok(recorderConfig, "The fixture driver must be running.");
    recorder = new Client({ name: "native-fixture-recorder", version: "1" }, { capabilities: {} });
    recorderTransport = new StdioClientTransport({
      command: recorderConfig.command,
      args: recorderConfig.args,
      env: {
        ...getDefaultEnvironment(),
        ...environment,
        ...Object.fromEntries(recorderConfig.env.map((entry) => [entry.key, entry.value])),
      },
      stderr: "ignore",
    });
    await recorder.connect(recorderTransport);
    const recordingStarted = await recorder.callTool({
      name: "start_recording",
      arguments: {
        output_dir: recordingDirectory,
        record_video: false,
        include_accessibility_tree: false,
        session: recorderSession,
      },
    });
    assert.ok(!recordingStarted.isError, "The fixture recording must start.");
    recording = true;
    const recorderWindows = await recorder.callTool({
      name: "list_windows",
      arguments: { pid: process.pid, on_screen_only: true, session: recorderSession },
    });
    const ownedWindows = z
      .object({ windows: z.array(z.object({ window_id: z.number(), pid: z.number(), title: z.string() })) })
      .parse(recorderWindows.structuredContent)
      .windows.filter((window) => window.pid === process.pid && window.title === nativeWindow?.getTitle());
    assert.equal(ownedWindows.length, 1);
    const ownedWindow = ownedWindows[0];
    assert.ok(ownedWindow);
    const recorderCapture = await recorder.callTool({
      name: "get_window_state",
      arguments: {
        pid: process.pid,
        window_id: ownedWindow.window_id,
        include_accessibility_tree: false,
        max_image_dimension: 1600,
        session: recorderSession,
      },
    });
    const recordingProof = z
      .object({
        capture_id: z.string().min(1),
        screenshot_width: z.number().positive(),
        screenshot_height: z.number().positive(),
        screenshot_frame_valid: z.literal(true),
      })
      .parse(recorderCapture.structuredContent);
    const recordedClick = await recorder.callTool({
      name: "click",
      arguments: {
        pid: process.pid,
        window_id: ownedWindow.window_id,
        capture_id: recordingProof.capture_id,
        x: Math.round((160 * recordingProof.screenshot_width) / nativeWindow.getBounds().width),
        y: Math.round((170 * recordingProof.screenshot_height) / nativeWindow.getBounds().height),
        delivery_mode: "foreground",
        session: recorderSession,
      },
    });
    assert.ok(!recordedClick.isError, "The recorder owner click must succeed.");
    sourceProof = (await snapshot()).metadata;
    const secret = "fixture-native-source-837291";
    assert.equal(await post(sourceUrl, JSON.stringify({ values: [secret] })), 200);
    assert.equal((await call("native_snapshot", { tabId: tab.id })).success, false);
    assert.equal(
      await runCauseEffect(host.screenshot(tab.id)).then(
        () => false,
        () => true,
      ),
      true,
    );
    cases.push("local source registration protects native and passive image capture");
    const sourceObserved = new Promise<z.infer<typeof observationSchema>>((resolve) => {
      const listener = (value: z.infer<typeof observationSchema>) => {
        observers.delete(listener);
        resolve(value);
      };
      observers.add(listener);
    });
    const localInput = async (input: BrowserNativeInput) =>
      assert.equal(await post(sourceInputUrl, JSON.stringify({ snapshotId: sourceProof.snapshotId, input })), 200);
    await localInput({ kind: "press", key: process.platform === "darwin" ? "Meta+A" : "Control+A" });
    await localInput({ kind: "type", text: secret });
    await localInput({ kind: "press", key: "Enter" });
    const sourceConfirmation = await deadline(sourceObserved);
    assert.equal(sourceConfirmation.nonce, nonce);
    assert.equal(sourceConfirmation.clicks, 3);
    assert.equal(sourceConfirmation.text, secret);
    assert.equal(nativeWindow.listenerCount("focus"), nativeFocusListeners);
    assert.equal(page.listenerCount("focus"), pageFocusListeners);
    cases.push("repeated native focus reads release their event listeners");
    cases.push("registered local text reaches the intended field through real OS input");
    const recordingStopped = await recorder.callTool({
      name: "stop_recording",
      arguments: { session: recorderSession },
    });
    assert.ok(!recordingStopped.isError, "The fixture recording must stop.");
    recording = false;
    const recordingFiles = await artifactFiles(recordingDirectory);
    const recordedActions = recordingFiles.filter((path) => path.endsWith("/action.json"));
    assert.equal(recordedActions.length, 1, "Only the recording owner action can produce a turn artifact.");
    assert.ok(
      recordingFiles.some((path) => path.endsWith("/before.png")),
      "The owner action must store an image.",
    );
    for (const path of recordingFiles) {
      const bytes = await readFile(path);
      assert.equal(bytes.includes(Buffer.from(secret)), false, "Recording artifacts must exclude the source text.");
      assert.equal(
        bytes.includes(Buffer.from("fixture-native-source-")),
        false,
        "Recording artifacts must exclude a partial source text prefix.",
      );
    }
    cases.push("a recorder owner writes a real action and image artifact");
    cases.push("a different recording session excludes native actions, source text, and its partial prefix");
    await runCauseEffect(host.takeUserControl(tab.id, { kind: "local" }));
    assert.notEqual(
      await post(sourceInputUrl, JSON.stringify({ snapshotId: sourceProof.snapshotId, input: forbiddenClick })),
      200,
    );
    assert.notEqual(await post(sourceUrl, JSON.stringify({ values: ["new synthetic value"] })), 200);
    assert.equal(host.listTabs()[0]?.id, tab.id);
    host.releaseUserControl(tab.id);
    cases.push("user control revokes native and source endpoints and keeps the tab");
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          status: "passed",
          runId,
          cases,
          nativeAttachments,
          recording: { directory: recordingDirectory, files: recordingFiles.length, actions: recordedActions.length },
          scope:
            "Owned Electron process, profile, CUA daemon, native window, and loopback fixture; no production app or account.",
        },
        null,
        2,
      ),
    );
  } finally {
    restoreDebugger?.();
    if (recording && recorder)
      await recorder.callTool({ name: "stop_recording", arguments: { session: recorderSession } }).catch(() => {});
    await recorder?.close().catch(() => {});
    await recorderTransport?.close().catch(() => {});
    if (stopNativePreview) await runCauseEffect(stopNativePreview());
    if (stopPreview) await runCauseEffect(stopPreview());
    if (browser) await runCauseEffect(browser.destroy());
    if (native) await runCauseEffect(native.destroy());
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  app.quit();
}

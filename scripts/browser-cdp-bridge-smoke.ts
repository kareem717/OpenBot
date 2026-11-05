import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { webContents } from "electron";
import * as webSockets from "ws";
import { z } from "zod";
import type { BrowserHost } from "../src/backend/browser-host";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { DynamicToolCallParams, DynamicToolResult } from "../src/backend/protocol";
import { withoutElectronRuntimeFlags } from "./electron-spawn-env";

const replySchema = z.object({
  id: z.number().optional(),
  result: z.record(z.string(), z.json()).optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

function payload(result: DynamicToolResult) {
  assert.equal(result.success, true, "Browser tool must succeed.");
  const item = result.contentItems.find((entry) => entry.type === "inputText");
  assert.ok(item?.type === "inputText");
  return z.record(z.string(), z.json()).parse(JSON.parse(item.text));
}

function endpointOf(result: DynamicToolResult): string {
  const endpoint = payload(result).endpoint;
  assert.ok(isString(endpoint));
  return endpoint;
}

/** Drive the existing tab with the real agent-browser CLI, then check revocation and isolation. */
export async function runCdpBridgeScenario(browser: BrowserHost, origin: string): Promise<void> {
  const checks: string[] = [];
  const session = `openbot-smoke-${randomUUID()}`;
  const tab = await runCauseEffect(browser.open(`${origin}/cdp-fixture`, "cdp-thread", "cdp-agent"));
  const other = await runCauseEffect(browser.open(`${origin}/cdp-fixture`, "other-thread", "other-agent"));
  const params: DynamicToolCallParams = {
    namespace: "openbot_browser",
    tool: "connect_cdp",
    threadId: "cdp-thread",
    ownerAgentId: "cdp-agent",
    turnId: "cdp-turn",
    callId: "cdp-call",
    arguments: { tabId: tab.id },
  };
  const call = (tool: string) => runCauseEffect(browser.handleDynamicTool({ ...params, tool }));
  let endpoint = "";
  const secret = "fixture-cdp-secret-384729";
  const cli = async (...args: string[]) => {
    const child = spawn("bunx", ["agent-browser@0.41.2", "--session", session, "--cdp", endpoint, ...args], {
      env: withoutElectronRuntimeFlags(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
    });
    child.stderr.on("data", (data) => {
      output += data.toString();
    });
    const [code] = await once(child, "close");
    assert.equal(code, 0, `agent-browser ${args[0]} failed: ${output}`);
    return output;
  };
  try {
    const forbidden = await runCauseEffect(browser.handleDynamicTool({ ...params, arguments: { tabId: other.id } }));
    assert.equal(forbidden.success, false);
    checks.push("another agent cannot obtain the endpoint");
    const connection = payload(await call("connect_cdp"));
    assert.equal(browser.activeTabId, tab.id, "External CDP selects the requested existing tab.");
    endpoint = z.string().parse(connection.endpoint);
    const registrationUrl = z.string().parse(connection.secretRegistrationUrl);
    // Each fixture has its own session; write the marker through the selected CDP endpoint below.
    const socket = new webSockets.WebSocket(endpoint);
    await once(socket, "open");
    let sequence = 0;
    const send = async (method: string, arguments_ = {}, sessionId?: string) => {
      const id = ++sequence;
      const reply = new Promise<z.infer<typeof replySchema>>((resolve) => {
        const receive = (data: webSockets.RawData) => {
          const value = replySchema.parse(JSON.parse(data.toString()));
          if (value.id !== id) return;
          socket.off("message", receive);
          resolve(value);
        };
        socket.on("message", receive);
      });
      socket.send(JSON.stringify({ id, method, params: arguments_, ...(sessionId ? { sessionId } : {}) }));
      return reply;
    };
    const targets = await send("Target.getTargets");
    assert.deepEqual(
      isDynamicRecord(targets.result) && Array.isArray(targets.result.targetInfos)
        ? targets.result.targetInfos.map((entry) => (isDynamicRecord(entry) ? entry.targetId : null))
        : [],
      [tab.id],
    );
    assert.ok((await send("Target.attachToTarget", { targetId: other.id, flatten: true })).error);
    assert.ok((await send("Browser.close")).error);
    assert.ok((await send("Target.createTarget", { url: "about:blank" })).error);
    assert.ok((await send("Runtime.evaluate", { expression: "1" }, "foreign-session")).error);
    for (const url of ["file:///etc/passwd", "openbot-app://index.html", "data:text/html,untrusted"])
      assert.ok((await send("Page.navigate", { url })).error);
    assert.ok((await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.injected=true" })).error);
    checks.push("CDP cannot discover or attach other tabs, create targets, or close the app");
    const attached = await send("Target.attachToTarget", { targetId: tab.id, flatten: true });
    assert.ok(isDynamicRecord(attached.result) && isString(attached.result.sessionId));
    const pageSession = attached.result.sessionId;
    const node = await send(
      "Runtime.evaluate",
      { expression: "typeof process + ':' + typeof window.openbot", returnByValue: true },
      pageSession,
    );
    assert.ok(isDynamicRecord(node.result) && isDynamicRecord(node.result.result));
    assert.equal(node.result.result.value, "undefined:undefined");
    await send(
      "Runtime.evaluate",
      {
        expression:
          "localStorage.setItem('cdp-session', 'kept'); document.cookie='cdp_session=fixture-cdp-cookie-591627; Path=/'; document.title='Existing OpenBot session';",
        returnByValue: true,
      },
      pageSession,
    );
    checks.push("selected page has no Node or OpenBot preload access");
    const registered = await fetch(registrationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [secret, "123456"] }),
    });
    assert.equal(registered.status, 200);
    sequence = 123455;
    assert.equal((await send("Browser.getVersion")).id, 123456);
    assert.ok((await send("Page.captureScreenshot", {}, pageSession)).error);
    const structural = await send(
      "Runtime.evaluate",
      {
        expression:
          "({password:'fixture-unregistered-password',associatedCookies:[{cookie:{value:'fixture-unregistered-cookie'}}],nested:[123456,{otp:123456}]})",
        returnByValue: true,
      },
      pageSession,
    );
    assert.ok(!JSON.stringify(structural).includes("fixture-unregistered"));
    assert.ok(!JSON.stringify(structural).includes("123456"));
    checks.push("local source registration protects images and payload secrets without changing protocol ids");
    socket.close();
    await once(socket, "close");
    const snapshot = await cli("snapshot", "-i");
    assert.ok(snapshot.includes("Increment"), "agent-browser reads the existing page.");
    assert.ok((await cli("eval", "localStorage.getItem('cdp-session')")).includes("kept"));
    assert.ok(
      (await cli("eval", "document.cookie.includes('cdp_session=fixture-cdp-cookie-591627')")).includes("true"),
    );
    const cookies = await cli("eval", "document.cookie");
    assert.ok(!cookies.includes("fixture-cdp-cookie-591627") && cookies.includes("[redacted]"));
    await cli("click", "#increment");
    const count = await cli("get", "text", "#count");
    assert.ok(count.includes("1"), `agent-browser must read the updated fixture count: ${count}`);
    checks.push("real agent-browser preserves page storage and cookies and clicks the existing tab");
    await cli("fill", "#credential", secret);
    const read = await cli("get", "value", "#credential");
    assert.ok(!read.includes(secret) && read.includes("[redacted]"));
    checks.push("registered credentials are redacted from external CDP results");
    await cli("close");
    await call("disconnect_cdp");
    assert.equal(
      browser.listTabs().some((entry) => entry.id === tab.id),
      true,
    );
    assert.equal(
      browser.listTabs().some((entry) => entry.id === other.id),
      true,
    );
    checks.push("disconnect keeps both tabs and their sessions");
    assert.equal((await call("connect_cdp")).success, false);
    await runCauseEffect(browser.loadUrl(tab.id, `${origin}/cdp-fixture?reload=1`));
    endpoint = endpointOf(await call("connect_cdp"));
    const revoked = new webSockets.WebSocket(endpoint);
    await once(revoked, "open");
    const closed = once(revoked, "close");
    await runCauseEffect(browser.takeUserControl(tab.id, { kind: "local" }));
    await closed;
    assert.equal((await call("connect_cdp")).success, false);
    browser.releaseUserControl(tab.id);
    checks.push("user control immediately revokes external access");
    const parent = await runCauseEffect(
      browser.open(`${origin}/cdp-fixture?group=parent`, "group-thread", "group-agent"),
    );
    try {
      const parentContents = webContents.getAllWebContents().find((entry) => entry.getURL() === parent.url);
      assert.ok(parentContents);
      await parentContents.executeJavaScript(`window.open('${origin}/cdp-fixture?group=child'); true`, true);
      const child = browser.listTabs().find((entry) => entry.openerTabId === parent.id);
      assert.ok(child);
      const childContents = webContents.getAllWebContents().find((entry) => entry.getURL() === child.url);
      if (childContents?.isLoadingMainFrame()) await once(childContents, "did-finish-load");
      const groupConnection = payload(
        await runCauseEffect(
          browser.handleDynamicTool({
            ...params,
            threadId: "group-thread",
            ownerAgentId: "group-agent",
            arguments: { tabId: child.id },
          }),
        ),
      );
      const groupRegister = await fetch(z.string().parse(groupConnection.secretRegistrationUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: ["fixture-popup-secret-563728"] }),
      });
      assert.equal(groupRegister.status, 200);
      await assert.rejects(() => runCauseEffect(browser.screenshot(parent.id)));
      await runCauseEffect(browser.loadUrl(parent.id, `${origin}/cdp-fixture?group=parent-reloaded`));
      await runCauseEffect(browser.close(child.id));
      await assert.rejects(() => runCauseEffect(browser.screenshot(parent.id)));
      await runCauseEffect(browser.loadUrl(parent.id, `${origin}/cdp-fixture?group=parent-clean`));
      await runCauseEffect(browser.screenshot(parent.id));
      checks.push(
        "source registration protects the opener after navigation and popup closure until its remaining document is replaced",
      );
    } finally {
      await runCauseEffect(browser.close(parent.id));
    }
    const directory = join(process.cwd(), ".openbot-build", "browser-cdp-bridge");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "smoke.json"), JSON.stringify({ passed: true, checks }, null, 2));
    process.stdout.write("BrowserHost: existing-tab agent-browser connection passed.\n");
  } finally {
    await runCauseEffect(browser.close(tab.id));
    await runCauseEffect(browser.close(other.id));
  }
}

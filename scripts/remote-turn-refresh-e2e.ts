// Drives the desktop Signal socket in a real browser. A lost refresh reply must retry before expiry.
// bun scripts/remote-turn-refresh-e2e.ts [--baseline]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SIGNAL_TURN_REFRESH_INTERVAL_MS } from "@openbot/contracts/signal-protocol/messages";
import { build, serve } from "bun";
import { chromium } from "playwright-core";

const output = resolve(import.meta.dirname, "../.openbot-build/remote-turn-refresh-e2e");
const entry = resolve(import.meta.dirname, "../src/renderer/src/features/team/team-webrtc.ts");
const baseline = process.argv.includes("--baseline");
const bundle = await build({
  entrypoints: [entry],
  target: "browser",
  plugins: baseline
    ? [
        {
          name: "released-source",
          setup(build) {
            build.onLoad({ filter: /\/team-webrtc\.ts$/u }, () => ({
              contents: execFileSync("git", ["show", "HEAD:src/renderer/src/features/team/team-webrtc.ts"], {
                encoding: "utf8",
              }),
              loader: "ts",
            }));
          },
        },
      ]
    : [],
});
assert.ok(bundle.success, "The browser transport did not build.");
const artifact = bundle.outputs[0];
assert.ok(artifact, "The browser transport bundle is missing.");
const code = await artifact.text();
const report: { passed: boolean; baseline: boolean; checks: string[]; refreshes: number; error?: string } = {
  passed: false,
  baseline,
  checks: [],
  refreshes: 0,
};
let answerRefresh = false;
const ready = JSON.stringify({
  type: "ready",
  version: 1,
  connectionId: null,
  resumeToken: "fixture-resume",
  iceServers: [],
});
const service = serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/signal" && server.upgrade(request)) return;
    if (path === "/transport.js") return new Response(code, { headers: { "content-type": "text/javascript" } });
    if (path === "/barrier") return new Response("ready");
    return new Response('<script type="module" src="/transport.js"></script>', {
      headers: { "content-type": "text/html" },
    });
  },
  websocket: {
    message(socket, data) {
      const frame = JSON.parse(String(data));
      if (frame.type === "hello" || frame.type === "resume") socket.send(ready);
      if (frame.type === "turn-refresh") {
        assert.equal(frame.connectionId, null);
        report.refreshes++;
        if (answerRefresh) socket.send(ready);
      }
    },
  },
});
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage();
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${service.port}`);
  await page.evaluate((port) => {
    const channel = new MessageChannel();
    const state = { port: channel.port1, ready: 0, commands: 0 };
    Object.assign(window, { refreshFixture: state });
    channel.port1.onmessage = (event) => {
      if (event.data.type === "bridge-ready")
        channel.port1.postMessage({
          commandId: "connect",
          type: "connect",
          peerId: "fixture-host",
          peer: "host",
          signalUrl: `ws://127.0.0.1:${port}/signal`,
          token: "fixture-ticket",
          iceTransportPolicy: "all",
        });
      if (event.data.type === "signal-ready") state.ready++;
      if (event.data.type === "command-complete") state.commands++;
    };
    channel.port1.start();
    window.postMessage("openbot-team-webrtc-port", "*", [channel.port2]);
  }, service.port);
  await page.waitForFunction("window.refreshFixture.ready === 1");
  await page.clock.runFor(SIGNAL_TURN_REFRESH_INTERVAL_MS);
  await page.evaluate(() => fetch("/barrier"));
  assert.equal(report.refreshes, 1, "The host did not request credentials at the refresh deadline.");
  report.checks.push("The host requests credentials at 45 minutes.");
  answerRefresh = true;
  await page.clock.runFor(30_000);
  await page.waitForFunction("window.refreshFixture.ready === 2", undefined, { timeout: 5_000 });
  assert.equal(report.refreshes, 2);
  report.checks.push("A lost reply retries after 30 seconds, before the old credentials expire.");
  await page.clock.runFor(30_000);
  await page.evaluate(() => fetch("/barrier"));
  assert.equal(report.refreshes, 2, "A successful refresh did not clear the retry.");
  report.checks.push("A successful reply clears the retry.");
  await page.evaluate("window.refreshFixture.port.postMessage({ commandId: 'close', type: 'close', peerId: '' })");
  await page.waitForFunction("window.refreshFixture.commands >= 2");
  await page.clock.runFor(SIGNAL_TURN_REFRESH_INTERVAL_MS);
  await page.evaluate(() => fetch("/barrier"));
  assert.equal(report.refreshes, 2, "A closed host continued to refresh.");
  report.checks.push("Closing the host cancels refresh work.");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await service.stop(true);
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, baseline ? "baseline.json" : "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  // Machine-readable: synthetic service checks only.
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import type { BrowserHost } from "../src/backend/browser-host";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { DynamicToolResult } from "../src/backend/protocol";

const diagnosticSchema = z.object({
  message: z.string(),
  method: z.string().optional(),
  url: z.string().optional(),
  status: z.number().optional(),
  level: z.enum(["debug", "info", "warning", "error"]),
});

/** Check real sign-in clicks against server receipts while the password page stays visible. */
export async function runSubmissionScenario(
  browser: BrowserHost,
  tabId: string,
  registrationUrl: string,
  cli: (...args: string[]) => Promise<string>,
  connection: () => Promise<DynamicToolResult>,
): Promise<string[]> {
  const checks: string[] = [];
  const secret = "fixture-submission-secret-829461";
  let posts = 0;
  let received = Promise.withResolvers<void>();
  let pending: ServerResponse | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    const mode = url.searchParams.get("mode");
    if (url.pathname === "/submit" && request.method === "POST") {
      request.resume();
      posts += 1;
      if (mode === "pending") pending = response;
      else if (mode === "failed") {
        response.writeHead(200, { "Content-Length": "100" });
        response.write("short", () => response.destroy());
      } else if (mode === "redirect") response.writeHead(303, { Location: "/done" }).end();
      else response.writeHead(mode === "rejected" ? 503 : 200).end("received");
      received.resolve();
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.pathname === "/done") {
      response.end("<h1>Response received</h1>");
      return;
    }
    response.end(`<!doctype html><h1>Enter password</h1>
      <form method="post" action="/submit?mode=redirect&token=fixture-query-secret">
        <input id="credential" type="password" name="password" aria-label="Password" required>
        <button id="sign-in" type="submit">Sign in</button>
      </form><output id="state"></output><script>
      const mode = new URLSearchParams(location.search).get('mode');
      document.querySelector('form').addEventListener('submit', event => {
        if (mode === 'redirect') return;
        event.preventDefault();
        if (mode === 'blocked') {
          document.querySelector('#state').textContent = 'No request sent';
          return;
        }
        fetch('/submit?mode=' + mode + '&token=fixture-query-secret', {
          method: 'POST', body: new FormData(event.target)
        }).then(response => response.text()).then(() => {
          document.querySelector('#state').textContent = 'Response received';
        }).catch(() => {
          document.querySelector('#state').textContent = 'Request failed';
        });
      });</script>`);
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    for (const mode of ["redirect", "blocked", "pending", "stalled", "rejected", "failed"]) {
      posts = 0;
      received = Promise.withResolvers<void>();
      await runCauseEffect(browser.loadUrl(tabId, `${origin}/form?mode=${mode}`));
      const registration = await fetch(registrationUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [secret] }),
      });
      assert.equal(registration.status, 200);
      await cli("fill", "#credential", secret);
      // A required password field ensures fill notified Chromium before the real click submits.
      await cli("click", "#sign-in");
      if (mode === "blocked") {
        assert.ok((await cli("get", "text", "#state")).includes("No request sent"));
        assert.equal(posts, 0, "The submit handler ran but did not send a request.");
      } else {
        await received.promise;
        assert.equal(posts, 1, `${mode}: exactly one submission reached the fixture server.`);
      }
      if (mode === "pending") {
        const live = await connection();
        assert.equal(live.success, true);
        const text = live.contentItems.find((entry) => entry.type === "inputText");
        assert.ok(text?.type === "inputText");
        const diagnostics = z.object({ diagnostics: z.array(diagnosticSchema) }).parse(JSON.parse(text.text));
        assert.ok(diagnostics.diagnostics.some((entry) => entry.message === "POST started"));
        assert.ok(!text.text.includes(secret));
        assert.ok(!text.text.includes("fixture-query-secret"));
        const snapshot = await runCauseEffect(browser.snapshot(tabId));
        const writes = snapshot.diagnostics.filter((entry) => entry.method === "POST");
        assert.ok(writes.some((entry) => entry.message === "POST started"));
        assert.ok(writes.every((entry) => entry.status === undefined));
        assert.ok(pending);
        pending.end("received");
        pending = undefined;
        checks.push("a pending sign-in POST has a start diagnostic without a response status");
      }
      if (mode !== "blocked") await cli("wait", "--text", mode === "failed" ? "Request failed" : "Response received");
      const snapshot = await runCauseEffect(browser.snapshot(tabId));
      const writes = snapshot.diagnostics.filter((entry) => entry.method === "POST");
      if (mode === "blocked") assert.deepEqual(writes, []);
      else if (mode === "failed") assert.ok(writes.some((entry) => entry.level === "error"));
      else
        assert.ok(
          writes.some((entry) => entry.status === (mode === "redirect" ? 303 : mode === "rejected" ? 503 : 200)),
        );
      for (const entry of writes) assert.equal(entry.url, `${origin}/submit`);
      const serialized = JSON.stringify(snapshot);
      assert.ok(!serialized.includes(secret));
      assert.ok(!serialized.includes("fixture-query-secret"));
      if (mode !== "redirect") assert.ok(serialized.includes("Enter password"));
      // Successful reads must not crowd out the submission evidence.
      assert.ok(!snapshot.diagnostics.some((entry) => entry.method === "GET" && entry.level === "info"));
      checks.push(`real agent-browser sign-in ${mode}: server receipt and redacted diagnostics agree`);
    }
    return checks;
  } finally {
    pending?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

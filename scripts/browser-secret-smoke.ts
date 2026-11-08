import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserJsonValue } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { webContents } from "electron";
import { type RawData, WebSocket } from "ws";
import { z } from "zod";
import type { BrowserHost } from "../src/backend/browser-host";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { DynamicToolCallParams } from "../src/backend/protocol";
import { bitwardenLoginFixture, runBitwardenBrowserSmoke } from "./bitwarden-browser-smoke";
import { waitForPresentedFrame } from "./browser-smoke-frames";
import { withoutElectronRuntimeFlags } from "./electron-spawn-env";

/** HTTPS is served inside this isolated session. No credentials or network service are used. */
export async function runSecretHandoffScenario(browser: BrowserHost, localOrigin: string): Promise<void> {
  const checks: string[] = [];
  const cliCommands: Array<{ version: string; methods: string[]; helperHashes: string[] }> = [];
  const seed = await runCauseEffect(browser.open(localOrigin, "secret-thread", "secret-agent"));
  const seedContents = webContents.getAllWebContents().find((contents) => contents.getURL() === seed.url);
  if (!seedContents) throw new Error("Missing authentication fixture session.");
  const protocol = seedContents.session.protocol;
  await protocol.handle("https", (request) => {
    const url = new URL(request.url);
    if (
      ![
        "authentication.openbot.test",
        "native-authentication.openbot.test",
        "inspected-authentication.openbot.test",
        "scripted-authentication.openbot.test",
        "called-authentication.openbot.test",
        "mutated-authentication.openbot.test",
        "modified-authentication.openbot.test",
        "cli027-authentication.openbot.test",
        "cli041-authentication.openbot.test",
      ].includes(url.hostname)
    )
      return new Response("Not found", { status: 404 });
    if (url.pathname === "/cli-login")
      return new Response(
        `<!doctype html><title>CLI authentication fixture</title>
        <label>Email<input id="email" type="email"></label>
        <button id="password-choice" onclick="document.querySelector('#login').hidden = false">Use password</button>
        <form id="login" hidden method="post" action="/cli-code" onsubmit="if(document.querySelector('#cli-password').value!=='fixture-cli-password')event.preventDefault()">
        <label>Password<input id="cli-password" type="password" autocomplete="current-password"></label>
        <button id="cli-submit">Sign in</button></form>`,
        { headers: { "Content-Type": "text/html" } },
      );
    if (url.pathname === "/cli-code")
      return new Response(
        `<!doctype html><title>Authenticator fixture</title>
        <form method="post" action="/complete" onsubmit="if(document.querySelector('#cli-code').value!=='739182')event.preventDefault()"><label>Authenticator code<input id="cli-code" inputmode="numeric" autocomplete="one-time-code"></label>
        <button id="cli-verify">Verify</button></form>`,
        { headers: { "Content-Type": "text/html" } },
      );
    if (url.pathname === "/bitwarden-password") return bitwardenLoginFixture("password");
    if (url.pathname === "/bitwarden-authenticator") {
      const field = url.searchParams.get("field");
      return bitwardenLoginFixture("authenticator", field === "totp" || field === "numeric" ? field : "marked");
    }
    if (url.pathname === "/authenticator-fields")
      return new Response(
        `<!doctype html><body>
        <input id="totpPin" type="tel" autocomplete="off">
        <input id="otp-text" type="text">
        <input id="phone" type="tel">
        <input id="numeric" inputmode="numeric">
        <input id="card" inputmode="numeric" aria-label="Authenticator code" autocomplete="cc-csc">
        <input id="otp-password" type="password" inputmode="numeric">
        <input id="notp" inputmode="numeric">
        ${Array.from({ length: 6 }, (_, index) => `<input id="otp-${index}" inputmode="numeric" maxlength="1">`).join("")}
        </body>`,
        { headers: { "Content-Type": "text/html" } },
      );
    const html =
      url.pathname === "/complete"
        ? "<h1>Signed in</h1>"
        : `
      <label>Password<input id="password" type="password"></label>
      <label>Code<input id="code" inputmode="numeric"></label>
      ${
        url.pathname === "/login"
          ? `<form method="get" action="/search"><label>Search password<input id="get-password" name="password" type="password"></label></form>
      <form action="/search"><label>Default password<input id="default-password" name="password" type="password"></label></form>
      <form method="post" action="/search"><label>Override password<input id="override-password" name="password" type="password"></label><button id="override-submit" formmethod="get">Go</button></form>
      <form method="post" action="/session"><label>Post password<input id="post-password" type="password"></label></form>
      <form method="post" action="/session"><label>Masked password<input id="masked-password" type="text" style="-webkit-text-security: disc"></label></form>
      <form action="/search" onsubmit="event.preventDefault(); location.href = '/complete'"><label>Script password<input id="script-password" name="password" type="password"></label></form>
      <form action="/search" onsubmit="event.preventDefault(); setTimeout(() => this.submit())"><label>Checked password<input id="checked-password" name="password" type="password"></label></form>`
          : ""
      }
      <div>${Array.from({ length: 6 }, (_, index) => `<input aria-label="Digit ${index + 1}" id="digit-${index}" maxlength="1">`).join("")}</div>
      <button id="submit" disabled onclick="${url.pathname === "/native-submit" ? "if (!event.isTrusted) return; " : ""}${url.pathname === "/same-page" ? "history.replaceState({}, '', '/complete')" : "location.href='/complete'"}">Sign in</button>
      <script>
      ${url.pathname === "/component" ? `const host = document.createElement('div'); document.body.append(host); const root = host.attachShadow({mode: 'open'}); root.append(...document.querySelectorAll('input'));` : ""}
      document.addEventListener('input', event => { if (${url.pathname === "/component"} && !event.isTrusted) return; ${url.pathname === "/native-submit" ? "setTimeout(() => { document.querySelector('#submit').disabled = false; }, 100);" : "document.querySelector('#submit').disabled = false;"}
      ${["/failed-submit", "/failed-submit-clean"].includes(url.pathname) ? "const button = document.querySelector('#submit'); button.replaceWith(button.cloneNode(true));" : ""}
      ${url.pathname === "/failed-submit-clean" ? "" : "console.error(event.target.value); document.title = event.target.value;"} });</script>`;
    return new Response(`<!doctype html><body>${html}</body>`, { headers: { "Content-Type": "text/html" } });
  });
  await runCauseEffect(browser.close(seed.id));
  try {
    // The real host and Chromium navigation use an injected OS boundary. No OS input is needed.
    browser.setNativeControl({
      ready: () => true,
      open: () => Effect.void,
      close: () => Effect.void,
      snapshot: () => Effect.die(new Error("This fixture must not capture the OS.")),
      input: () => Effect.die(new Error("This fixture must not send OS input.")),
    });
    for (const mode of ["native", "inspected", "scripted", "called", "mutated", "modified"] as const) {
      const native = mode === "native";
      const host = `${mode}-authentication.openbot.test`;
      const tab = await runCauseEffect(browser.open(localOrigin, "secret-thread", "secret-agent"));
      try {
        const connection = await runCauseEffect(
          browser.handleDynamicTool(
            {
              namespace: "openbot_browser",
              tool: native ? "set_control_mode" : "connect_cdp",
              threadId: "secret-thread",
              ownerAgentId: "secret-agent",
              turnId: "secret-turn",
              callId: `origin-${mode}`,
              arguments: { tabId: tab.id, ...(native ? { mode: "native" } : {}) },
            },
            { nativeControlAllowed: () => true },
          ),
        );
        if (!connection.success) throw new Error("The origin fixture could not connect.");
        const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === tab.url);
        if (!contents) throw new Error("Missing origin fixture page.");
        await contents.loadURL(`https://${host}/login`);
        await waitForPresentedFrame(contents);
        let closed: Promise<unknown[]> | undefined;
        if (!native) {
          const item = connection.contentItems.find((entry) => entry.type === "inputText");
          if (item?.type !== "inputText") throw new Error("Missing inspection endpoint.");
          const endpoint = z.object({ endpoint: z.string() }).parse(JSON.parse(item.text)).endpoint;
          const socket = new WebSocket(endpoint);
          await once(socket, "open");
          closed = once(socket, "close");
          let sequence = 0;
          const responseSchema = z.object({
            id: z.number().optional(),
            result: z.json().optional(),
            error: z.json().optional(),
          });
          const send = async (method: string, params: Record<string, BrowserJsonValue> = {}) => {
            const id = ++sequence;
            const answer = new Promise<z.infer<typeof responseSchema>>((resolve) => {
              const receive = (data: RawData) => {
                const response = responseSchema.parse(JSON.parse(data.toString()));
                if (response.id !== id) return;
                socket.off("message", receive);
                resolve(response);
              };
              socket.on("message", receive);
            });
            socket.send(JSON.stringify({ id, method, params }));
            const response = await answer;
            if (response.error) throw new Error(`Inspection fixture command failed: ${method}`);
            return response.result;
          };
          for (const method of [
            "Page.enable",
            "Runtime.enable",
            "Network.enable",
            "DOM.enable",
            "Accessibility.enable",
          ])
            await send(method);
          const tree = await send("Accessibility.getFullAXTree");
          if (!JSON.stringify(tree).includes("Password")) throw new Error("CDP did not read the real login page.");
          if (mode === "scripted")
            await send("Runtime.evaluate", {
              expression: "document.querySelector('#password').addEventListener('input', () => {}); true",
            });
          if (mode === "modified")
            await send("Runtime.evaluate", {
              expression:
                "(function(){ var els = document.querySelectorAll('[data-__ab-ci]'); for (var i = 0; i < els.length; i++) els[i].removeAttribute('data-__ab-ci'); return els.length; })(); document.querySelector('#password').addEventListener('input', () => {});",
            });
          if (mode === "mutated" || mode === "called") {
            const document = z.object({ root: z.object({ nodeId: z.number() }) }).parse(await send("DOM.getDocument"));
            const field = z
              .object({ nodeId: z.number() })
              .parse(await send("DOM.querySelector", { nodeId: document.root.nodeId, selector: "#password" }));
            if (mode === "mutated")
              await send("DOM.setAttributeValue", { nodeId: field.nodeId, name: "oninput", value: "void 0" });
            else {
              const node = z
                .object({ object: z.object({ objectId: z.string() }) })
                .parse(await send("DOM.resolveNode", { nodeId: field.nodeId }));
              await send("Runtime.callFunctionOn", {
                objectId: node.object.objectId,
                functionDeclaration: "function() { this.addEventListener('input', () => {}); }",
              });
            }
          }
        }
        const prepared = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `origin-secret-${mode}`,
            arguments: {
              tabId: tab.id,
              method: "password",
              targets: [{ kind: "css", selector: "#password" }],
              submission: "click",
              submitTarget: { kind: "css", selector: "#submit" },
            },
          }),
        );
        if (closed) await closed;
        const scripted = mode === "scripted" || mode === "called" || mode === "mutated" || mode === "modified";
        if (prepared.agentScriptedOrigin !== scripted)
          throw new Error(`The host classified ${mode} access incorrectly for vault fill.`);
        if (mode === "inspected") {
          if (
            !prepared.vaultFillable ||
            (await runCauseEffect(prepared.submit("fixture-inspected-password", true))) !== "submitted"
          )
            throw new Error("Read-only CDP inspection prevented a saved-password submission.");
          if (!(await runCauseEffect(browser.snapshot(tab.id))).url.endsWith("/complete"))
            throw new Error("Read-only inspected login did not complete.");
        }
        prepared.cancel();
        checks.push(`${mode}: ${scripted ? "script access blocks" : "inspection retains"} automatic vault fill`);
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    for (const version of ["0.27.0", "0.41.2"]) {
      const host = version === "0.27.0" ? "cli027-authentication.openbot.test" : "cli041-authentication.openbot.test";
      const tab = await runCauseEffect(browser.open(`https://${host}/cli-login`, "secret-thread", "secret-agent"));
      const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === tab.url);
      if (!contents) throw new Error("Missing CLI authentication page.");
      const methods = new Set<string>();
      const helperHashes = new Set<string>();
      const originalSend = contents.debugger.sendCommand;
      const cliSession = `openbot-vault-${randomUUID()}`;
      const connection = await runCauseEffect(
        browser.handleDynamicTool({
          namespace: "openbot_browser",
          tool: "connect_cdp",
          threadId: "secret-thread",
          ownerAgentId: "secret-agent",
          turnId: "secret-turn",
          callId: `cli-${version}`,
          arguments: { tabId: tab.id },
        }),
      );
      const item = connection.contentItems.find((entry) => entry.type === "inputText");
      if (!connection.success || item?.type !== "inputText") throw new Error("Missing CLI authentication endpoint.");
      const endpoint = z.object({ endpoint: z.string() }).parse(JSON.parse(item.text)).endpoint;
      const cli = async (...args: string[]) => {
        const child = spawn("bunx", [`agent-browser@${version}`, "--session", cliSession, "--cdp", endpoint, ...args], {
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
        if (code !== 0) throw new Error(`Fixture agent-browser ${version} ${args[0]} failed: ${output}`);
        return output;
      };
      let cliOpen = true;
      try {
        await waitForPresentedFrame(contents);
        contents.debugger.sendCommand = (method, params, sessionId) => {
          methods.add(method);
          const source =
            method === "Runtime.evaluate"
              ? params?.expression
              : method === "Runtime.callFunctionOn"
                ? params?.functionDeclaration
                : undefined;
          if (typeof source === "string") helperHashes.add(createHash("sha256").update(source).digest("hex"));
          return originalSend.call(contents.debugger, method, params, sessionId);
        };
        const snapshot = await cli("snapshot", "-i");
        const email = /textbox "Email" \[ref=(e\d+)\]/u.exec(snapshot)?.[1];
        const password = /button "Use password" \[ref=(e\d+)\]/u.exec(snapshot)?.[1];
        if (!email || !password) throw new Error(`agent-browser ${version} did not find the login methods.`);
        if (version === "0.27.0") {
          await cli("fill", `@${email}`, "fixture@example.test");
          await cli("click", `@${password}`);
          if ((await contents.executeJavaScript("document.querySelector('#email').value")) !== "fixture@example.test")
            throw new Error("The real CLI did not fill the fixture username.");
        } else await contents.executeJavaScript("document.querySelector('#login').hidden = false");
        await cli("close");
        cliOpen = false;
        contents.debugger.sendCommand = originalSend;
        for (const [method, selector, submitTarget, value, path] of [
          ["password", "#cli-password", "#cli-submit", "fixture-cli-password", "/cli-code"],
          ["authenticator", "#cli-code", "#cli-verify", "739182", "/complete"],
        ] as const) {
          await waitForPresentedFrame(contents);
          const handoff = await runCauseEffect(
            browser.prepareSecret({
              namespace: "openbot_browser",
              tool: "submit_secret",
              threadId: "secret-thread",
              ownerAgentId: "secret-agent",
              turnId: "secret-turn",
              callId: `cli-secret-${version}-${method}`,
              arguments: {
                tabId: tab.id,
                method,
                digits: 6,
                targets: [{ kind: "css", selector }],
                submission: "click",
                submitTarget: { kind: "css", selector: submitTarget },
              },
            }),
          );
          if (handoff.agentScriptedOrigin || !handoff.vaultFillable)
            throw new Error(`agent-browser ${version} disabled the ${method} vault fill.`);
          if ((await runCauseEffect(handoff.submit(value, true))) !== "submitted")
            throw new Error(`agent-browser ${version} ${method} submission failed.`);
          const result = await runCauseEffect(browser.snapshot(tab.id));
          if (new URL(result.url).pathname !== path || JSON.stringify(result).includes(value))
            throw new Error("CLI authentication failed or exposed its value.");
        }
        checks.push(`agent-browser ${version}: real snapshot before saved password and authenticator fill`);
      } finally {
        contents.debugger.sendCommand = originalSend;
        if (cliOpen) await cli("close").catch(() => {});
        cliCommands.push({ version, methods: [...methods].sort(), helperHashes: [...helperHashes].sort() });
        const directory = join(process.cwd(), ".openbot-build", "browser-secret");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "cli-commands.json"), JSON.stringify(cliCommands, null, 2));
        await runCauseEffect(browser.close(tab.id));
      }
    }
    await runBitwardenBrowserSmoke(browser);
    checks.push("saved passwords and authenticator codes submit without exposing values");
    for (const [selectors, fillable] of [
      [["#totpPin"], true],
      [["#otp-text"], false],
      [["#phone"], false],
      [["#numeric"], false],
      [["#card"], false],
      [["#otp-password"], false],
      [["#notp"], false],
      [Array.from({ length: 6 }, (_, index) => `#otp-${index}`), true],
      [["#otp-0", "#otp-1", "#otp-2", "#otp-3", "#otp-4", "#numeric"], false],
    ] as const) {
      const tab = await runCauseEffect(
        browser.open("https://authentication.openbot.test/authenticator-fields", "secret-thread", "secret-agent"),
      );
      try {
        const handoff = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `authenticator-${selectors.join()}`,
            arguments: {
              tabId: tab.id,
              method: "authenticator",
              digits: 6,
              targets: selectors.map((selector) => ({ kind: "css", selector })),
              submission: "on_input",
            },
          }),
        );
        handoff.cancel();
        if (handoff.vaultFillable !== fillable)
          throw new Error(`${selectors.join()} was classified wrongly for a vault authenticator code.`);
        checks.push(`${selectors.join()}: vault fill ${fillable ? "allowed" : "refused"}`);
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    for (const path of ["failed-submit", "failed-submit-clean"]) {
      const tab = await runCauseEffect(
        browser.open(`https://authentication.openbot.test/${path}`, "secret-thread", "secret-agent"),
      );
      try {
        const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === tab.url);
        if (!contents) throw new Error("Missing failed submission fixture.");
        await waitForPresentedFrame(contents);
        const handoff = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `failed-${path}`,
            arguments: {
              tabId: tab.id,
              method: "password",
              targets: [{ kind: "css", selector: "#password" }],
              submission: "click",
              submitTarget: { kind: "css", selector: "#submit" },
            },
          }),
        );
        const secret = "fixture-failed-password-729104";
        const failure = await runCauseEffect(handoff.submit(secret, true)).then(
          () => false,
          () => true,
        );
        if (!failure) throw new Error("A replaced submit target must not report success.");
        handoff.cancel();
        await runCauseEffect(browser.beginTakeover(tab.id));
        const snapshot = await runCauseEffect(browser.snapshot(tab.id));
        if (JSON.stringify(snapshot).includes(secret)) throw new Error("Failed submission exposed a value.");
        if ((await contents.executeJavaScript("document.querySelector('#password').value")) !== "")
          throw new Error("Failed submission left a password in its field.");
        const preview = await runCauseEffect(browser.capturePreview(tab.id));
        if (!preview.dataUrl.startsWith("data:image/")) throw new Error("The sanitized takeover has no preview.");
        const evaluate = () =>
          runCauseEffect(
            browser.handleDynamicTool({
              namespace: "openbot_browser",
              tool: "evaluate",
              threadId: "secret-thread",
              ownerAgentId: "secret-agent",
              turnId: "secret-turn",
              callId: `recover-${path}`,
              arguments: { tabId: tab.id, expression: "document.title" },
            }),
          );
        if (path === "failed-submit-clean" && (await evaluate()).success)
          throw new Error("A retained secret document must still block evaluation.");
        await runCauseEffect(browser.reload(tab.id));
        browser.endTakeover(tab.id);
        if (!(await evaluate()).success) throw new Error("Reload did not restore browser access.");
        checks.push(`${path}: failed entry cleans the page and retains manual recovery`);
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    for (const [method, path] of [
      ["password", "login"],
      ["otp", "login"],
      ["authenticator", "login"],
      ["password", "same-page"],
      ["password", "component"],
      ["password", "native-submit"],
    ] as const) {
      const tab = await runCauseEffect(
        browser.open(`https://authentication.openbot.test/${path}`, "secret-thread", "secret-agent"),
      );
      // The submission clicks Sign in; a tab with no frame yet would drop that click.
      const tabContents = webContents.getAllWebContents().find((contents) => contents.getURL() === tab.url);
      if (!tabContents) throw new Error(`Missing ${path} fixture.`);
      await waitForPresentedFrame(tabContents);
      const params: DynamicToolCallParams = {
        namespace: "openbot_browser",
        tool: "submit_secret",
        threadId: "secret-thread",
        ownerAgentId: "secret-agent",
        turnId: "secret-turn",
        callId: `secret-${method}`,
        arguments: {
          tabId: tab.id,
          method,
          targets:
            method === "authenticator"
              ? Array.from({ length: 6 }, (_, index) => ({ kind: "css", selector: `#digit-${index}` }))
              : [{ kind: "css", selector: method === "password" ? "#password" : "#code" }],
          submission: "click",
          submitTarget: { kind: "css", selector: "#submit" },
        },
      };
      try {
        let externalClosed: Promise<unknown[]> | undefined;
        if (method === "password" && path === "login") {
          const connection = await runCauseEffect(
            browser.handleDynamicTool({ ...params, tool: "connect_cdp", arguments: { tabId: tab.id } }),
          );
          const item = connection.contentItems.find((entry) => entry.type === "inputText");
          if (!connection.success || item?.type !== "inputText") throw new Error("Missing secret-revocation endpoint.");
          const endpoint = z.object({ endpoint: z.string() }).parse(JSON.parse(item.text)).endpoint;
          const socket = new WebSocket(endpoint);
          await once(socket, "open");
          externalClosed = once(socket, "close");
        }
        const handoff = await runCauseEffect(browser.prepareSecret(params));
        if (externalClosed) {
          await externalClosed;
          checks.push("secure input revokes an existing external CDP connection");
        }
        // Only a real password field may take a vault password with no card; the digit boxes do not
        // ask for a one-time code, and an email or SMS code never comes from the vault.
        if (handoff.vaultFillable !== (method === "password"))
          throw new Error(`The ${method} fields were classified wrongly for a vault fill.`);
        for (const tool of ["snapshot", "screenshot"]) {
          const capture = await runCauseEffect(
            browser.handleDynamicTool({ ...params, tool, arguments: { tabId: tab.id } }),
          );
          if (capture.success) throw new Error("Agent capture was not blocked while awaiting consent.");
        }
        const result = await runCauseEffect(
          browser.handleDynamicTool({
            ...params,
            tool: "evaluate",
            arguments: { tabId: tab.id, expression: "document.body.innerText" },
          }),
        );
        if (result.success) throw new Error("Authentication evaluation was not blocked.");
        const secret = method === "password" ? "fixture-password-729104" : "729104";
        if ((await runCauseEffect(handoff.submit(secret, false))) !== "submitted")
          throw new Error(`Secure ${method} submission did not navigate.`);
        const snapshot = await runCauseEffect(browser.snapshot(tab.id));
        if (JSON.stringify(snapshot).includes(secret)) throw new Error("Authentication value reached a snapshot.");
        if (!snapshot.url.endsWith("/complete")) throw new Error("Authentication fixture did not complete.");
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    // A field built for something else must not take a vault password: its value can reach a URL. A
    // text field that the page masks as a password, as some bank sign-in pages do, is a password field.
    // A password field may, in any form, but a navigation that carries a vault value is blocked and the
    // user finishes. A form that the page sends with its own script, as many sign-in forms with no
    // method do, still signs in.
    const vaultPassword = "fixture vault+password/518302";
    for (const [selector, fillable, path, outcome] of [
      ["#code", false, undefined, undefined],
      ["#get-password", true, "/login", "takeover"],
      ["#default-password", true, "/login", "takeover"],
      ["#override-password", true, "/login", "takeover"],
      ["#checked-password", true, "/login", "takeover"],
      ["#post-password", true, "/session", "submitted"],
      ["#masked-password", true, "/session", "submitted"],
      ["#script-password", true, "/complete", "submitted"],
    ] as const) {
      const tab = await runCauseEffect(
        browser.open("https://authentication.openbot.test/login", "secret-thread", "secret-agent"),
      );
      try {
        const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === tab.url);
        if (!contents) throw new Error("Missing vault form fixture.");
        await waitForPresentedFrame(contents);
        const handoff = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `vault-${selector}`,
            arguments: {
              tabId: tab.id,
              method: "password",
              targets: [{ kind: "css", selector }],
              submission: selector === "#override-password" ? "click" : "enter",
              ...(selector === "#override-password"
                ? { submitTarget: { kind: "css", selector: "#override-submit" } }
                : {}),
            },
          }),
        );
        if (handoff.vaultFillable !== fillable) {
          handoff.cancel();
          throw new Error(`${selector} was classified wrongly for a vault password.`);
        }
        if (!path) {
          handoff.cancel();
          continue;
        }
        const result = await runCauseEffect(handoff.submit(vaultPassword, true));
        const snapshot = await runCauseEffect(browser.snapshot(tab.id));
        if (new URL(snapshot.url).pathname !== path || result !== outcome)
          throw new Error(
            `A vault password in ${selector} reached ${snapshot.url} (${result}), not ${path} (${outcome}).`,
          );
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    // A target that changes while the secret waits takes no value, also when a page adds a submitter
    // that would send the form as GET.
    for (const [selector, method, change, path] of [
      ["#code", "otp", "document.querySelector('#code').name = 'changed'", "/login"],
      ["#otp-0", "authenticator", "document.querySelector('#otp-0').inputMode = 'text'", "/authenticator-fields"],
      [
        "#post-password",
        "password",
        "const button = document.createElement('button'); button.setAttribute('formmethod', 'get'); document.querySelector('#post-password').form.append(button)",
        "/login",
      ],
    ] as const) {
      const staleTab = await runCauseEffect(
        browser.open(`https://authentication.openbot.test${path}`, "secret-thread", "secret-agent"),
      );
      try {
        const handoff = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `stale-${selector}`,
            arguments: {
              tabId: staleTab.id,
              method,
              targets: [{ kind: "css", selector }],
              submission: "on_input",
            },
          }),
        );
        const contents = webContents.getAllWebContents().find((item) => item.getURL() === staleTab.url);
        if (!contents) throw new Error("Missing stale-target fixture.");
        await contents.executeJavaScript(`${change}; true`);
        let rejected = false;
        try {
          await runCauseEffect(handoff.submit(method === "password" ? "fixture-password-729104" : "729104", false));
        } catch {
          rejected = true;
        }
        if (!rejected) throw new Error(`A changed authentication target ${selector} was accepted.`);
        if ((await contents.executeJavaScript(`document.querySelector('${selector}').value`)) !== "")
          throw new Error(`A changed authentication target ${selector} received a value.`);
        checks.push(`${selector}: changed target receives no secret`);
      } finally {
        await runCauseEffect(browser.close(staleTab.id));
      }
    }
    // A wrong target names itself and the reason, so the agent can correct the request.
    for (const [targets, submitTarget, expected] of [
      [
        [{ kind: "css", selector: "#password" }],
        { kind: "css", selector: "#missing-submit" },
        "submitTarget: No element matches CSS selector: #missing-submit. Correct",
      ],
      [[{ kind: "css", selector: "#submit" }], { kind: "css", selector: "#submit" }, "The field target is not"],
      [[{ kind: "css", selector: "#password" }], undefined, "submission=click needs submitTarget"],
    ] as const) {
      const wrongTab = await runCauseEffect(
        browser.open("https://authentication.openbot.test/login", "secret-thread", "secret-agent"),
      );
      try {
        const failure = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `wrong-${expected}`,
            arguments: {
              tabId: wrongTab.id,
              method: "password",
              targets,
              submission: "click",
              ...(submitTarget ? { submitTarget } : {}),
            },
          }),
        ).then(
          () => undefined,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        if (!failure?.includes(expected))
          throw new Error(`A wrong authentication target gave an unclear error: ${failure ?? "none"}`);
      } finally {
        await runCauseEffect(browser.close(wrongTab.id));
      }
    }
    const directory = join(process.cwd(), ".openbot-build", "browser-secret");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "smoke.json"), JSON.stringify({ passed: true, checks, cliCommands }, null, 2));
    process.stdout.write("BrowserHost: secure password, OTP and authenticator handoff passed.\n");
  } finally {
    protocol.unhandle("https");
  }
}

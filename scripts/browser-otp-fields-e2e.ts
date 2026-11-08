// Drives the real secure-field detector and entry guard in an isolated Electron browser.
// Run: bun scripts/browser-otp-fields-e2e.ts [--baseline]
// Report: .openbot-build/browser-otp-fields-e2e/report.json
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { BrowserCdpEngine } from "../src/backend/browser-cdp";
import { withoutElectronRuntimeFlags } from "./electron-spawn-env";

const ORIGIN = "https://authentication.openbot.test";
const CODE = "953174";
const BASELINE = process.argv.includes("--baseline");
interface FixtureReport {
  passed: boolean;
  baseline: boolean;
  electron: string | undefined;
  checks: string[];
  elapsedMs: number;
  error: string;
}
const PAGE = `<!doctype html><meta charset="utf-8"><title>Authentication fixture</title>
<input id="verificationCode" inputmode="numeric" autocomplete="off" maxlength="6">
<label id="label" for="labelled">Authenticator code</label><input id="labelled" type="tel" autocomplete="off">
<span id="aria-label">Authentication code</span><span id="other-label">Postal code</span>
<input id="aria" aria-labelledby="aria-label" type="tel">
<label>One-time passcode<input id="wrapped" inputmode="numeric"></label>
<input id="placeholder" placeholder="Verification code" inputmode="numeric">
<input id="ius-mfa-token" type="tel" maxlength="6">
<input id="marked" autocomplete="one-time-code">
<input id="cardVerificationCode" inputmode="numeric" maxlength="3">
<input id="cvc" aria-label="Security code" inputmode="numeric" maxlength="3">
<input id="postalVerificationCode" inputmode="numeric">
<input id="ordinary" inputmode="numeric">
<input id="otp-text">
<input id="payment" inputmode="numeric" aria-label="Authenticator code" autocomplete="cc-csc">
<label for="other">Authenticator code</label><input id="other"><input id="unlabelled" inputmode="numeric">
<input id="disabled-otp" type="tel" disabled>
<input id="readonly-otp" type="tel" readonly>
<input id="hidden-otp" type="hidden">
<label for="invisible">Authenticator code</label><input id="invisible" type="tel" style="display:none">
<script>window.trustedInputs = 0; addEventListener('input', event => { if (event.isTrusted) window.trustedInputs++; });</script>`;

if (process.argv.includes("--electron-worker")) await runWorker();
else await runHarness();

async function runHarness(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const output = join(root, ".openbot-build", "browser-otp-fields-e2e");
  await mkdir(output, { recursive: true });
  const fixture = await mkdtemp(join(output, "fixture-"));
  const bundle = join(fixture, "worker.mjs");
  const reportPath = join(output, BASELINE ? "baseline.json" : "report.json");
  try {
    const { build } = await import("bun");
    const built = await build({
      entrypoints: [fileURLToPath(import.meta.url)],
      target: "node",
      format: "esm",
      external: ["electron", "bun"],
      plugins: BASELINE
        ? [
            {
              name: "released-detector",
              setup(builder) {
                builder.onLoad({ filter: /\/src\/backend\/browser-cdp\.ts$/u }, () => ({
                  contents: execFileSync("git", ["show", "HEAD:src/backend/browser-cdp.ts"], { encoding: "utf8" }),
                  loader: "ts",
                }));
              },
            },
          ]
        : [],
    });
    assert.ok(built.success && built.outputs[0], "The browser fixture did not build.");
    await writeFile(bundle, await built.outputs[0].text());
    const electron = join(
      root,
      "node_modules",
      "electron",
      "dist",
      (await readFile(join(root, "node_modules", "electron", "path.txt"), "utf8")).trim(),
    );
    const launcher = join(fixture, "main.cjs");
    await writeFile(launcher, 'void import("./worker.mjs").catch(() => process.exit(1));\n');
    // CI blocks unprivileged user namespaces. This isolated fixture checks behavior, not the OS sandbox.
    const flags = process.platform === "linux" ? ["--no-sandbox"] : [];
    const child = spawn(
      electron,
      [...flags, launcher, "--electron-worker", `--fixture-root=${fixture}`, ...(BASELINE ? ["--baseline"] : [])],
      {
        env: withoutElectronRuntimeFlags(process.env),
        stdio: "ignore",
      },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    }).finally(() => clearTimeout(timer));
    const result: FixtureReport = JSON.parse(await readFile(join(fixture, "worker-report.json"), "utf8"));
    const passed = exitCode === 0 && result.passed === true;
    await writeFile(reportPath, `${JSON.stringify({ ...result, passed, exitCode }, null, 2)}\n`);
    process.stdout.write(`${passed ? "PASS" : "FAIL"}: ${reportPath}\n`);
    if (!passed) process.exitCode = 1;
  } catch (cause) {
    await writeFile(
      reportPath,
      `${JSON.stringify({ passed: false, error: cause instanceof Error ? cause.message : "The browser fixture failed." }, null, 2)}\n`,
    );
    process.stdout.write(`FAIL: ${reportPath}\n`);
    process.exitCode = 1;
  }
}

async function runWorker(): Promise<void> {
  const argument = process.argv.find((value) => value.startsWith("--fixture-root="));
  assert.ok(argument, "The browser fixture directory is missing.");
  const fixture = argument.slice("--fixture-root=".length);
  const profile = join(fixture, "profile");
  await mkdir(profile, { recursive: true });
  const { app, BrowserWindow } = await import("electron");
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.disableHardwareAcceleration();
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await window.webContents.session.protocol.handle(
    "https",
    (request) =>
      new Response(new URL(request.url).origin === ORIGIN ? PAGE : "Not found", {
        headers: { "Content-Type": "text/html" },
      }),
  );
  const engine = new BrowserCdpEngine(window.webContents);
  const checks: string[] = [];
  const report: FixtureReport = {
    passed: false,
    baseline: BASELINE,
    electron: process.versions.electron,
    checks,
    elapsedMs: 0,
    error: "",
  };
  const started = performance.now();
  const load = () => window.loadURL(`${ORIGIN}/fields`);
  const prepare = (selector: string, origin = ORIGIN) =>
    Effect.runPromise(engine.prepareSecret([{ kind: "css", selector }], origin, "on_input"));
  const runPage = (expression: string) => window.webContents.executeJavaScript(expression);
  try {
    await load();
    for (const selector of [
      "#verificationCode",
      "#labelled",
      "#aria",
      "#wrapped",
      "#placeholder",
      "#ius-mfa-token",
      "#marked",
    ]) {
      assert.equal(
        (await prepare(selector)).fields.oneTimeCode,
        true,
        `The code field was not recognized: ${selector}`,
      );
      checks.push(`${selector}: a numeric authentication field is recognized`);
    }
    for (const selector of [
      "#cardVerificationCode",
      "#cvc",
      "#postalVerificationCode",
      "#ordinary",
      "#otp-text",
      "#payment",
      "#unlabelled",
    ]) {
      assert.equal((await prepare(selector)).fields.oneTimeCode, false, `An unrelated field was accepted: ${selector}`);
      checks.push(`${selector}: unrelated or mismatched fields are refused`);
    }
    for (const selector of ["#disabled-otp", "#readonly-otp", "#hidden-otp", "#invisible"]) {
      await assert.rejects(prepare(selector), `An unavailable field was accepted: ${selector}`);
      checks.push(`${selector}: unavailable fields are refused`);
    }
    await assert.rejects(prepare("#verificationCode", "https://other.openbot.test"));
    checks.push("An origin mismatch is refused before entry");

    const ready = await prepare("#verificationCode");
    await Effect.runPromise(ready.enter(CODE));
    assert.equal(
      await runPage(
        `document.querySelector('#verificationCode').value === ${JSON.stringify(CODE)} && window.trustedInputs === 1`,
      ),
      true,
      "Secure entry did not dispatch trusted input to the code field.",
    );
    assert.equal(await Effect.runPromise(ready.clear(CODE)), true, "Secure entry did not clear its fixture value.");
    checks.push("Recognized fields receive trusted input and clear the value");

    for (const [selector, mutation] of [
      ["#labelled", "document.querySelector('#label').textContent = 'Postal code'"],
      ["#aria", "document.querySelector('#aria').setAttribute('aria-labelledby', 'other-label')"],
      ["#placeholder", "document.querySelector('#placeholder').placeholder = 'Search'"],
      ["#verificationCode", "document.querySelector('#verificationCode').inputMode = 'text'"],
      ["#verificationCode", "document.querySelector('#verificationCode').style.display = 'none'"],
    ]) {
      assert.ok(selector && mutation);
      await load();
      const prepared = await prepare(selector);
      await runPage(mutation);
      await assert.rejects(Effect.runPromise(prepared.enter(CODE)), "Changed authentication metadata permitted entry.");
      assert.equal(
        await runPage("[...document.querySelectorAll('input')].every(input => input.value === '')"),
        true,
        "A rejected entry changed a field.",
      );
      checks.push(`${selector}: changed field or label metadata blocks entry`);
    }
    await load();
    const stale = await prepare("#verificationCode");
    await load();
    await assert.rejects(Effect.runPromise(stale.enter(CODE)), "A replacement document permitted stale entry.");
    checks.push("A replacement document blocks stale entry");
    report.passed = true;
  } catch (cause) {
    report.error = cause instanceof Error ? cause.message : "The authentication checks failed.";
  } finally {
    report.elapsedMs = performance.now() - started;
    await writeFile(join(fixture, "worker-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await Effect.runPromise(engine.destroy());
    window.destroy();
    app.exit(report.passed ? 0 : 1);
  }
}

// Runs cookie rotation through the real logging code in an isolated Electron main process.
// Run: bun scripts/redaction-cookie-load-e2e.ts
// Report: .openbot-build/redaction-cookie-load-e2e/report.json
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOpenBotLogger,
  redactText,
  redactValue,
  registerSecretValue,
  registerSecretValues,
} from "@openbot/logging";
import { Effect } from "effect";
import { TraceFile } from "../src/main/trace-file";
import { withoutElectronRuntimeFlags } from "./electron-spawn-env";

const COOKIE_COUNT = 2_405;
const ROTATED_COOKIES = 512;
const CHILD_TIMEOUT_MS = 25_000;

interface FixtureReport {
  passed: boolean;
  electron: string;
  node: string;
  v8: string;
  cookieCount: number;
  rotatedCookies: number;
  registeredValues: number;
  cookieBytes: number;
  elapsedMs: number;
  maxRssKiB: number;
  checks: string[];
  error?: string;
}

if (process.argv.includes("--electron-worker")) {
  await runWorker();
} else {
  await runHarness();
}

async function runHarness(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const output = join(root, ".openbot-build", "redaction-cookie-load-e2e");
  await mkdir(output, { recursive: true });
  const fixture = await mkdtemp(join(output, "fixture-"));
  const bundle = join(fixture, "worker.mjs");
  const reportPath = join(output, "report.json");
  const started = performance.now();
  let timedOut = false;
  try {
    const { build } = await import("bun");
    const built = await build({
      entrypoints: [fileURLToPath(import.meta.url)],
      target: "node",
      format: "esm",
      external: ["electron", "bun"],
    });
    assert.ok(built.success && built.outputs[0], "The Electron fixture did not build.");
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
    // CI blocks unprivileged user namespaces. This isolated fixture checks behavior, not OS sandboxing.
    const flags = process.platform === "linux" ? ["--no-sandbox"] : [];
    const child = spawn(electron, [...flags, launcher, "--electron-worker", `--fixture-root=${fixture}`], {
      env: withoutElectronRuntimeFlags(process.env),
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    }).finally(() => clearTimeout(timer));
    assert.equal(timedOut, false, "The owned Electron fixture exceeded its deadline.");
    const result: FixtureReport = JSON.parse(await readFile(join(fixture, "worker-report.json"), "utf8"));
    const passed = exitCode === 0 && result.passed === true;
    await writeFile(
      reportPath,
      `${JSON.stringify({ ...result, passed, exitCode, harnessElapsedMs: performance.now() - started }, null, 2)}\n`,
    );
    process.stdout.write(`${passed ? "PASS" : "FAIL"}: ${reportPath}\n`);
    if (!passed) process.exitCode = 1;
  } catch (cause) {
    const report = {
      passed: false,
      timedOut,
      harnessElapsedMs: performance.now() - started,
      error: cause instanceof Error ? cause.message : "The Electron fixture failed.",
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`FAIL: ${reportPath}\n`);
    process.exitCode = 1;
  }
}

async function runWorker(): Promise<void> {
  const argument = process.argv.find((value) => value.startsWith("--fixture-root="));
  assert.ok(argument, "The Electron fixture directory is missing.");
  const fixture = argument.slice("--fixture-root=".length);
  const profile = join(fixture, "profile");
  await mkdir(profile, { recursive: true });
  const { app } = await import("electron");
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.setAppLogsPath(join(profile, "logs"));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const started = performance.now();
  const report: FixtureReport = {
    passed: false,
    electron: process.versions.electron ?? "missing",
    node: process.versions.node,
    v8: process.versions.v8,
    cookieCount: COOKIE_COUNT,
    rotatedCookies: ROTATED_COOKIES,
    registeredValues: 0,
    cookieBytes: 0,
    elapsedMs: 0,
    maxRssKiB: 0,
    checks: [],
  };
  try {
    assert.notEqual(report.electron, "missing", "The fixture must run in Electron.");
    const original = Array.from({ length: COOKIE_COUNT }, (_, index) => cookieValue(index, 0));
    report.cookieBytes = original.reduce((total, value) => total + Buffer.byteLength(value), 0);
    assert.ok(report.cookieBytes >= 330_943, "The fixture must cover the observed VPS cookie volume.");
    const registerCookies = (values: string[]) => {
      registerSecretValues(values.flatMap((value, index) => [value, `fixture_cookie_${index}=${value}`]));
      report.registeredValues += values.length * 2;
    };
    registerCookies(original);
    checkHidden(original);
    report.checks.push("Every original cookie is hidden at the observed VPS volume.");
    const rotated = Array.from({ length: ROTATED_COOKIES }, (_, index) => cookieValue(index, 1));
    registerCookies(rotated);
    checkHidden(original);
    checkHidden(rotated);
    report.checks.push("Cookie rotation keeps both old and current values hidden.");
    const samples = [...original.slice(0, 24), ...rotated.slice(0, 24)];
    checkHidden(samples.flatMap(secretForms));
    report.checks.push("Raw, JSON-escaped and URL-encoded cookie forms stay hidden.");

    const long = `fixture-long-${'a7Qz/"%'.repeat(1_500)}`;
    registerSecretValue(long);
    report.registeredValues++;
    checkHidden(secretForms(long));
    report.checks.push("A literal larger than the compiler budget stays hidden in every form.");

    registerSecretValue("fixture-head88");
    const fillers = Array.from({ length: 65 }, (_, index) => `fixture-cross-batch-${index}-filler99`);
    registerSecretValues(fillers);
    registerSecretValue("Basic fixture-tail99");
    report.registeredValues += fillers.length + 2;
    assert.equal(
      redactText("sent fixture-head88/Basic fixture-tail99 twice"),
      "sent [redacted] twice",
      "Overlapping tokens from separate batches must merge.",
    );
    report.checks.push("Matches from separate batches merge before text rules run.");

    const old = original[0];
    const current = rotated[0];
    assert.ok(old && current, "The fixture cookies are missing.");
    const lines: string[] = [];
    const logger = createOpenBotLogger("redaction-cookie-fixture", (line) => lines.push(line), "trace");
    logger.info(`before ${old} after`, { detail: current });
    logger.error(new Error(`before ${current} after`));
    const log = lines.join("\n");
    assert.ok(log.includes("[redacted]"), "The logger must keep a redaction marker.");
    assert.ok(!log.includes(old) && !log.includes(current), "The logger exposed a registered value.");
    await writeFile(join(fixture, "redacted.log"), log);
    const exported = JSON.stringify(redactValue({ detail: [old, current, long] }));
    assert.ok(
      ![old, current, long].some((value) => exported.includes(value)),
      "The export exposed a registered value.",
    );
    await writeFile(join(fixture, "redacted-export.json"), exported);
    const trace = new TraceFile({ directory: join(profile, "logs") });
    trace.record({ kind: "connect", name: `fixture ${old}`, durationMs: 1, outcome: `fixture ${current}` });
    await Effect.runPromise(trace.close());
    const traceText = await readFile(join(profile, "logs", "trace.ndjson"), "utf8");
    assert.ok(
      !traceText.includes(old) && !traceText.includes(current) && traceText.includes("[redacted]"),
      "The trace exposed a registered value.",
    );
    report.checks.push("Real logger, structured export and trace file keep registered values hidden.");
    assert.ok(report.registeredValues <= 6_000, "The fixture exceeded its registration budget.");
    report.passed = true;
  } catch (cause) {
    report.error = cause instanceof Error ? cause.message : "The redaction checks failed.";
  } finally {
    report.elapsedMs = performance.now() - started;
    report.maxRssKiB = process.resourceUsage().maxRSS;
    await writeFile(join(fixture, "worker-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    app.exit(report.passed ? 0 : 1);
  }
}

function cookieValue(index: number, generation: number): string {
  const digest = createHash("sha256").update(`fixture:${index}:${generation}`).digest("hex");
  return `fixture_${digest.repeat(3).slice(0, 132)}/%"\\`;
}

function secretForms(value: string): string[] {
  return [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)];
}

function checkHidden(values: string[]): void {
  assert.equal(
    redactText(`before ${values.join(" ")} after`),
    `before ${values.map(() => "[redacted]").join(" ")} after`,
    "A registered value or its encoded form was exposed.",
  );
}

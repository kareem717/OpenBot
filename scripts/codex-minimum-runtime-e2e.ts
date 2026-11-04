// Drives the real CLI resolver and managed runtime upgrade path on a temporary runtime store.
// An old Codex cannot run deferred MCP, even when a managed download fails. The app upgrade starts
// the pinned replacement and keeps the old files intact. No external network or user CLI is used.
// bun scripts/codex-minimum-runtime-e2e.ts
// Writes .openbot-build/codex-minimum-runtime-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ProviderRuntimeSnapshot } from "@openbot/contracts/ipc";
import { CodexCliError, resolveCodexCli, resolveInstalledFirst } from "../src/backend/cli";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { ProviderRuntimeManager } from "../src/main/provider-runtime-manager";
import { loadAgentRuntimeLock } from "./agent-runtime-lock";

const out = resolve(import.meta.dirname, "../.openbot-build/codex-minimum-runtime-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-codex-minimum-"));
const lock = await loadAgentRuntimeLock(resolve(import.meta.dirname, ".."));
const requiredVersion = "0.166.0";
const oldVersion = "0.160.1";
const requests: string[] = [];
const manager = new ProviderRuntimeManager({
  root: join(root, "managed"),
  isProviderOn: (provider) => provider === "codex",
  availableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
  fetchImpl: async (input) => {
    requests.push(String(input));
    throw new TypeError("The fixture has no external network.");
  },
});
const report: {
  passed: boolean;
  checks: string[];
  pin: string;
  required: string;
  requestedReplacement: boolean;
  error?: string;
} = {
  passed: false,
  checks: [],
  pin: lock.codex.version,
  required: requiredVersion,
  requestedReplacement: false,
};
const pass = (name: string) => {
  report.checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
};
async function cli(path: string, version: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
  return path;
}
function downloadFailure(): Promise<void> {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => {
      manager.off("status", changed);
      reject(new Error("The managed update did not finish."));
    }, 15_000);
    const changed = (snapshot: ProviderRuntimeSnapshot) => {
      if (snapshot.providers.codex.phase !== "download-error") return;
      clearTimeout(timer);
      manager.off("status", changed);
      done();
    };
    manager.on("status", changed);
  });
}
try {
  const pinnedPath = manager.executablePath("codex");
  assert.ok(pinnedPath, "The current platform has a managed Codex target.");
  const oldManaged = await cli(
    join(dirname(dirname(dirname(pinnedPath))), oldVersion, "bin", basename(pinnedPath)),
    oldVersion,
  );
  const oldSystem = await cli(join(root, "system-old", "codex"), oldVersion);
  const supported = await cli(join(root, "managed-new", "codex"), requiredVersion);
  const oldManagedBytes = await readFile(oldManaged);
  await runCauseEffect(manager.initialize());
  assert.equal(lock.codex.version, requiredVersion);
  assert.equal(manager.getStatus().providers.codex.version, oldVersion);
  await assert.rejects(
    runCauseEffect(resolveCodexCli({ bundledExecutable: oldManaged, systemCandidates: [] })),
    (error) => error instanceof CodexCliError && error.code === "outdated" && error.message.includes(requiredVersion),
  );
  await assert.rejects(
    runCauseEffect(resolveCodexCli({ bundledExecutable: null, systemCandidates: [oldSystem] })),
    (error) => error instanceof CodexCliError && error.code === "outdated",
  );
  pass("Codex 0.160.1 is refused from both managed and system locations with the current minimum");
  const selected = await runCauseEffect(
    resolveInstalledFirst((input) => resolveCodexCli({ ...input, systemCandidates: [oldSystem] }), supported, true),
  );
  assert.equal(selected.source, "managed");
  assert.equal(selected.version, requiredVersion);
  assert.deepEqual(await readFile(oldSystem), Buffer.from(`#!/bin/sh\necho "codex-cli ${oldVersion}"\n`));
  pass("A supported managed runtime is selected without changing the user's older CLI");
  const failed = downloadFailure();
  manager.startUpdateChecks({ updateInstalled: true });
  await runCauseEffect(manager.checkForUpdates()).catch(() => undefined);
  await failed;
  report.requestedReplacement = requests.some((url) => url.includes("/releases/download/rust-v0.166.0/codex-package-"));
  assert.equal(report.requestedReplacement, true);
  assert.deepEqual(await readFile(oldManaged), oldManagedBytes);
  pass("The app-upgrade path requests the pinned managed replacement and preserves the old install on failure");
  await assert.rejects(
    runCauseEffect(
      resolveCodexCli({ bundledExecutable: manager.executablePath("codex"), systemCandidates: [oldSystem] }),
    ),
    (error) => error instanceof CodexCliError && error.code === "outdated",
  );
  pass("A failed download cannot fall back to an unsupported runtime for deferred MCP");
  const recovered = await runCauseEffect(
    resolveCodexCli({ bundledExecutable: supported, systemCandidates: [oldSystem] }),
  );
  assert.equal(recovered.version, requiredVersion);
  pass("Installing the supported managed replacement restores CLI selection");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "The Codex minimum runtime check failed.";
  process.exitCode = 1;
} finally {
  await runCauseEffect(manager.stop());
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(out, "report.json")}\n`);
if (report.error) process.stdout.write(`${report.error}\n`);

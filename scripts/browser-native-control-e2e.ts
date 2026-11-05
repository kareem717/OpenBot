import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { cuaDriverInstallRoot, cuaDriverTarget, loadCuaDriverLock } from "./cua-driver-lock";
import { withoutElectronRuntimeFlags } from "./electron-spawn-env";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactRoot = join(projectRoot, ".openbot-build/browser-native-control-e2e");
const fixtureRoot = await mkdtemp("/tmp/ob-native-");
const reportPath = join(artifactRoot, "report.json");
const runId = randomUUID();
let manager: ReturnType<typeof spawn> | undefined;

async function run(command: string, args: string[], environment = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: withoutElectronRuntimeFlags(environment),
      stdio: "inherit",
    });
    let expired = false;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const limit = setTimeout(() => {
      expired = true;
      child.kill("SIGTERM");
      forceStop = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, 180_000);
    child.once("error", (error) => {
      clearTimeout(limit);
      if (forceStop) clearTimeout(forceStop);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(limit);
      if (forceStop) clearTimeout(forceStop);
      if (expired || code !== 0) reject(new Error(`Native fixture process failed (${code ?? signal}).`));
      else resolve();
    });
  });
}

try {
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(reportPath, JSON.stringify({ status: "running", runId }, null, 2));
  assert.ok(process.platform === "linux" || process.platform === "darwin", "Native fixture needs Linux X11 or macOS.");
  if (process.platform === "linux") {
    assert.ok(process.env.DISPLAY, "Run the fixture under its own Xvfb display.");
    assert.equal(process.env.OPENBOT_NATIVE_ISOLATED_DISPLAY, "1", "The fixture needs an explicitly isolated display.");
    manager = spawn("openbox", ["--sm-disable"], {
      env: {
        ...withoutElectronRuntimeFlags(process.env),
        XDG_CONFIG_HOME: join(fixtureRoot, "window-config"),
        XDG_CACHE_HOME: join(fixtureRoot, "window-cache"),
      },
      stdio: "ignore",
    });
    manager.on("error", () => {
      /* The fixture reports a missing native window manager through the owned process. */
    });
  }
  const target = cuaDriverTarget();
  const pinned = await loadCuaDriverLock(projectRoot);
  let executable = process.env.OPENBOT_CUA_DRIVER_PATH ?? join(cuaDriverInstallRoot(projectRoot, target), "cua-driver");
  try {
    await access(executable);
  } catch {
    if (process.platform !== "darwin") throw new Error("Install the pinned Linux CUA driver before this fixture.");
    executable = `/Applications/OpenBot.app/Contents/Resources/cua-driver/darwin/${process.arch}/cua-driver`;
  }
  const expected = pinned.artifacts[target].files["cua-driver"];
  assert.equal(
    createHash("sha256")
      .update(await readFile(executable))
      .digest("hex"),
    expected,
    "The fixture driver must match the pin.",
  );
  const entry = join(artifactRoot, "fixture.mjs");
  await run(process.execPath, [
    "build",
    join(projectRoot, "scripts/browser-native-control-electron.ts"),
    "--target=node",
    "--format=esm",
    "--external=electron",
    "--external=quickjs-emscripten-core",
    "--external=@jitl/quickjs-wasmfile-release-sync",
    `--outfile=${entry}`,
  ]);
  const environment = { ...process.env };
  delete environment.OPENBOT_AGENT_DISPLAY;
  await run(
    join(projectRoot, "node_modules/.bin/electron"),
    [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      entry,
      `--fixture-root=${fixtureRoot}`,
      `--report-path=${reportPath}`,
      `--run-id=${runId}`,
      `--driver=${executable}`,
    ],
    environment,
  );
  const report = z
    .object({
      status: z.enum(["passed", "skipped"]),
      runId: z.literal(runId),
      cases: z.array(z.string()),
      reason: z.string().optional(),
    })
    .parse(JSON.parse(await readFile(reportPath, "utf8")));
  if (report.status === "skipped") assert.equal(process.platform, "darwin", "Linux CI must prove real native input.");
  else assert.ok(report.cases.length >= 9, "All native-mode cases must complete.");
  // Machine-readable fixture result; all values describe synthetic data and owned processes.
  process.stdout.write(
    `${JSON.stringify({ status: report.status, cases: report.cases.length, reason: report.reason, report: reportPath })}\n`,
  );
} catch (error) {
  const fixtureReport = await readFile(reportPath, "utf8")
    .then((source) => z.record(z.string(), z.json()).parse(JSON.parse(source)))
    .catch(() => null);
  if (fixtureReport?.status !== "failed")
    await writeFile(
      reportPath,
      JSON.stringify(
        { status: "failed", runId, reason: error instanceof Error ? error.message : String(error), fixtureReport },
        null,
        2,
      ),
    );
  throw error;
} finally {
  if (manager?.pid && manager.exitCode === null) {
    await new Promise<void>((resolve) => {
      manager?.once("exit", () => resolve());
      manager?.kill("SIGTERM");
    });
  }
  await rm(fixtureRoot, { recursive: true, force: true });
}

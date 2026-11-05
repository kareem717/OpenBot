// Drives the real private-display launcher with Xvfb and Openbox. It starts no OpenBot profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const output = resolve(import.meta.dirname, "../../.openbot-build/browser-display-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-display-"));
const launcher = resolve(import.meta.dirname, "openbot-hosted-server");
const report: { passed: boolean; checks: string[]; diagnostics: { mode: string; stderr: string }[]; error?: string } = {
  passed: false,
  checks: [],
  diagnostics: [],
};
const observationSchema = z.object({
  wmPid: z.number().int().positive(),
  display: z.string().min(1),
  agentDisplay: z.string().min(1),
  wmDisplay: z.string().min(1),
  refusesMissingMarker: z.literal(1),
  refusesAgentDisplay: z.literal(1),
  refusesExistingManager: z.literal(1),
});

await writeFile(
  join(root, "agent-display.sh"),
  `#!/bin/bash
set -uo pipefail
export OPENBOT_AGENT_DISPLAY=$DISPLAY
xprop -root _NET_SUPPORTING_WM_CHECK _NET_CLIENT_LIST >"$1/agent-before"
xvfb-run -a -f "$XAUTHORITY" bash "$1/browser-display.sh" "$@"
status=$?
xprop -root _NET_SUPPORTING_WM_CHECK _NET_CLIENT_LIST >"$1/agent-after"
exit "$status"
`,
);
await writeFile(
  join(root, "browser-display.sh"),
  `#!/bin/bash
set -uo pipefail
export OPENBOT_PRIVATE_BROWSER_DISPLAY=1
bash "$2" --browser-display "$3" "$1/app.cjs" "$@"
status=$?
xprop -root _NET_SUPPORTING_WM_CHECK >"$1/browser-after"
printf '%s' "$?" >"$1/browser-alive"
exit "$status"
`,
);
await writeFile(
  join(root, "app.cjs"),
  String.raw`const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
const [root,launcher,node,mode]=process.argv.slice(2);
const children=fs.readFileSync('/proc/'+process.ppid+'/task/'+process.ppid+'/children','utf8').trim().split(/\s+/).filter(Boolean).map(Number);
const managers=children.filter(pid=>{try{return fs.readFileSync('/proc/'+pid+'/comm','utf8').trim()==='openbox';}catch{return false;}});
assert.equal(managers.length,1);
const wmPid=managers[0],wmEnv=Object.fromEntries(fs.readFileSync('/proc/'+wmPid+'/environ','utf8').split('\0').filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));
const refusal=env=>cp.spawnSync('bash',[launcher,'--browser-display',node,'-e','process.exit(99)'],{env,stdio:'ignore'}).status;
const result={wmPid,display:process.env.DISPLAY,agentDisplay:process.env.OPENBOT_AGENT_DISPLAY,wmDisplay:wmEnv.DISPLAY,
 refusesMissingMarker:refusal({...process.env,OPENBOT_PRIVATE_BROWSER_DISPLAY:''}),
 refusesAgentDisplay:refusal({...process.env,OPENBOT_PRIVATE_BROWSER_DISPLAY:'1',OPENBOT_AGENT_DISPLAY:process.env.DISPLAY}),
 refusesExistingManager:refusal({...process.env,OPENBOT_PRIVATE_BROWSER_DISPLAY:'1'})};
process.kill(wmPid,0);
fs.writeFileSync(root+'/observation.json',JSON.stringify(result));
if(mode==='exit')process.exit(7);
process.on('SIGTERM',()=>{fs.writeFileSync(root+'/app-stopped','yes');process.exit(0);});
process.kill(process.ppid,'SIGTERM');
setInterval(()=>{},1000);
`,
);

async function run(mode: "exit" | "signal"): Promise<number | null> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      "xvfb-run",
      ["-a", "bash", join(root, "agent-display.sh"), root, launcher, process.execPath, mode],
      {
        env: { ...process.env, XDG_CONFIG_HOME: join(root, "config") },
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    const timeout = setTimeout(() => {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
      reject(new Error("The owned display launcher did not finish."));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      report.diagnostics.push({ mode, stderr });
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      report.diagnostics.push({ mode, stderr });
      resolveRun(code);
    });
  });
}

try {
  assert.equal(process.platform, "linux", "The launcher fixture needs Linux X11.");
  for (const mode of ["exit", "signal"] as const) {
    assert.equal(await run(mode), mode === "exit" ? 7 : 143);
    const observation = observationSchema.parse(JSON.parse(await readFile(join(root, "observation.json"), "utf8")));
    assert.notEqual(observation.display, observation.agentDisplay);
    assert.equal(observation.wmDisplay, observation.display);
    assert.throws(() => process.kill(observation.wmPid, 0), "The launcher must reap its owned window manager.");
    assert.equal(await readFile(join(root, "browser-alive"), "utf8"), "0");
    assert.ok(!(await readFile(join(root, "browser-after"), "utf8")).includes("window id #"));
    assert.equal(await readFile(join(root, "agent-before"), "utf8"), await readFile(join(root, "agent-after"), "utf8"));
    if (mode === "signal") assert.equal(await readFile(join(root, "app-stopped"), "utf8"), "yes");
    report.checks.push(`${mode}: owned manager starts only on the private browser display and stops before Xvfb.`);
  }
  report.checks.push("Missing private marker, the agent display and an existing manager are refused.");
  report.checks.push("The agent display is unchanged; application exit and termination retain their status.");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "The private display check failed.";
  process.exitCode = 1;
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
// Machine-readable fixture status; the report has metadata only.
process.stdout.write(`${JSON.stringify({ passed: report.passed, report: join(output, "report.json") })}\n`);

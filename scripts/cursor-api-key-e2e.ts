// Checks where a Cursor key saved in OpenBot (`cursor-api-key-v1`) reaches the Cursor CLI, through
// the real Cursor driver and ACP client, against a fake `cursor-agent acp` that logs which key it got
// and never the key itself. Cases: a saved key reaches the agent process and the profile process; it
// comes before a `CURSOR_API_KEY` in the host's environment; with no saved key, the host's key stays.
// `bun scripts/cursor-api-key-e2e.ts`. Writes .openbot-build/cursor-api-key-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentClient } from "../src/backend/agent-client";
import type { AgentCliInfo } from "../src/backend/cli";
import { NO_PROVIDER_CREDENTIALS, requireProviderDriver } from "../src/backend/provider-drivers";
import { installFakeAgent, readJsonl, startThread, stopClients } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/cursor-api-key-e2e");
const SAVED = "e2e-cursor-saved-5b1d";
const HOST = "e2e-cursor-host-9c0e";

interface Entry {
  method: string;
  key: string;
}

const root = await mkdtemp(join(tmpdir(), "openbot-cursor-api-key-"));
const report: { passed: boolean; cases: { name: string; key: string }[] } = { passed: false, cases: [] };
const clients: AgentClient[] = [];

/** Starts one client, opens a thread so it sends `initialize`, and reads the key that the process got. */
async function keyOf(name: string, options: { saved: boolean; host: boolean; profile?: boolean }): Promise<string> {
  const folder = join(root, name);
  const workspace = join(folder, "workspace");
  await mkdir(workspace, { recursive: true });
  const log = join(folder, "log.jsonl");
  const executable = join(folder, "cursor-agent");
  await installFakeAgent(executable, "cursor-key", { FAKE_LOG: log, FAKE_SAVED_KEY: SAVED, FAKE_HOST_KEY: HOST });
  if (options.host) process.env.CURSOR_API_KEY = HOST;
  else delete process.env.CURSOR_API_KEY;
  const context = {
    ...NO_PROVIDER_CREDENTIALS,
    apiKey: (id: string) => (options.saved && id === "cursor" ? SAVED : null),
  };
  const cli: AgentCliInfo = { executable, version: "2026.11.05-86047df", source: "managed" };
  const driver = requireProviderDriver("cursor");
  const client = options.profile
    ? driver.createProfileClient?.(cli, 10_000, context)
    : driver.createClient(cli, 10_000, context);
  assert(client, "The Cursor driver has no profile client.");
  clients.push(client);
  client.start();
  await startThread(client, { cwd: workspace });
  const [entry] = await readJsonl<Entry>(log);
  assert(entry, `${name}: the agent process did not start.`);
  report.cases.push({ name, key: entry.key });
  return entry.key;
}

try {
  assert.equal(await keyOf("saved key, host key", { saved: true, host: true }), "saved", "A saved key comes first.");
  assert.equal(await keyOf("saved key only", { saved: true, host: false }), "saved", "A saved key reaches Cursor.");
  assert.equal(await keyOf("host key only", { saved: false, host: true }), "host", "The host's key stays.");
  assert.equal(await keyOf("no key", { saved: false, host: false }), "absent", "No key is invented.");
  assert.equal(
    await keyOf("profile client", { saved: true, host: false, profile: true }),
    "saved",
    "The profile process gets the saved key too.",
  );
  report.passed = true;
} finally {
  await stopClients(clients);
  delete process.env.CURSOR_API_KEY;
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report)}\n`);

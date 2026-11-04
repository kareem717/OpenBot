// Drives the real remote manager/client on a saved server and a loopback compatibility host.
// The transport boundary keeps one connected session; Retry reads the host but emits no new
// connected event. Electron is inert and no account, browser, provider or external host is used.
// bun scripts/remote-server-retry-e2e.ts
// Writes .openbot-build/remote-server-retry-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { plugin } from "bun";
import { Effect } from "effect";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { RemoteWorkflowError } from "../src/main/remote-service-effects";

plugin({
  name: "remote-retry-electron-boundary",
  setup(build) {
    class Inert {}
    build.module("electron", () => ({
      loader: "object",
      exports: {
        app: { getPath: () => tmpdir(), getVersion: () => "0.60.3", isPackaged: false, on: () => undefined },
        BrowserWindow: class extends Inert {
          static getAllWindows() {
            return [];
          }
        },
        MessageChannelMain: Inert,
        Notification: class extends Inert {
          static isSupported() {
            return false;
          }
        },
        clipboard: {},
        desktopCapturer: {},
        dialog: {},
        ipcMain: { handle: () => undefined, removeHandler: () => undefined, on: () => undefined },
        nativeImage: {},
        net: {},
        powerMonitor: { on: () => undefined },
        safeStorage: { isEncryptionAvailable: () => false },
        screen: { getAllDisplays: () => [] },
        session: {},
        shell: { openExternal: async () => undefined },
        systemPreferences: {},
        webContents: { getAllWebContents: () => [] },
      },
    }));
  },
});
const { RemoteServerManager } = await import("../src/main/remote-server-manager");
const { TeamWebRtcClientTransport } = await import("../src/main/team-webrtc-client-transport");
const { TeamWebRtcBridge } = await import("../src/main/team-webrtc-bridge");
const root = await mkdtemp(join(tmpdir(), "openbot-remote-retry-"));
const out = resolve(import.meta.dirname, "../.openbot-build/remote-server-retry-e2e");
const hostId = randomUUID();
let hostCapabilities = ["events-v1", "mcp-servers-v1", "agent-tasks-v1"];
let malformed = false;
let reads = 0;
const host = createServer((request, response) => {
  if (request.url !== "/v1/compatibility") {
    response.writeHead(404).end();
    return;
  }
  reads += 1;
  response.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify(
      malformed
        ? { invalid: true }
        : {
            appVersion: "0.60.3",
            protocol: { minimum: 1, maximum: 9 },
            capabilities: hostCapabilities,
          },
    ),
  );
});
await new Promise<void>((done) => host.listen(0, "127.0.0.1", done));
const address = host.address();
assert.ok(address && typeof address === "object");
const hostOrigin = `http://127.0.0.1:${address.port}`;
const unused = () => Effect.die(new Error("The retry fixture must not start an account or peer connection."));
class ConnectedTransport extends TeamWebRtcClientTransport {
  retries = 0;
  override isConnected() {
    return true;
  }
  override retry(serverId: string) {
    this.retries += 1;
    return this.requestResponse(serverId, "/v1/compatibility").pipe(Effect.asVoid);
  }
  override readonly requestResponse: InstanceType<typeof TeamWebRtcClientTransport>["requestResponse"] = (
    _id,
    path,
    init,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(new URL(path, hostOrigin), { method: init?.method ?? "GET" });
        const body: TeamProtocolV2Json = await response.json();
        return { status: response.status, body };
      },
      catch: (cause) => new RemoteWorkflowError({ cause }),
    });
}
const transport = new ConnectedTransport({
  bridge: new TeamWebRtcBridge(),
  listHosts: unused,
  startSession: unused,
  issueTicket: unused,
  endSession: unused,
  createInvite: unused,
  listInvites: unused,
  previewInvite: unused,
  acceptInvite: unused,
  revokeInvite: unused,
  listMembers: unused,
  updateMember: unused,
  removeMember: unused,
  removeOwnedHost: unused,
  getPrincipalId: () => "local-fixture",
  controlPlaneUrl: hostOrigin,
  downloadHostLogo: unused,
  transferDirectory: root,
});
const path = join(root, "remote-servers.json");
await writeFile(
  path,
  JSON.stringify({
    version: 3,
    activeServerId: hostId,
    servers: [
      {
        id: hostId,
        name: "Retry fixture",
        apiUrl: `webrtc://${hostId}`,
        fingerprint: "fixture",
        username: "fixture@example.test",
        encryptedToken: "",
        remoteDesktopAvailable: false,
        role: "owner",
        transport: "webrtc-v2",
      },
    ],
    hiddenHostIds: [],
    mutedServerIds: [],
    serverNotifications: {},
  }),
);
const manager = new RemoteServerManager(
  path,
  {
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString(),
  },
  { createTeamAuthTicket: unused, getEmail: () => "fixture@example.test" },
  {
    appVersion: "0.60.3",
    webrtcTransport: transport,
    // The saved host remains usable while the account directory is unavailable.
    accountReady: Effect.fail(new RemoteWorkflowError({ cause: new Error("The fixture has no account directory.") })),
  },
);
const report: {
  passed: boolean;
  checks: string[];
  error?: string;
  retries: number;
  compatibilityReads: number;
  connectedEvents: number;
} = {
  passed: false,
  checks: [],
  retries: 0,
  compatibilityReads: 0,
  connectedEvents: 0,
};
transport.on("connected", () => (report.connectedEvents += 1));
const summary = () => {
  const server = manager.list().find((candidate) => candidate.id === hostId);
  assert.ok(server, "The saved server remains in the manager.");
  return server;
};
const pass = (name: string) => {
  report.checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
};
try {
  await runCauseEffect(manager.initialize());
  await runCauseEffect(manager.awaitHostDirectory());
  await runCauseEffect(manager.request(hostId, "/v1/compatibility", (value) => value));
  assert.ok(manager.supportsCapability(hostId, "events-v1"));
  pass("A real compatibility read establishes the saved host's capabilities");
  transport.emit("event", hostId, { type: "host-restart", state: "restarting", version: "0.60.4" });
  const before = reads;
  const retried = await runCauseEffect(manager.retryConnection(hostId));
  assert.equal(retried.state, "online");
  assert.deepEqual(retried.compatibility?.capabilities, hostCapabilities);
  assert.ok(manager.supportsCapability(hostId, "events-v1"));
  assert.ok(manager.supportsCapability(hostId, "mcp-servers-v1"));
  assert.deepEqual(retried.hostRestart, { state: "restarting", version: "0.60.4" });
  assert.ok(reads >= before + 2, "Retry checks the transport and then refreshes the manager's compatibility.");
  assert.equal(report.connectedEvents, 0);
  pass("Retry on the same session returns online with capabilities and host restart state intact");
  hostCapabilities = [...hostCapabilities, "routine-recovery-v1"];
  const sequence = summary().connectionSequence ?? 0;
  await runCauseEffect(manager.retryConnection(hostId));
  assert.ok(manager.supportsCapability(hostId, "routine-recovery-v1"));
  assert.ok((summary().connectionSequence ?? 0) > sequence);
  pass("Another same-session retry refreshes newly advertised features and advances the UI reload key");
  malformed = true;
  await assert.rejects(runCauseEffect(manager.retryConnection(hostId)));
  assert.equal(summary().issue?.code, "protocol_error");
  assert.equal(manager.supportsCapability(hostId, "events-v1"), false);
  pass("Malformed compatibility fails closed instead of leaving features enabled");
  malformed = false;
  await runCauseEffect(manager.retryConnection(hostId));
  assert.equal(summary().state, "online");
  assert.equal(summary().issue, null);
  assert.ok(manager.supportsCapability(hostId, "routine-recovery-v1"));
  assert.equal(report.connectedEvents, 0);
  pass("A later user retry recovers the same session after the host response is repaired");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "The retry regression failed.";
  process.exitCode = 1;
} finally {
  await runCauseEffect(manager.stop());
  host.closeAllConnections();
  await new Promise<void>((done) => host.close(() => done()));
  report.retries = transport.retries;
  report.compatibilityReads = reads;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(out, "report.json")}\n`);
if (report.error) process.stdout.write(`${report.error}\n`);

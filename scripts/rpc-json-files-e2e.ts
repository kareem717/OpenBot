// Runs the real Team API, signed host peer and shared file receiver on a temporary profile.
// A channel page has 2.3 MB of valid tasks. The released peer keeps its 413; the optional peer
// receives every task through the released chunked file channel and existing channel decoder.
// No provider, Signal, account service, browser or human notification is used.
// Run: bun scripts/rpc-json-files-e2e.ts
// Writes .openbot-build/rpc-json-files-e2e/report.json.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChannelTask } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { TEAM_BOOTSTRAP_CAPABILITIES, teamCapabilitiesForProtocol } from "@openbot/contracts/team-protocol";
import { CHANNEL_ROUTES, channelResponse } from "@openbot/contracts/team-protocol/channels-v1";
import {
  decodeRpcJsonFile,
  RPC_JSON_FILE_MAX_BYTES,
  RPC_JSON_FILE_MIME,
  RPC_JSON_FILES_CAPABILITY,
  rpcJsonFileName,
} from "@openbot/contracts/team-protocol/rpc-json-files-v1";
import {
  decodeTeamProtocolV2AuthFrame,
  decodeTeamProtocolV2FileControlFrame,
  decodeTeamProtocolV2RpcFrame,
  encodeTeamProtocolV2FileChunk,
  encodeTeamProtocolV2Frame,
  TEAM_PROTOCOL_V2_MAX_BINARY_FRAME_BYTES,
  TEAM_PROTOCOL_V2_MAX_JSON_FRAME_BYTES,
  type TeamProtocolV2Json,
  teamProtocolV2AuthenticationTranscript,
} from "@openbot/contracts/team-protocol/v2";
import { decodeRpcJsonFileBody } from "@openbot/team-client/rpc-json-file";
import { plugin } from "bun";
import { Effect } from "effect";
import { createRemoteFileReceiver } from "../packages/team-client/src/file-download";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import type { VerifiedRemoteSessionTicket } from "../src/main/central-auth-manager";
import type { TeamApiBrowser } from "../src/main/team-api/dependencies";
import type { TeamWebRtcChannel } from "../src/main/team-webrtc-bridge";

const OUT = resolve(import.meta.dirname, "../.openbot-build/rpc-json-files-e2e");
const APP_VERSION = "0.0.0-e2e";
const DEADLINE_MS = 20_000;
const BODY_TEXT = "Synthetic task data. ".repeat(1800);

plugin({
  name: "rpc-json-files-electron-boundary",
  setup(build) {
    class Inert {}
    build.module("electron", () => ({
      loader: "object",
      exports: {
        app: { getPath: () => tmpdir(), getVersion: () => APP_VERSION, isPackaged: false, on: () => undefined },
        BrowserWindow: Object.assign(class extends Inert {}, { getAllWindows: () => [] }),
        MessageChannelMain: class extends Inert {},
        Notification: Object.assign(class extends Inert {}, { isSupported: () => false }),
        clipboard: {},
        dialog: {},
        ipcMain: { handle: () => undefined, removeHandler: () => undefined, on: () => undefined },
        nativeImage: {},
        net: {},
        powerMonitor: { on: () => undefined },
        safeStorage: { isEncryptionAvailable: () => false },
        screen: {},
        session: {},
        shell: { openExternal: async () => undefined },
        systemPreferences: {},
        webContents: { getAllWebContents: () => [] },
      },
    }));
  },
});

const { TeamApiServer } = await import("../src/main/team-api-server");
const { TeamStore } = await import("../src/main/team-store");
const { TeamWebRtcBridge } = await import("../src/main/team-webrtc-bridge");
const { TeamWebRtcHostPeer } = await import("../src/main/team-webrtc-host-peer");
const { RemoteWorkflowError } = await import("../src/main/remote-service-effects");

const unused = () => Effect.die(new Error("Unexpected browser operation."));
const agentBrowser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
  shareTab: () => undefined,
  unshareThread: () => undefined,
  agentTab: () => null,
};
const teamBrowser: TeamApiBrowser = {
  listTabs: () => [],
  getControlState: () => ({ sessions: [] }),
  open: unused,
  activate: unused,
  navigate: unused,
  reload: unused,
  stop: unused,
  takeUserControl: unused,
  releaseUserControl: () => {},
  releaseUserControlHeldBy: () => {},
  close: unused,
  capturePreview: unused,
  setVisible: unused,
  getDisplayState: () => ({ tabs: [], activeTabId: null }),
  loadUrl: unused,
  isPrivate: () => false,
  startView: unused,
  dispatchViewInput: unused,
  copyViewSelection: unused,
  importSignIn: unused,
};

type ResponseFrame = Extract<ReturnType<typeof decodeTeamProtocolV2RpcFrame>, { type: "response" }>;
function transferHold() {
  return {
    entered: Promise.withResolvers<void>(),
    released: Promise.withResolvers<void>(),
    settled: Promise.withResolvers<void>(),
  };
}
class LoopbackBridge extends TeamWebRtcBridge {
  readonly sent: { channel: TeamWebRtcChannel; data: string | ArrayBuffer }[] = [];
  readonly disconnected: string[] = [];
  readonly waiters = new Set<() => void>();
  cancelOnOpen: string | null = null;
  holdNextBinary: ReturnType<typeof transferHold> | null = null;
  readonly receiver = createRemoteFileReceiver((data) =>
    Effect.sync(() => {
      this.emit("data", this.peerId, "files", data);
    }),
  );
  constructor(readonly peerId: string) {
    super();
  }
  override readonly send = (peerId: string, channel: TeamWebRtcChannel, data: string | ArrayBuffer) =>
    Effect.gen({ self: this }, function* () {
      assert.equal(peerId, this.peerId);
      this.sent.push({ channel, data });
      if (channel === "files") {
        yield* this.receiver.receive(data).pipe(Effect.mapError((cause) => new RemoteWorkflowError({ cause })));
        if (typeof data === "string" && this.cancelOnOpen) {
          const frame = decodeTeamProtocolV2FileControlFrame(data);
          if (frame.type === "file-open" && frame.name === rpcJsonFileName(this.cancelOnOpen)) {
            const requestId = this.cancelOnOpen;
            this.cancelOnOpen = null;
            yield* this.receiver
              .cancelJson(requestId)
              .pipe(Effect.mapError((cause) => new RemoteWorkflowError({ cause })));
          }
        }
        if (typeof data !== "string" && this.holdNextBinary) {
          const hold = this.holdNextBinary;
          this.holdNextBinary = null;
          hold.entered.resolve();
          yield* Effect.promise(() => hold.released.promise).pipe(
            Effect.ensuring(Effect.sync(() => hold.settled.resolve())),
          );
        }
      }
      for (const wake of this.waiters) wake();
    });
  override readonly disconnectPeer = (peerId: string) =>
    Effect.sync(() => {
      this.disconnected.push(peerId);
      this.emit("disconnected", peerId);
      this.receiver.clear();
      for (const wake of this.waiters) wake();
    });
  until<T>(pick: () => T | null): Promise<T> {
    return new Promise((resolveValue) => {
      const check = () => {
        const value = pick();
        if (value === null) return;
        this.waiters.delete(check);
        resolveValue(value);
      };
      this.waiters.add(check);
      check();
    });
  }
  responses(requestId: string): ResponseFrame[] {
    return this.sent.flatMap(({ channel, data }) => {
      if (channel !== "rpc" || typeof data !== "string") return [];
      try {
        const frame = decodeTeamProtocolV2RpcFrame(data);
        return frame.type === "response" && frame.requestId === requestId ? [frame] : [];
      } catch {
        return [];
      }
    });
  }
  response(requestId: string) {
    return this.until(() => this.responses(requestId)[0] ?? null);
  }
}

const root = await mkdtemp(join(tmpdir(), "openbot-rpc-json-files-"));
const userData = join(root, "profile");
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, join(root, "home"), database);
const mailbox = new MailboxStore(userData, store.sharedRoot, database);
const sidebar = new SidebarLayoutStore(join(userData, "sidebar.json"));
const team = new TeamStore(join(userData, "team.json"));
const peers: { peer: InstanceType<typeof TeamWebRtcHostPeer>; bridge: LoopbackBridge }[] = [];
let agents: AgentService | undefined;
let api: InstanceType<typeof TeamApiServer> | undefined;
let apiPort = 0;
let channelReads = 0;
let holdNextRead: ReturnType<typeof transferHold> | null = null;
const transferHolds: ReturnType<typeof transferHold>[] = [];
const fileBytes = Buffer.from("An ordinary attachment remains an ordinary attachment.\n");
// This loopback adapter supplies one ordinary binary response. Channel requests go to the real route.
const adapter = createServer(async (request, response) => {
  try {
    assert.ok(team.authenticate((request.headers.authorization ?? "").replace(/^Bearer /u, "")));
    if (request.url === "/v1/e2e/file") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment; filename=fixture.txt",
      });
      response.end(fileBytes);
      return;
    }
    if (request.url === CHANNEL_ROUTES.read) channelReads += 1;
    const hold = request.url === CHANNEL_ROUTES.read ? holdNextRead : null;
    if (hold) {
      holdNextRead = null;
      response.once("close", () => hold.settled.resolve());
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const upstream = await fetch(`http://127.0.0.1:${apiPort}${request.url}`, {
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(request.headers).flatMap(([name, value]) =>
          typeof value === "string" && name !== "host" && name !== "content-length" ? [[name, value]] : [],
        ),
      ),
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (hold) {
      hold.entered.resolve();
      await hold.released.promise;
    }
    if (response.destroyed) return;
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(body);
  } catch {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "The synthetic HTTP adapter failed." }));
  }
});
const report: { passed: boolean; steps: { name: string; passed: boolean; detail?: unknown; error?: string }[] } = {
  passed: false,
  steps: [],
};
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const detail = await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("The E2E step did not finish.")), DEADLINE_MS);
      }),
    ]);
    report.steps.push({ name, passed: true, detail });
    return detail;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

function result(frame: ResponseFrame) {
  assert.ok("result" in frame && isDynamicRecord(frame.result));
  return frame.result;
}
function request(
  bridge: LoopbackBridge,
  path: string,
  body: TeamProtocolV2Json,
  capabilities: readonly string[],
  requestId = randomUUID(),
) {
  const data = encodeTeamProtocolV2Frame({
    version: 2,
    type: "request",
    requestId,
    operation: "http.request",
    payload: { method: body === null ? "GET" : "POST", path, body, capabilities: [...capabilities] },
  });
  bridge.emit("data", bridge.peerId, "rpc", data);
  return { requestId, data, response: bridge.response(requestId) };
}

try {
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  await runCauseEffect(sidebar.initialize());
  await runCauseEffect(team.initialize());
  const identity = await runCauseEffect(team.configure("RPC JSON fixture", "fixture-owner", "fixture-password-123"));
  const agent = await runCauseEffect(
    store.createAgent({
      name: "Fixture",
      description: "Synthetic transport data.",
      avatarSeed: "fixture",
      avatarHue: null,
    }),
  );
  agents = new AgentService({ store, mailbox, browser: agentBrowser, sidebarLayout: sidebar });
  const channel = await runCauseEffect(
    agents.channels.command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId: randomUUID(),
        draft: {
          name: "Large task page",
          title: "",
          instructions: "",
          members: [{ agentId: agent.id }],
          leadAgentId: agent.id,
        },
      },
      { id: "fixture-owner", name: "Fixture owner" },
    ),
  );
  const tasks: ChannelTask[] = Array.from({ length: 32 }, (_, index) => {
    const id = randomUUID();
    return {
      id,
      channelId: channel.id,
      parentTaskId: null,
      rootTaskId: id,
      ownerAgentId: agent.id,
      requestMessageId: randomUUID(),
      instruction: `${index}:${BODY_TEXT}`,
      attachmentDraftIds: [],
      expectedResult: BODY_TEXT,
      sourceMessageIds: [],
      dependencies: [],
      resources: [],
      state: "completed",
      revision: 1,
      assignmentCount: 0,
      error: null,
    };
  });
  agents.channels.store.update(agents.channels.store.get(channel.id), { tasks });
  api = new TeamApiServer({
    store: team,
    agents,
    mailbox,
    browser: teamBrowser,
    sidebarLayout: sidebar,
    channels: agents.channels,
    appVersion: APP_VERSION,
  });
  apiPort = await Effect.runPromise(api.start());
  await new Promise<void>((resolveListen) => adapter.listen(0, "127.0.0.1", resolveListen));
  const address = adapter.address();
  assert.ok(address && typeof address !== "string");
  const localApiPort = address.port;

  const connection = await step("the real host peer verifies the signed handshake", async () => {
    const keys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const bridge = new LoopbackBridge("fixture-peer");
    const claimsByTicket = new Map<string, VerifiedRemoteSessionTicket>();
    const peer = new TeamWebRtcHostPeer(
      {
        bridge,
        store: team,
        appVersion: APP_VERSION,
        transferDirectory: join(root, "transfers"),
        verifyClientTicket: (presented) => {
          const claims = claimsByTicket.get(presented);
          return claims
            ? Effect.succeed(claims)
            : Effect.fail(new RemoteWorkflowError({ cause: new Error("Invalid synthetic ticket.") }));
        },
      },
      { peerId: bridge.peerId, hostId: identity.serverId, localApiPort },
    );
    peers.push({ peer, bridge });
    async function authenticate(): Promise<void> {
      const sessionId = randomUUID();
      const ticket = `synthetic-ticket-${randomUUID()}`;
      const clientNonce = randomBytes(32).toString("base64url");
      const claims: VerifiedRemoteSessionTicket = {
        sessionId,
        hostId: identity.serverId,
        userId: "fixture-user",
        membershipId: team.getOwnerMemberId() ?? "fixture-owner",
        authEpoch: 1,
        sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        role: "owner",
        clientPublicKey: keys.publicKey,
      };
      claimsByTicket.set(ticket, claims);
      const from = bridge.sent.length;
      await Effect.runPromise(peer.incoming({ ...claims, connectionId: randomUUID() }));
      bridge.receiver.clear();
      bridge.emit("connected", bridge.peerId, {
        localFingerprint: "host-fingerprint",
        remoteFingerprint: "client-fingerprint",
      });
      const transcript = {
        hostId: identity.serverId,
        sessionId,
        ticket,
        clientPublicKey: keys.publicKey,
        clientNonce,
        clientFingerprint: "client-fingerprint",
        hostFingerprint: "host-fingerprint",
      };
      bridge.emit(
        "data",
        bridge.peerId,
        "rpc",
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "auth-init",
          ticket,
          clientPublicKey: keys.publicKey,
          clientNonce,
          signature: sign(
            null,
            Buffer.from(teamProtocolV2AuthenticationTranscript(transcript)),
            keys.privateKey,
          ).toString("base64url"),
        }),
      );
      const ready = await bridge.until(() => {
        for (const sent of bridge.sent.slice(from))
          if (sent.channel === "rpc" && typeof sent.data === "string") {
            try {
              const frame = decodeTeamProtocolV2AuthFrame(sent.data);
              if (frame.type === "auth-ready" && frame.clientNonce === clientNonce) return frame;
            } catch {
              /* Earlier RPC frames belong to the old logical session. */
            }
          }
        return null;
      });
      assert.ok(
        verify(
          null,
          Buffer.from(teamProtocolV2AuthenticationTranscript({ ...transcript, hostNonce: ready.hostNonce })),
          identity.publicKey,
          Buffer.from(ready.signature, "base64url"),
        ),
      );
      bridge.emit(
        "data",
        bridge.peerId,
        "rpc",
        encodeTeamProtocolV2Frame({ version: 2, type: "auth-complete", clientNonce, hostNonce: ready.hostNonce }),
      );
      await bridge.until(() =>
        bridge.sent.slice(from).some((sent) => {
          if (sent.channel !== "rpc" || typeof sent.data !== "string") return false;
          try {
            const frame = decodeTeamProtocolV2AuthFrame(sent.data);
            return frame.type === "auth-confirmed" && frame.clientNonce === clientNonce;
          } catch {
            return false;
          }
        })
          ? true
          : null,
      );
    }
    await authenticate();
    return { bridge, peer, authenticate };
  });
  // Do not put keys, frames, peer objects or fixture task text in the report.
  const handshake = report.steps.at(-1);
  if (handshake) handshake.detail = { authenticated: true };
  const { bridge, peer, authenticate } = connection;
  const capable = teamCapabilitiesForProtocol(9);
  const older = capable.filter((capability) => capability !== RPC_JSON_FILES_CAPABILITY);

  await step("the capability is v9 only and the old client keeps its 413", async () => {
    assert.ok(capable.includes(RPC_JSON_FILES_CAPABILITY));
    assert.ok(!teamCapabilitiesForProtocol(8).includes(RPC_JSON_FILES_CAPABILITY));
    assert.ok(!new Set<string>(TEAM_BOOTSTRAP_CAPABILITIES).has(RPC_JSON_FILES_CAPABILITY));
    const frame = await request(bridge, CHANNEL_ROUTES.read, { channelId: channel.id }, older).response;
    assert.ok("error" in frame);
    assert.equal(frame.error.status, 413);
    assert.equal(frame.error.code, "response_too_large");
    assert.deepEqual(bridge.disconnected, []);
    return { status: frame.error.status, connected: true };
  });

  await step("small JSON stays inline", async () => {
    const frame = await request(bridge, CHANNEL_ROUTES.list, null, capable).response;
    const payload = result(frame);
    assert.equal(payload.status, 200);
    assert.equal(payload.jsonFile, undefined);
    assert.ok(Array.isArray(payload.body));
    return { inline: true };
  });

  await step("a large real channel page arrives in full and duplicate RPCs execute once", async () => {
    const requestId = randomUUID();
    bridge.receiver.expectJson(
      requestId,
      () => {},
      () => {},
    );
    const beforeReads = channelReads;
    const call = request(bridge, CHANNEL_ROUTES.read, { channelId: channel.id }, capable, requestId);
    bridge.emit("data", bridge.peerId, "rpc", call.data);
    const frame = await call.response;
    const payload = result(frame);
    assert.equal(payload.status, 200);
    assert.equal(payload.file, undefined);
    const metadata = decodeRpcJsonFile(payload.jsonFile, requestId);
    assert.ok(metadata.size > TEAM_PROTOCOL_V2_MAX_JSON_FRAME_BYTES);
    const file = await Effect.runPromise(bridge.receiver.takeBytes(metadata.transferId));
    const body = decodeRpcJsonFileBody(file, metadata);
    const decoded = channelResponse(CHANNEL_ROUTES.read, 200, body);
    assert.ok(isDynamicRecord(decoded) && Array.isArray(decoded.tasks));
    const returnedTasks: TeamProtocolV2Json[] = decoded.tasks;
    assert.equal(returnedTasks.length, tasks.length);
    const original = new Map(tasks.map((task) => [task.id, task]));
    for (const task of returnedTasks) {
      assert.ok(isDynamicRecord(task));
      assert.ok(typeof task.id === "string" && original.has(task.id));
      assert.equal(task.instruction, original.get(task.id)?.instruction);
      assert.equal(task.expectedResult, original.get(task.id)?.expectedResult);
    }
    await bridge.until(() => (bridge.responses(requestId).length === 2 ? true : null));
    assert.equal(channelReads - beforeReads, 1);
    await Effect.runPromise(bridge.receiver.cancelJson(requestId));
    assert.deepEqual(bridge.disconnected, []);
    return { bytes: metadata.size, tasks: returnedTasks.length, httpExecutions: channelReads - beforeReads };
  });

  await step("cancelling a real host transfer leaves the connection usable", async () => {
    const requestId = randomUUID();
    bridge.receiver.expectJson(
      requestId,
      () => {},
      () => {},
    );
    bridge.cancelOnOpen = requestId;
    const frame = await request(bridge, CHANNEL_ROUTES.read, { channelId: channel.id }, capable, requestId).response;
    assert.ok("error" in frame);
    assert.equal(peer.hasActiveTransfers(), false);
    assert.equal(result(await request(bridge, CHANNEL_ROUTES.list, null, capable).response).status, 200);
    assert.deepEqual(bridge.disconnected, []);
    return { cancelled: true, connected: true };
  });

  await step("ordinary file responses keep their existing metadata and bytes", async () => {
    const payload = result(await request(bridge, "/v1/e2e/file", null, capable).response);
    assert.equal(payload.jsonFile, undefined);
    assert.ok(isDynamicRecord(payload.file) && typeof payload.file.transferId === "string");
    const file = await Effect.runPromise(bridge.receiver.take(payload.file.transferId));
    assert.equal(file.mimeType, "application/octet-stream");
    assert.deepEqual(Buffer.from(file.base64, "base64"), fileBytes);
    return { ordinaryFile: true, bytes: fileBytes.length };
  });

  await step("JSON metadata and strict UTF8/JSON reject malformed bodies", async () => {
    const requestId = randomUUID();
    const metadata = {
      transferId: randomUUID(),
      name: rpcJsonFileName(requestId),
      mimeType: RPC_JSON_FILE_MIME,
      size: 2,
    };
    assert.throws(() => decodeRpcJsonFile({ ...metadata, size: RPC_JSON_FILE_MAX_BYTES + 1 }, requestId));
    assert.throws(() => decodeRpcJsonFile({ ...metadata, size: -1 }, requestId));
    assert.throws(() => decodeRpcJsonFile({ ...metadata, size: 1.5 }, requestId));
    assert.throws(() => decodeRpcJsonFile({ ...metadata, name: rpcJsonFileName(randomUUID()) }, requestId));
    assert.throws(() => decodeRpcJsonFile({ ...metadata, mimeType: "application/json" }, requestId));
    const file = { name: metadata.name, mimeType: metadata.mimeType, bytes: new Uint8Array([0xc3, 0x28]) };
    assert.throws(() => decodeRpcJsonFileBody(file, metadata));
    assert.throws(() => decodeRpcJsonFileBody({ ...file, bytes: new TextEncoder().encode("}{") }, metadata));
    assert.throws(() =>
      decodeRpcJsonFileBody({ ...file, bytes: new TextEncoder().encode("{}"), name: "wrong.json" }, metadata),
    );
    assert.throws(() =>
      decodeRpcJsonFileBody({ ...file, bytes: new TextEncoder().encode("{}"), mimeType: "text/plain" }, metadata),
    );
    assert.throws(() => decodeRpcJsonFileBody({ ...file, bytes: new TextEncoder().encode("null") }, metadata));
    const secret = "fixture-secret-must-stay-private";
    const malformed = new TextEncoder().encode(`{"value":"${secret}" broken`);
    assert.throws(
      () => decodeRpcJsonFileBody({ ...file, bytes: malformed }, { ...metadata, size: malformed.byteLength }),
      (error: unknown) => error instanceof Error && !error.message.includes(secret),
    );
    return { malformedMetadata: 5, malformedBodies: 6, parserTextPrivate: true, limitBytes: RPC_JSON_FILE_MAX_BYTES };
  });

  await step("the receiver bounds JSON before allocation and rejects duplicate opens", async () => {
    const sent: string[] = [];
    const receiver = createRemoteFileReceiver((data) =>
      Effect.sync(() => {
        sent.push(data);
      }),
    );
    const requestId = randomUUID();
    receiver.expectJson(
      requestId,
      () => {},
      () => {},
    );
    const open = {
      version: 2 as const,
      type: "file-open" as const,
      transferId: randomUUID(),
      name: rpcJsonFileName(requestId),
      mimeType: RPC_JSON_FILE_MIME,
      size: RPC_JSON_FILE_MAX_BYTES + 1,
      sha256: "0".repeat(64),
    };
    // The released file header rejects this declared size before allocating its body.
    await assert.rejects(Effect.runPromise(receiver.receive(JSON.stringify(open))));
    const small = {
      ...open,
      transferId: randomUUID(),
      size: 2,
      sha256: createHash("sha256").update("{}").digest("hex"),
    };
    await Effect.runPromise(receiver.receive(encodeTeamProtocolV2Frame(small)));
    await assert.rejects(Effect.runPromise(receiver.receive(encodeTeamProtocolV2Frame(small))));
    const otherRequest = randomUUID();
    receiver.expectJson(
      otherRequest,
      () => {},
      () => {},
    );
    const otherTransfer = randomUUID();
    await Effect.runPromise(
      receiver.receive(
        encodeTeamProtocolV2Frame({
          ...small,
          transferId: otherTransfer,
          name: rpcJsonFileName(otherRequest),
          size: RPC_JSON_FILE_MAX_BYTES,
        }),
      ),
    );
    assert.ok(
      sent.some((data) => {
        const frame = decodeTeamProtocolV2FileControlFrame(data);
        return frame.type === "file-cancel" && frame.transferId === otherTransfer;
      }),
    );
    await Effect.runPromise(receiver.cancelJson(otherRequest));
    await Effect.runPromise(receiver.cancelJson(requestId));
    receiver.clear();
    return { refusedDeclaredBytes: open.size, duplicateRefused: true, concurrentBudgetEnforced: true };
  });

  await step("cancellation and disconnect release pending JSON downloads", async () => {
    for (const action of ["cancel", "disconnect"] as const) {
      const sent: string[] = [];
      const receiver = createRemoteFileReceiver((data) =>
        Effect.sync(() => {
          sent.push(data);
        }),
      );
      const requestId = randomUUID();
      const transferId = randomUUID();
      receiver.expectJson(
        requestId,
        () => {},
        () => {},
      );
      await Effect.runPromise(
        receiver.receive(
          encodeTeamProtocolV2Frame({
            version: 2,
            type: "file-open",
            transferId,
            name: rpcJsonFileName(requestId),
            mimeType: RPC_JSON_FILE_MIME,
            size: 2,
            sha256: createHash("sha256").update("{}").digest("hex"),
          }),
        ),
      );
      const waiting = Effect.runPromise(receiver.takeBytes(transferId));
      const rejected = assert.rejects(waiting);
      if (action === "cancel") await Effect.runPromise(receiver.cancelJson(requestId));
      else receiver.clear();
      await rejected;
      // A late chunk belongs to the cancelled transfer and must not reopen it.
      const chunk = new Uint8Array(
        encodeTeamProtocolV2FileChunk({ transferId, offset: 0, bytes: new TextEncoder().encode("{}") }),
      );
      await Effect.runPromise(receiver.receive(chunk.buffer));
      assert.ok(sent.some((data) => decodeTeamProtocolV2FileControlFrame(data).type === "file-cancel"));
      receiver.clear();
    }
    return { cancelReleased: true, disconnectReleased: true, lateChunksRefused: true };
  });

  await step("an old HTTP result cannot start a JSON transfer in a replacement session", async () => {
    const requestId = randomUUID();
    const hold = transferHold();
    transferHolds.push(hold);
    holdNextRead = hold;
    bridge.receiver.expectJson(
      requestId,
      () => {},
      () => {},
    );
    request(bridge, CHANNEL_ROUTES.read, { channelId: channel.id }, capable, requestId);
    await hold.entered.promise;
    const replacedAt = bridge.sent.length;
    await authenticate();
    // Closing the logical session interrupts the old HTTP read. Observe the socket closing,
    // rather than waiting an arbitrary time for a forbidden transfer that must never happen.
    await hold.settled.promise;
    hold.released.resolve();
    assert.equal(result(await request(bridge, CHANNEL_ROUTES.list, null, capable).response).status, 200);
    assert.equal(bridge.sent.slice(replacedAt).filter((frame) => frame.channel === "files").length, 0);
    assert.equal(bridge.responses(requestId).length, 0);
    assert.deepEqual(bridge.disconnected, []);
    return { oldRequestAborted: true, oldFiles: 0, newSessionUsable: true };
  });

  await step("a JSON stream cannot resume into a different logical session on the same peer", async () => {
    const requestId = randomUUID();
    const hold = transferHold();
    transferHolds.push(hold);
    bridge.holdNextBinary = hold;
    bridge.receiver.expectJson(
      requestId,
      () => {},
      () => {},
    );
    request(bridge, CHANNEL_ROUTES.read, { channelId: channel.id }, capable, requestId);
    await hold.entered.promise;
    assert.equal(peer.hasActiveTransfers(), true);
    const replacedAt = bridge.sent.length;
    await authenticate();
    // The old send fiber must finish through interruption while its original send is held.
    // Releasing that send after authentication must not let any later chunk reach the new session.
    await hold.settled.promise;
    hold.released.resolve();
    assert.equal(result(await request(bridge, CHANNEL_ROUTES.list, null, capable).response).status, 200);
    const leaked = bridge.sent.slice(replacedAt).filter((frame) => {
      if (frame.channel !== "files") return false;
      if (typeof frame.data !== "string") return true;
      const control = decodeTeamProtocolV2FileControlFrame(frame.data);
      return control.type === "file-open" || control.type === "file-complete";
    });
    assert.equal(leaked.length, 0);
    assert.equal(bridge.responses(requestId).length, 0);
    assert.equal(peer.hasActiveTransfers(), false);
    assert.deepEqual(bridge.disconnected, []);
    return { heldAfterFirstChunk: true, laterChunks: 0, oldRpcResponses: 0, newSessionUsable: true };
  });

  await step("all frames retain their released bounds and the session remains usable", async () => {
    let maxRpc = 0;
    let maxBinary = 0;
    for (const frame of bridge.sent) {
      if (frame.channel === "rpc" && typeof frame.data === "string")
        maxRpc = Math.max(maxRpc, Buffer.byteLength(frame.data));
      if (typeof frame.data !== "string") maxBinary = Math.max(maxBinary, frame.data.byteLength);
    }
    assert.ok(maxRpc <= TEAM_PROTOCOL_V2_MAX_JSON_FRAME_BYTES);
    assert.ok(maxBinary <= TEAM_PROTOCOL_V2_MAX_BINARY_FRAME_BYTES);
    assert.equal(result(await request(bridge, CHANNEL_ROUTES.list, null, capable).response).status, 200);
    assert.equal(peer.hasActiveTransfers(), false);
    assert.deepEqual(bridge.disconnected, []);
    return { maxRpc, maxBinary, usable: true };
  });
  report.passed = true;
} catch {
  report.passed = false;
} finally {
  for (const hold of transferHolds) hold.released.resolve();
  for (const { peer, bridge } of peers) {
    bridge.receiver.clear();
    await Effect.runPromise(peer.dispose()).catch(() => undefined);
  }
  await new Promise<void>((resolveClose) => adapter.close(() => resolveClose()));
  if (api) await Effect.runPromise(api.stop()).catch(() => undefined);
  if (agents) await runCauseEffect(agents.stop()).catch(() => undefined);
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`rpc-json-files-e2e: ${report.passed ? "passed" : "failed"} (${join(OUT, "report.json")})\n`);
process.exit(report.passed ? 0 : 1);

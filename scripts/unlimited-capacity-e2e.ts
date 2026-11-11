// Drives real SQLite stores, Team API routes over HTTP, and skill/archive services.
// Run: bun scripts/unlimited-capacity-e2e.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MCP_SERVERS_CAPABILITY, type McpServerConfig } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  decodeMcpServerPage,
  MCP_PAGES_ROUTES,
  MCP_SERVER_PAGES_CAPABILITY,
  MCP_SERVER_PAGES_CODECS,
} from "@openbot/contracts/team-protocol/mcp-pages-v1";
import { MCP_ROUTES, mcpResponse } from "@openbot/contracts/team-protocol/mcp-v1";
import { TEAM_CAPABILITIES_HEADER, TEAM_PROTOCOL_VERSION_HEADER } from "@openbot/contracts/team-protocol/v1";
import { plugin } from "bun";
import { Effect } from "effect";
import { zipSync } from "fflate";
import { AgentMemories } from "../src/backend/agent/agent-memories";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { testMcpServer } from "../src/backend/mcp-probe";
import { McpServerStore } from "../src/backend/mcp-server-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { AGENT_IMPORT_MANIFEST } from "../src/main/agent-import-manifest";
import { type AgentImportAgents, AgentImportService } from "../src/main/agent-import-service";
import { CentralAuthManager } from "../src/main/central-auth-manager";
import { readHermesProfiles } from "../src/main/hermes-import-reader";
import { InstanceTransferService } from "../src/main/instance-transfer-service";
import { LocalSkillLibrary } from "../src/main/local-skill-library";
import { listFolderSkills } from "../src/main/skill-folder-discovery";
import { SkillMarketplaceService } from "../src/main/skill-marketplace-service";
import type { TeamApiMcpServers } from "../src/main/team-api/dependencies";
import { HttpError } from "../src/main/team-api/http-error";
import type { TeamApiRequestContext } from "../src/main/team-api/request-context";
import { requestCapabilities, requestProtocol } from "../src/main/team-api/request-helpers";
import { routeMcpServerPages } from "../src/main/team-api/route-mcp-pages";
import { TeamStore } from "../src/main/team-store";

const output = resolve(import.meta.dirname, "../.openbot-build/unlimited-capacity-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-unlimited-capacity-"));
const userData = join(root, "user-data");
const report: { checks: { name: string; detail: unknown }[]; passed?: boolean; error?: string } = { checks: [] };
const servers: Server[] = [];
let database = new OpenBotDatabase(userData);
let store = new AgentStore(userData, join(root, "home"), database);
let mcp = new McpServerStore(database);
const capabilities = [MCP_SERVERS_CAPABILITY, MCP_SERVER_PAGES_CAPABILITY];
type CapacityRequest =
  | { cursor: string | null }
  | { config: McpServerConfig }
  | { mcpServerId: string; enabled?: boolean };

// The route imports the desktop IPC registrar. This script never registers desktop IPC.
plugin({
  name: "capacity-electron-boundary",
  setup(build) {
    build.module("electron", () => ({
      loader: "object",
      exports: {
        ipcMain: {
          handle: () => {
            throw new Error("Desktop IPC is outside this check.");
          },
        },
      },
    }));
  },
});
const { routeMcpServers } = await import("../src/main/team-api/route-mcp");

function checked(name: string, detail: unknown): void {
  report.checks.push({ name, detail });
}
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
function config(name: string, url: string): McpServerConfig {
  return {
    id: "",
    name,
    url,
    transport: "http",
    enabled: true,
    command: "",
    args: [],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    headers: [],
  };
}
function skillText(name: string): string {
  return `---\nname: ${name}\ndescription: Exercise ${name}.\n---\nUse this skill to check local installation.\n`;
}

try {
  await runCauseEffect(store.initialize());
  const team = new TeamStore(join(root, "team.json"));
  await runCauseEffect(team.initialize());
  await runCauseEffect(team.configure("Capacity checks", "owner", "owner-password-e2e"));
  const owner = await runCauseEffect(team.login("owner", "owner-password-e2e"));
  const adminInvite = await runCauseEffect(team.createInvite("admin"));
  const admin = await runCauseEffect(team.acceptInvite(adminInvite.token, "admin", "admin-password-e2e"));
  const memberInvite = await runCauseEffect(team.createInvite("member"));
  const member = await runCauseEffect(team.acceptInvite(memberInvite.token, "member", "member-password-e2e"));

  // A real local MCP endpoint is probed through the SDK client used by OpenBot.
  let probes = 0;
  const probeUrl = await listen(
    createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!isDynamicRecord(body) || body.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "capacity-check", version: "1" },
            }
          : { tools: [{ name: "capacity_check", description: "A local check.", inputSchema: { type: "object" } }] };
      if (body.method === "tools/list") probes += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    }),
  );
  const adapter: TeamApiMcpServers = {
    listMcpServers: () => mcp.list(),
    saveMcpServer: ({ config: value }) =>
      Effect.sync(() => {
        mcp.save(value);
        return mcp.list();
      }),
    removeMcpServer: ({ mcpServerId }) =>
      Effect.sync(() => {
        mcp.remove(mcpServerId);
        return mcp.list();
      }),
    setMcpServerEnabled: ({ mcpServerId, enabled }) =>
      Effect.sync(() => {
        mcp.setEnabled(mcpServerId, enabled);
        return mcp.list();
      }),
    testMcpServer: ({ config: value }) => testMcpServer(value).pipe(Effect.orDie),
  };
  const apiUrl = await listen(
    createServer(async (request, response) => {
      const token = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
      const session = team.authenticateSession(token);
      if (!session) {
        response.writeHead(401).end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const context: TeamApiRequestContext = {
        request,
        response,
        url,
        method: request.method ?? "GET",
        protocol: requestProtocol(request),
        capabilities: requestCapabilities(request),
        member: session.member,
        token,
        sessionId: session.sessionId,
        sessionExpiresAt: session.sessionExpiresAt,
        agentLevel: () => (session.member.role === "member" ? "none" : "manage"),
        json: (status, value) => {
          const codec = MCP_SERVER_PAGES_CODECS.get(url.pathname);
          const body = codec ? codec.response(status, value) : mcpResponse(url.pathname, status, value);
          response.writeHead(status, { "Content-Type": "application/json" });
          response.end(JSON.stringify(body));
          return "handled";
        },
        empty: (status) => {
          response.writeHead(status).end();
          return "handled";
        },
      };
      try {
        if ((await routeMcpServerPages(context, adapter, undefined)) === "handled") return;
        if ((await routeMcpServers(context, adapter)) === "handled") return;
        response.writeHead(404).end();
      } catch (error) {
        response.writeHead(error instanceof HttpError ? error.status : 500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof HttpError ? error.message : "Request failed." }));
      }
    }),
  );
  async function request(path: string, body?: CapacityRequest, token = admin.sessionToken, caps = capabilities) {
    return fetch(`${apiUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        [TEAM_PROTOCOL_VERSION_HEADER]: "9",
        [TEAM_CAPABILITIES_HEADER]: caps.join(","),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function write(path: string, body: CapacityRequest) {
    const response = await request(path, body);
    assert.equal(response.status, 200, await response.text());
  }
  async function allMcp(): Promise<McpServerConfig[]> {
    const records: McpServerConfig[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const response = await request(MCP_PAGES_ROUTES.list, { cursor });
      assert.equal(response.status, 200);
      const page = decodeMcpServerPage(await response.json());
      for (const item of page.items) {
        assert.ok(!seen.has(item.id));
        seen.add(item.id);
        records.push(item);
      }
      cursor = page.nextCursor;
      assert.ok(records.length <= 1000, "Pagination must terminate.");
    } while (cursor);
    return records;
  }
  for (let index = 0; index < 40; index += 1)
    await write(MCP_PAGES_ROUTES.save, { config: config(`capacity-${String(index).padStart(3, "0")}`, probeUrl) });
  const full = await allMcp();
  assert.equal(full.length, 40);
  assert.deepEqual(new Set(full.map((item) => item.id)), new Set(mcp.list().map((item) => item.id)));
  checked("40 MCP configurations cross the HTTP boundary in bounded pages", { count: full.length, maximumPage: 32 });

  const later = mcp.list()[39];
  assert.ok(later);
  await write(MCP_PAGES_ROUTES.save, { config: { ...later, name: "capacity-edited-after-32" } });
  await write(MCP_PAGES_ROUTES.toggle, { mcpServerId: later.id, enabled: false });
  assert.equal(mcp.get(later.id)?.enabled, false);
  await write(MCP_PAGES_ROUTES.toggle, { mcpServerId: later.id, enabled: true });
  const tested = await request(MCP_ROUTES.test, { config: { ...later, url: probeUrl } });
  assert.equal(tested.status, 200);
  assert.deepEqual(await tested.json(), { toolCount: 1, error: null });
  assert.equal(probes, 1);
  checked("edit, disable, enable and live MCP probe work after record 32", { liveProbeToolCount: 1 });

  for (const [path, body] of [
    [MCP_PAGES_ROUTES.list, { cursor: null }],
    [MCP_PAGES_ROUTES.save, { config: config("member-denied", probeUrl) }],
    [MCP_PAGES_ROUTES.remove, { mcpServerId: later.id }],
    [MCP_PAGES_ROUTES.toggle, { mcpServerId: later.id, enabled: false }],
    [MCP_ROUTES.test, { config: later }],
  ] as const)
    assert.equal((await request(path, body, member.sessionToken)).status, 403);
  assert.equal((await request(MCP_PAGES_ROUTES.list, { cursor: null }, "invalid-session")).status, 401);
  assert.equal((await request(MCP_PAGES_ROUTES.list, { cursor: null }, owner.sessionToken)).status, 200);
  assert.equal(
    (await request(MCP_PAGES_ROUTES.list, { cursor: null }, admin.sessionToken, [MCP_SERVERS_CAPABILITY])).status,
    400,
  );
  assert.equal(mcp.list().length, 40);
  checked("real owner and admin sessions have access; members and missing capabilities are refused", {
    memberActionsRefused: 5,
  });

  const legacy = await request(MCP_ROUTES.list);
  assert.equal(legacy.status, 200);
  const legacyBody = await legacy.json();
  assert.ok(Array.isArray(legacyBody));
  assert.equal(legacyBody.length, 32);
  assert.throws(() => mcpResponse(MCP_ROUTES.list, 200, full));
  assert.equal((await request(MCP_ROUTES.save, { config: config("legacy-overflow", probeUrl) })).status, 400);
  checked("released mcp-v1 keeps its 32-record response and create bound", { visible: legacyBody.length });

  database.close();
  database = new OpenBotDatabase(userData);
  store = new AgentStore(userData, join(root, "home"), database);
  await runCauseEffect(store.initialize());
  mcp = new McpServerStore(database);
  assert.equal((await allMcp()).length, 40);
  assert.equal(mcp.get(later.id)?.name, "capacity-edited-after-32");
  assert.equal(mcp.get(later.id)?.enabled, true);
  await write(MCP_PAGES_ROUTES.remove, { mcpServerId: later.id });
  assert.equal((await allMcp()).length, 39);
  assert.equal(mcp.get(later.id), null);
  checked("MCP records persist across database restart and removal works after record 32", {
    persisted: 40,
    remaining: 39,
  });

  const conversation = new ConversationRuntime(
    store,
    () => {},
    () => store.list(),
  );
  const memories = new AgentMemories({
    store,
    conversation,
    emit: () => {},
    emitError: (code) => {
      throw new Error(code);
    },
    limit: () => 1,
  });
  const library = new LocalSkillLibrary(join(root, "skill-library"), () => store.list());
  const auth = new CentralAuthManager({
    apiUrl: "https://example.invalid",
    storagePath: join(root, "auth.bin"),
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString(),
  });
  const skills = new SkillMarketplaceService(
    auth,
    () => store.list(),
    () => Effect.void,
    library,
  );
  const unavailable = () => Effect.die(new Error("This archive must not call an unrelated operation."));
  const importAgents: AgentImportAgents = {
    listAgents: () => store.list(),
    createAgentProfile: (input) => store.createAgent(input).pipe(Effect.orDie),
    createRoutine: unavailable,
    createMemory: (input) => memories.create(input),
    initializeMemorySelection: (id) => memories.initializeSelection(id),
    setAvatar: (id, image) => store.setAvatar(id, image).pipe(Effect.orDie),
    deleteAgent: (id) => store.deleteAgent(id).pipe(Effect.orDie),
    channels: { command: unavailable },
    createChannelMemory: unavailable,
    createChannelRoutine: unavailable,
    deleteChannel: unavailable,
  };
  const importer = new AgentImportService(
    importAgents,
    {
      library: () => library,
      installLocal: (input) => skills.installLocal(input),
    },
    () => ({ id: "capacity-check", name: "Capacity check" }),
    () => "UTC",
  );
  const entries: Record<string, Uint8Array> = {};
  const skillPaths: string[] = [];
  for (let index = 0; index < 205; index += 1) {
    const slug = `capacity-skill-${String(index).padStart(3, "0")}`;
    const path = `agents/imported/skills/${slug}`;
    skillPaths.push(path);
    entries[`${path}/SKILL.md`] = new TextEncoder().encode(skillText(slug));
  }
  entries[AGENT_IMPORT_MANIFEST] = new TextEncoder().encode(
    JSON.stringify({
      format: "openbot-agent-import",
      version: 1,
      source: { app: "capacity-e2e", exportedAt: new Date().toISOString() },
      agents: [
        {
          key: "imported",
          name: "Imported capacity",
          description: "Checks archive application.",
          skills: skillPaths,
          routines: [],
          memories: Array.from({ length: 600 }, (_, index) => `Imported fact ${index}.`),
        },
      ],
    }),
  );
  const archive = join(root, "import.zip");
  await writeFile(archive, zipSync(entries));
  const preview = await runCauseEffect(importer.stage(archive));
  const imported = await runCauseEffect(importer.apply({ token: preview.token, keys: ["imported"], channelKeys: [] }));
  assert.equal(imported.skipped.length, 0);
  assert.equal(imported.agents.length, 1);
  const importedAgent = imported.agents[0];
  assert.ok(importedAgent);
  const installed = await runCauseEffect(skills.listInstalled(importedAgent.id));
  assert.equal(installed.length, 205);
  assert.equal(memories.list(importedAgent.id).length, 600);
  checked("archive application installs all 205 skills and saves all 600 memories", {
    skills: installed.length,
    memories: 600,
    oldMemoryPreference: 1,
  });
  const transfer = new InstanceTransferService({
    agents: {
      listAgents: () => store.list(),
      listRoutines: () => [],
      listMemories: (agentId) => memories.list(agentId),
      getMemorySelection: (agentId) => memories.selectionState(agentId),
      setMemoryInclusion: (input) => memories.setInclusions(input),
      resolveAvatar: () => null,
      listModels: () => [{ provider: "codex", id: importedAgent.model }],
      createAgentProfile: (input) => store.createAgent(input),
      updateAgent: (input) => store.updateAgent(input),
      createRoutine: () => {
        throw new Error("This transfer has no routines.");
      },
      createMemory: (input) => memories.create(input),
      // An old stored preference must not truncate the imported collection.
      memoryLimit: () => 1,
      initializeMemorySelection: (agentId) => memories.initializeSelection(agentId),
      setAvatar: (agentId, image) => store.setAvatar(agentId, image),
      deleteAgent: (agentId) => store.deleteAgent(agentId),
      setAgentHidden: () => Effect.die("The agent is not hidden."),
      readTransferHistory: () => [],
      resolveTransferFile: () => Effect.succeed(null),
      importTransferHistory: () => Effect.die("The export has no chat history."),
      channels: {
        store: {
          ids: () => [],
          get: () => assert.fail("This transfer has no channels."),
          messages: () => [],
          update: () => assert.fail("This transfer has no channels."),
        },
        images: { resolve: () => null },
        command: () => Effect.die("This transfer has no channels."),
        setImage: () => Effect.die("This transfer has no channels."),
      },
      listChannelMemories: () => [],
      listChannelRoutines: () => [],
      createChannelMemory: () => assert.fail("This transfer has no channels."),
      createChannelRoutine: () => assert.fail("This transfer has no channels."),
      deleteChannel: () => Effect.die("This transfer has no channels."),
    },
    skills: { library: () => library, installLocal: (input) => skills.installLocal(input) },
    channelActor: () => ({ id: "local", name: "You" }),
    settings: {
      mcpServers: () => mcp.list(),
      saveMcpServer: unavailable,
      customProviders: () => [],
      saveCustomProvider: unavailable,
      customAgents: () => Effect.succeed([]),
      providersOff: () => [],
      sidebar: () => {
        throw new Error("This transfer excludes settings.");
      },
      mutateSidebar: unavailable,
      routineFlowLinks: () => Effect.succeed([]),
      connectRoutineFlow: unavailable,
      signedInProviders: () => ["codex"],
    },
    sharedRoot: store.sharedRoot,
    appVersion: "capacity-e2e",
    timezone: () => "UTC",
  });
  const transferArchive = join(root, "instance-transfer.zip");
  const exported = await runCauseEffect(
    transfer.exportTo(transferArchive, {
      agentIds: [importedAgent.id],
      includeFiles: false,
      includeSettings: false,
    }),
  );
  assert.equal(exported.saved, true);
  assert.deepEqual(exported.warnings, []);
  const transferPreview = await runCauseEffect(transfer.stage(transferArchive));
  assert.equal(transferPreview.agents.length, 1);
  assert.equal(transferPreview.agents[0]?.skillCount, 205);
  assert.equal(transferPreview.agents[0]?.memoryCount, 600);
  const transferred = await runCauseEffect(
    transfer.apply({
      token: transferPreview.token,
      keys: transferPreview.agents.map((agent) => agent.key),
      includeSettings: false,
    }),
  );
  assert.deepEqual(transferred.skipped, []);
  assert.equal(transferred.agents.length, 1);
  const transferredAgent = transferred.agents[0];
  assert.ok(transferredAgent);
  assert.deepEqual(
    memories
      .list(transferredAgent.id)
      .map((memory) => memory.text)
      .sort(),
    memories
      .list(importedAgent.id)
      .map((memory) => memory.text)
      .sort(),
  );
  assert.deepEqual(
    (await runCauseEffect(skills.listInstalled(transferredAgent.id))).map((skill) => skill.slug).sort(),
    installed.map((skill) => skill.slug).sort(),
  );
  checked("instance export and import preserve every skill and memory above the old limits", {
    sourceSkills: installed.length,
    previewSkills: transferPreview.agents[0]?.skillCount,
    importedSkills: 205,
    sourceMemories: 600,
    previewMemories: transferPreview.agents[0]?.memoryCount,
    importedMemories: memories.list(transferredAgent.id).length,
    oldMemoryPreference: 1,
  });
  const lastSkill = installed.at(-1);
  assert.ok(lastSkill);
  const disabled = await runCauseEffect(
    skills.setEnabled({ agentId: importedAgent.id, skillId: lastSkill.skillId, enabled: false }),
  );
  assert.equal(disabled.enabled, false);
  const enabled = await runCauseEffect(
    skills.setEnabled({ agentId: importedAgent.id, skillId: lastSkill.skillId, enabled: true }),
  );
  assert.equal(enabled.enabled, true);
  await runCauseEffect(skills.uninstall({ agentId: importedAgent.id, skillId: lastSkill.skillId }));
  assert.equal((await runCauseEffect(skills.listInstalled(importedAgent.id))).length, 204);
  checked("skill disable, enable and uninstall work beyond record 32", { remaining: 204 });

  const discoveryAgent = await runCauseEffect(
    store.createAgent({
      name: "Discovery capacity",
      description: "Checks folder discovery.",
      avatarSeed: "discovery",
      avatarHue: null,
    }),
  );
  const hermes = join(root, "hermes");
  await mkdir(hermes, { recursive: true });
  await writeFile(join(hermes, "SOUL.md"), "Capacity checks.");
  for (let index = 0; index < 205; index += 1) {
    const slug = `discovered-${String(index).padStart(3, "0")}`;
    for (const directory of [
      join(discoveryAgent.workspacePath, ".agents/skills", slug),
      join(hermes, "skills", slug),
    ]) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "SKILL.md"), skillText(slug));
    }
  }
  assert.equal((await runCauseEffect(listFolderSkills(discoveryAgent, new Set()))).length, 205);
  const profiles = await runCauseEffect(readHermesProfiles(hermes, "UTC"));
  assert.equal(profiles?.[0]?.skills.length, 205);
  assert.equal(profiles?.[0]?.skippedSkills.length, 0);
  checked("workspace discovery and Hermes import preview retain 205 valid skills", { workspace: 205, hermes: 205 });

  // Recreate the skill service to read its persisted lock files and immutable revisions.
  const restartedSkills = new SkillMarketplaceService(
    auth,
    () => store.list(),
    () => Effect.void,
    new LocalSkillLibrary(join(root, "skill-library"), () => store.list()),
  );
  assert.equal((await runCauseEffect(restartedSkills.listInstalled(importedAgent.id))).length, 204);
  checked("installed skill state survives service restart", { installed: 204 });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  database.close();
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

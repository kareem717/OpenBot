// Runs the real Codex app-server with 64 enabled MCP servers and a loopback model endpoint.
// Compares forced-direct schemas with native deferred discovery in ordinary and code-mode models.
// Searches and calls servers 0, 32 and 63, then repeats after an app-server restart and thread resume.
// No provider account or external model service is used. Writes a report under .openbot-build/.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { readCodexMcpConfig } from "../src/backend/agent/codex-mcp-config";
import { CODEX_DIRECT_ONLY_NAMESPACES, CODEX_FEATURES_CONFIG } from "../src/backend/agent/thread-lifecycle";
import { VISIBLE_DYNAMIC_TOOLS } from "../src/backend/agent/tool-catalog";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import { resolveCodexCli } from "../src/backend/cli";
import { runCauseEffect } from "../src/backend/effect-boundary";
import {
  type CodexOwnTransports,
  codexDisabledServers,
  codexMcpNamespaces,
  codexMcpServers,
  codexThreadMcpServers,
  toMcpShapeFailed,
  usableMcpServers,
} from "../src/backend/mcp-provider-shapes";
import { decodeRecordResponse, getRecord, getString } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/codex-deferred-mcp-e2e");
const NL = String.fromCharCode(10);
const DEADLINE_MS = 60_000;
const MODEL = "code-mode-model";
const ORDINARY_MODEL = "ordinary-model";
const SCHEMA_MARKER = "LARGE_MCP_SCHEMA_FIXTURE";
const SERVER_COUNT = 64;
const TARGETS = ["calendar_000", "calendar_032", "calendar_063"];
const TOOL = "list_calendars";
const RESULT = "calendar_fixture_result";
// The fields Codex reads to route tools, as its model cache has them for GPT-6.
const CODE_MODEL_CATALOG = {
  models: [
    {
      slug: MODEL,
      display_name: "Code mode model",
      description: "Local E2E model",
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low", description: "Local E2E model" }],
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: 0,
      support_verbosity: false,
      truncation_policy: { mode: "tokens", limit: 10000 },
      context_window: 272000,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      supports_search_tool: true,
      use_responses_lite: true,
      tool_mode: "code_mode_only",
      model_messages: { instructions_template: "Use the available tools." },
    },
  ],
};

const codeModel = CODE_MODEL_CATALOG.models[0];
assert.ok(codeModel);
const { tool_mode: _codeMode, ...ordinaryModel } = codeModel;
const MODEL_CATALOG = {
  models: [...CODE_MODEL_CATALOG.models, { ...ordinaryModel, slug: ORDINARY_MODEL, display_name: "Ordinary model" }],
};

interface ModelTool {
  type?: string;
  name?: string;
  tools?: ModelTool[];
}

interface ModelRequest {
  instructions?: string;
  input?: Array<{ type?: string; role?: string; tools?: ModelTool[] }>;
  tools?: ModelTool[];
}

interface ModelItem {
  type: string;
  id: string;
  role?: string;
  call_id?: string;
  name?: string;
  namespace?: string;
  arguments?: string | { query: string; limit: number };
  input?: string;
  execution?: string;
  status?: string;
  content?: Array<{ type: string; text: string }>;
}

interface ModelEvent {
  type: string;
  response?: {
    id: string;
    status: string;
    output?: ModelItem[];
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  };
  output_index?: number;
  item?: ModelItem;
}

interface Offer {
  toolBytes: number;
  instructionBytes: number;
  searchUnavailable: boolean;
  requestBytes: number;
  schemaMarker: boolean;
  searchAvailable: boolean;
  /** The top-level tool names, namespaces included. */
  names: string[];
  /** Whether the request names the MCP tool anywhere, the `exec` description included. */
  mentionsTool: boolean;
  /** Whether the request carries the MCP tool's result back. */
  hasResult: boolean;
}

/**
 * Drives native discovery before each call, using declarations actually returned by Codex.
 * Records initial schema and instruction sizes without keeping request content in the report.
 */
async function startFakeModel() {
  const offers: Offer[] = [];
  const failures: string[] = [];
  let mode: "code" | "ordinary" = "code";
  let eager = false;
  let phase = 0;
  let sequence = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed: ModelRequest = JSON.parse(body || "{}");
      const input = parsed.input ?? [];
      // A Responses Lite request sends its tools in an `input` item.
      const tools = parsed.tools ?? input.find((item) => item.tools)?.tools ?? [];
      const instructionMessages = input
        .filter((item) => item.role === "system" || item.role === "developer")
        .map(({ tools: _tools, ...message }) => message);
      offers.push({
        toolBytes: Buffer.byteLength(JSON.stringify(tools)),
        instructionBytes: Buffer.byteLength((parsed.instructions ?? "") + JSON.stringify(instructionMessages)),
        searchUnavailable: body.includes("tools.tool_search is not a function"),
        requestBytes: Buffer.byteLength(body),
        schemaMarker: JSON.stringify(tools).includes(SCHEMA_MARKER),
        searchAvailable:
          mode === "code"
            ? JSON.stringify(tools).includes("tools.tool_search")
            : tools.some((tool) => tool.type === "tool_search"),
        names: tools.flatMap((tool) => (tool.name ? [tool.name] : [])).sort(),
        mentionsTool: body.includes(TOOL),
        hasResult: JSON.stringify(input).includes(RESULT),
      });
      const target = TARGETS[Math.floor(phase / 2)];
      const namespace = input
        .flatMap((item) => (item.type === "tool_search_output" ? (item.tools ?? []) : []))
        .find((tool) => tool.name === `mcp__${target}` && tool.tools?.some((entry) => entry.name === TOOL));
      const discovered = (JSON.stringify(input).match(/mcp__calendar_[0-9]{3}__list_calendars/g) ?? []).at(-1);
      const callId = `call-${++sequence}`;
      let item: ModelItem = {
        type: "message",
        role: "assistant",
        id: callId,
        content: [{ type: "output_text", text: "done" }],
      };
      if (!eager && target) {
        if (phase % 2 === 0) {
          item =
            mode === "code"
              ? {
                  type: "custom_tool_call",
                  id: callId,
                  call_id: callId,
                  name: "exec",
                  namespace: "functions",
                  input: `const found = await tools.tool_search({query: "${target} list_calendars", limit: 1}); text(found);`,
                }
              : {
                  type: "tool_search_call",
                  id: callId,
                  call_id: callId,
                  execution: "client",
                  status: "completed",
                  arguments: { query: `${target} list_calendars`, limit: 1 },
                };
        } else if (mode === "code" && discovered === `mcp__${target}__${TOOL}`) {
          item = {
            type: "custom_tool_call",
            id: callId,
            call_id: callId,
            name: "exec",
            namespace: "functions",
            input: `const result = await tools.${discovered}({}); text(result);`,
          };
        } else if (mode === "ordinary" && namespace?.name) {
          item = {
            type: "function_call",
            id: callId,
            call_id: callId,
            name: TOOL,
            namespace: namespace.name,
            arguments: "{}",
          };
        } else failures.push(`${mode}: search did not expose ${target}`);
        phase += 1;
      }
      const send = (event: ModelEvent) =>
        response.write(`event: ${event.type}${NL}data: ${JSON.stringify(event)}${NL}${NL}`);
      response.writeHead(200, { "content-type": "text/event-stream" });
      send({ type: "response.created", response: { id: "r", status: "in_progress" } });
      send({ type: "response.output_item.done", output_index: 0, item });
      send({
        type: "response.completed",
        response: {
          id: "r",
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      response.end();
    });
  });
  return {
    offers,
    failures,
    begin(nextMode: "code" | "ordinary", nextEager: boolean) {
      mode = nextMode;
      eager = nextEager;
      phase = 0;
    },
    ...(await listen(server)),
  };
}

/**
 * Each path is one MCP server with four large tool schemas. Calls record the path and tool name.
 */
async function startHttpMcp() {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    const mcp = new Server({ name: "calendar", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Array.from({ length: 4 }, (_, index) => ({
        name: index === 0 ? TOOL : `calendar_extra_${index}`,
        description: `${index === 0 ? "Lists calendars." : `Calendar helper ${index}.`} ${SCHEMA_MARKER} ${"Documentation for optional calendar operations. ".repeat(220)}`,
        inputSchema: {
          type: "object" as const,
          properties: Object.fromEntries(
            Array.from({ length: 16 }, (_, field) => [
              `field_${field}`,
              {
                type: "string",
                description: `${SCHEMA_MARKER} ${"Documentation for an optional calendar parameter. ".repeat(12)}`,
              },
            ]),
          ),
        },
      })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (message) => {
      calls.push(`${request.url}:${message.params.name}`);
      return { content: [{ type: "text", text: `${RESULT}:${request.url}` }] };
    });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(asTransport(transport));
    await transport.handleRequest(request, response);
  });
  return { calls, ...(await listen(server)) };
}

async function listen(server: HttpServer) {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** The SDK transport, with its optional members spelled the way `exactOptionalPropertyTypes` wants. */
function asTransport(inner: StreamableHTTPServerTransport): Transport {
  const transport: Transport = {
    start: () => {
      inner.onclose = () => transport.onclose?.();
      inner.onerror = (error) => transport.onerror?.(error);
      inner.onmessage = (message, extra) => transport.onmessage?.(message, extra);
      return inner.start();
    },
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
  };
  return transport;
}

function row(name: string, fields: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: `row-${name}`,
    name,
    transport: "http",
    enabled: true,
    command: "",
    args: [],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: `${httpUrl}/${name}`,
    headers: [],
    ...fields,
  };
}

interface Case {
  name: string;
  /** The user's own entries, as TOML. */
  user?: string;
  rows: McpServerConfig[];
  /** The old workaround forces every external namespace direct. */
  eager?: boolean;
  mode?: "code" | "ordinary";
  executable?: string;
  /** True starts the thread with the fix, then resumes it in a new app-server. */
  resume?: boolean;
  suppressUnstableWarning?: boolean;
}

interface Outcome {
  unstableWarnings: number;
  nativeDiscoveryGuidance: boolean;
  initialToolBytes: number;
  initialInstructionBytes: number;
  searchUnavailable: boolean;
  initialRequestBytes: number;
  schemaMarker: boolean;
  searchAvailable: boolean;
  keys: string[];
  directOnly: string[];
  offered: string[];
  mentionsTool: boolean;
  calls: string[];
  resultReturned: boolean;
}

/** One app-server for the case's `CODEX_HOME`, initialized, and a way to run a turn to its end. */
async function open(home: string, executable = cli.executable) {
  const client = new CodexAppServerClient(executable, 30_000, { CODEX_HOME: home, FAKE_KEY: "e2e" });
  const unstableWarnings: string[] = [];
  let turnDone = () => {};
  client.on("notification", (notification) => {
    if (notification.method === "turn/completed") turnDone();
    const message = getString(notification.params, "message");
    if (notification.method === "warning" && message?.startsWith("Under-development features enabled:"))
      unstableWarnings.push(message);
  });
  client.start();
  try {
    await runCauseEffect(
      client.request(
        "initialize",
        {
          clientInfo: { name: "openbot_e2e", title: "OpenBot E2E", version: "0.0.0" },
          capabilities: { experimentalApi: true },
        },
        decodeRecordResponse,
      ),
    );
  } catch (error) {
    await runCauseEffect(client.stop());
    throw error;
  }
  client.notify("initialized");
  const turn = async (threadId: string) => {
    const done = new Promise<void>((resolveTurn) => {
      turnDone = resolveTurn;
    });
    await runCauseEffect(
      client.request(
        "turn/start",
        { threadId, input: [{ type: "text", text: "list calendars" }] },
        decodeRecordResponse,
      ),
    );
    await Promise.race([done, deadline(`the turn in ${home}`)]);
  };
  return { client, turn, unstableWarnings };
}

async function run(test: Case): Promise<Outcome> {
  const home = join(OUT, test.name);
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "config.toml"),
    [
      `model = "${MODEL}"`,
      `model_catalog_json = ${JSON.stringify(catalog)}`,
      'model_provider = "fake"',
      "[model_providers.fake]",
      'name = "fake"',
      `base_url = "http://127.0.0.1:${model.port}/v1"`,
      'env_key = "FAKE_KEY"',
      'wire_api = "responses"',
      "",
      test.user ?? "",
    ].join(NL),
  );
  let session = await open(home, test.executable);
  let priorWarnings = 0;
  try {
    const usable = await runCauseEffect(usableMcpServers(test.rows));
    const keyed = (own: CodexOwnTransports) => codexMcpServers(usable, own).servers;
    const own = await runCauseEffect(
      codexDisabledServers(() => readCodexMcpConfig(session.client, keyed).pipe(toMcpShapeFailed)),
    );
    const servers = keyed(own.transports);
    const mode = test.mode ?? "code";
    const directOnly = test.eager
      ? [...CODEX_DIRECT_ONLY_NAMESPACES, ...codexMcpNamespaces(servers)]
      : CODEX_DIRECT_ONLY_NAMESPACES;
    const params = (directOnly: string[]) => ({
      cwd: home,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: test.mode === "ordinary" ? ORDINARY_MODEL : MODEL,
      config: {
        mcp_servers: codexThreadMcpServers(own.disabled, servers),
        ...CODEX_FEATURES_CONFIG,
        suppress_unstable_features_warning:
          test.suppressUnstableWarning ?? CODEX_FEATURES_CONFIG.suppress_unstable_features_warning,
        mcp_optional_startup_grace_ms: 10000,
        "features.code_mode.direct_only_tool_namespaces": directOnly,
      },
      dynamicTools: VISIBLE_DYNAMIC_TOOLS,
    });
    const started = await runCauseEffect(
      session.client.request("thread/start", params(directOnly), decodeRecordResponse),
    );
    const threadId = getString(getRecord(started, "thread"), "id");
    assert(threadId, "thread/start returned no thread id");
    assert.equal(session.client.deferredMcpTools("not-a-configured-thread"), false);
    if (test.resume) {
      model.begin(mode, test.eager === true);
      await session.turn(threadId);
      priorWarnings += session.unstableWarnings.length;
      await runCauseEffect(session.client.stop());
      session = await open(home, test.executable);
      await runCauseEffect(
        session.client.request("thread/resume", { threadId, ...params(directOnly) }, decodeRecordResponse),
      );
    }
    const firstOffer = model.offers.length;
    const firstCall = http.calls.length;
    model.begin(mode, test.eager === true);
    await session.turn(threadId);
    const offers = model.offers.slice(firstOffer);
    return {
      unstableWarnings: priorWarnings + session.unstableWarnings.length,
      nativeDiscoveryGuidance: session.client.deferredMcpTools(threadId),
      initialToolBytes: offers[0]?.toolBytes ?? 0,
      initialInstructionBytes: offers[0]?.instructionBytes ?? 0,
      searchUnavailable: offers.some((offer) => offer.searchUnavailable),
      initialRequestBytes: offers[0]?.requestBytes ?? 0,
      schemaMarker: offers[0]?.schemaMarker ?? false,
      searchAvailable: offers[0]?.searchAvailable ?? false,
      keys: Object.keys(servers).sort(),
      directOnly,
      offered: (offers[0]?.names ?? []).filter((name) => name.startsWith("mcp__")),
      mentionsTool: offers[0]?.mentionsTool ?? false,
      calls: http.calls.slice(firstCall),
      resultReturned: offers.some((offer) => offer.hasResult),
    };
  } finally {
    await runCauseEffect(session.client.stop());
  }
}

function deadline(what: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`No answer for ${what} in ${DEADLINE_MS} ms.`)), DEADLINE_MS).unref();
  });
}

const steps: Array<{ step: string; outcome: Outcome }> = [];
async function step(name: string, test: Case, expected: (outcome: Outcome) => void): Promise<void> {
  const outcome = await run(test);
  steps.push({ step: name, outcome });
  try {
    expected(outcome);
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const catalog = join(OUT, "model-catalog.json");
await writeFile(catalog, JSON.stringify(MODEL_CATALOG));
const cli = await runCauseEffect(resolveCodexCli());
assert.ok(cli.version, "The runtime version was verified by the resolver.");
const model = await startFakeModel();
const http = await startHttpMcp();
const httpOrigin = `http://127.0.0.1:${http.port}`;
const httpUrl = `${httpOrigin}/mcp`;

try {
  const rows = Array.from({ length: SERVER_COUNT }, (_, i) => row(`calendar_${String(i).padStart(3, "0")}`));
  let eagerBytes = 0;
  await step(
    "unsuppressed code-mode tool search emits a development notice without failing tools",
    { name: "unsuppressed-notice", rows, suppressUnstableWarning: false },
    (outcome) => {
      assert.ok(outcome.unstableWarnings > 0);
      assert.equal(outcome.resultReturned, true);
      assert.equal(outcome.searchAvailable, true);
    },
  );
  await step(
    "forced-direct 64-server baseline eagerly sends every MCP schema",
    { name: "eager", rows, eager: true },
    (outcome) => {
      assert.equal(outcome.keys.length, SERVER_COUNT);
      assert.equal(outcome.offered.length, SERVER_COUNT);
      assert.equal(outcome.schemaMarker, true);
      assert.equal(outcome.nativeDiscoveryGuidance, false);
      assert.ok(outcome.initialToolBytes > 1_000_000);
      eagerBytes = outcome.initialToolBytes;
    },
  );
  for (const mode of ["code", "ordinary"] as const) {
    for (const resume of [false, true]) {
      await step(
        `${mode} model discovers and calls servers 0, 32 and 63${resume ? " after resume" : ""}`,
        { name: `${mode}-${resume ? "resume" : "new"}`, rows, mode, resume },
        (outcome) => {
          assert.equal(outcome.unstableWarnings, 0, "OpenBot's tool-search setup needs no user warning.");
          assert.equal(outcome.keys.length, SERVER_COUNT, "Every enabled server reaches Codex.");
          assert.equal(outcome.offered.length, 0, "No external schema is forced into the initial request.");
          assert.equal(outcome.schemaMarker, false);
          assert.equal(outcome.searchAvailable, true);
          assert.equal(outcome.nativeDiscoveryGuidance, true);
          assert.ok(outcome.initialToolBytes < 80_000 && outcome.initialToolBytes < eagerBytes / 10);
          assert.deepEqual(
            outcome.calls,
            TARGETS.map((target) => `/mcp/${target}:${TOOL}`),
          );
          assert.equal(outcome.resultReturned, true);
          assert.deepEqual(model.failures, []);
        },
      );
    }
  }

  // Optional exact old-runtime control. The caller supplies a separately verified old binary.
  const legacy = process.env.OPENBOT_LEGACY_CODEX_PATH;
  if (legacy) {
    const version = execFileSync(legacy, ["--version"], { encoding: "utf8" }).trim();
    assert.equal(version, "codex-cli 0.160.1");
    await step(
      "the old pinned 0.160.1 runtime cannot discover code-mode MCP tools",
      { name: "pinned-0.160.1", rows, executable: legacy },
      (outcome) => {
        assert.equal(outcome.keys.length, SERVER_COUNT);
        assert.equal(outcome.searchAvailable, false);
        assert.equal(outcome.searchUnavailable, true);
        assert.deepEqual(outcome.calls, []);
      },
    );
  }

  await writeFile(
    join(OUT, "report.json"),
    `${JSON.stringify({ ok: true, codex: { version: cli.version }, serverCount: SERVER_COUNT, toolsPerServer: 4, steps }, null, 2)}${NL}`,
  );
  process.stdout.write(`codex-deferred-mcp-e2e: ${steps.length} steps passed with Codex ${cli.version}${NL}`);
} catch (error) {
  await writeFile(
    join(OUT, "report.json"),
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), steps }, null, 2)}${NL}`,
  );
  process.stderr.write(`codex-deferred-mcp-e2e failed: ${error instanceof Error ? error.message : String(error)}${NL}`);
  process.exitCode = 1;
} finally {
  await http.close();
  await model.close();
}

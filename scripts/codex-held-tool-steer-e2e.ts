// Checks the real Codex app-server's steer ordering while a dynamic tool response is held.
// A loopback model asks a question. The host holds that call, steers the running turn, then cancels
// the question only after the acknowledgement. Both the cancellation and the new message must
// reach the next model request. No account or external model service is used.
// Writes .openbot-build/codex-held-tool-steer-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CODEX_DIRECT_ONLY_NAMESPACES, CODEX_FEATURES_CONFIG } from "../src/backend/agent/thread-lifecycle";
import { visibleDynamicTools } from "../src/backend/agent/tool-catalog";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import { resolveCodexCli } from "../src/backend/cli";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { decodeRecordResponse, getRecord, getString, type RequestId } from "../src/backend/protocol";

type ModelOutputItem =
  | { type: "function_call"; id: string; call_id: string; namespace: string; name: string; arguments: string }
  | { type: "message"; id: string; role: "assistant"; content: { type: "output_text"; text: string }[] };
type ModelEvent =
  | { type: "response.created"; response: { id: string; status: "in_progress" } }
  | { type: "response.output_item.done"; output_index: number; item: ModelOutputItem }
  | {
      type: "response.completed";
      response: {
        id: string;
        status: "completed";
        output: ModelOutputItem[];
        usage: { input_tokens: number; output_tokens: number; total_tokens: number };
      };
    };

const OUT = resolve(import.meta.dirname, "../.openbot-build/codex-held-tool-steer-e2e");
const home = await mkdtemp(join(tmpdir(), "openbot-native-steer-"));
const MODEL = "ordinary-model";
const STEERING = "STEER_FOLLOW_NEW_REQUEST_83091";
const CANCELLED = "The user cancelled previous handoff. Follow their new steering request.";
const WAIT_MS = 10_000;
const requests: Array<{ hasSteering: boolean; hasCancelled: boolean }> = [];
const report: {
  passed: boolean;
  codex?: string;
  ackBeforeToolResponse?: boolean;
  steeringReachedModel?: boolean;
  cancelledToolResultReachedModel?: boolean;
  modelRequests?: number;
  error?: string;
} = { passed: false };
let client: CodexAppServerClient | undefined;
let modelStep = 0;
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    requests.push({ hasSteering: body.includes(STEERING), hasCancelled: body.includes(CANCELLED) });
    const item: ModelOutputItem =
      modelStep++ === 0
        ? {
            type: "function_call",
            id: "held-call",
            call_id: "held-call",
            namespace: "openbot",
            name: "ask_user",
            arguments: JSON.stringify({
              questions: [{ id: "account", header: "Account", question: "Which account should I use?" }],
            }),
          }
        : {
            type: "message",
            id: "answer",
            role: "assistant",
            content: [{ type: "output_text", text: "Followed the new request." }],
          };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (value: ModelEvent) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
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

/** A bounded state wait. Its timer does not keep an otherwise stopped test alive. */
function deadline(): Promise<null> {
  return new Promise((done) => {
    setTimeout(() => done(null), WAIT_MS).unref();
  });
}

try {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const catalog = join(home, "models.json");
  await writeFile(
    catalog,
    JSON.stringify({
      models: [
        {
          slug: MODEL,
          display_name: "Ordinary model",
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
          model_messages: { instructions_template: "Use the available tools." },
        },
      ],
    }),
  );
  await writeFile(
    join(home, "config.toml"),
    [
      `model=${JSON.stringify(MODEL)}`,
      `model_catalog_json=${JSON.stringify(catalog)}`,
      'model_provider="fake"',
      "[model_providers.fake]",
      'name="fake"',
      `base_url="http://127.0.0.1:${address.port}/v1"`,
      'env_key="FAKE_KEY"',
      'wire_api="responses"',
    ].join("\n"),
  );
  const cli = await runCauseEffect(resolveCodexCli());
  assert.ok(cli.version, "The resolver did not verify the runtime version.");
  report.codex = cli.version;
  const connection = new CodexAppServerClient(cli.executable, WAIT_MS, { CODEX_HOME: home, FAKE_KEY: "e2e" });
  client = connection;
  const held = Promise.withResolvers<{ id: RequestId; turnId: string }>();
  const ended = Promise.withResolvers<void>();
  connection.on("request", (request) => {
    if (request.method !== "item/tool/call" || getString(request.params, "tool") !== "ask_user") return;
    const turnId = getString(request.params, "turnId");
    if (turnId) held.resolve({ id: request.id, turnId });
  });
  connection.on("notification", (notification) => {
    if (notification.method === "turn/completed") ended.resolve();
  });
  connection.start();
  await runCauseEffect(
    connection.request(
      "initialize",
      { clientInfo: { name: "native_steer_e2e", version: "0.0.0" }, capabilities: { experimentalApi: true } },
      decodeRecordResponse,
    ),
  );
  connection.notify("initialized");
  const started = await runCauseEffect(
    connection.request(
      "thread/start",
      {
        cwd: home,
        model: MODEL,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        config: {
          ...CODEX_FEATURES_CONFIG,
          "features.code_mode.direct_only_tool_namespaces": CODEX_DIRECT_ONLY_NAMESPACES,
        },
        dynamicTools: visibleDynamicTools("codex"),
      },
      decodeRecordResponse,
    ),
  );
  const threadId = getString(getRecord(started, "thread"), "id");
  assert.ok(threadId);
  const first = await runCauseEffect(
    connection.request(
      "turn/start",
      { threadId, input: [{ type: "text", text: "Ask me which account." }] },
      decodeRecordResponse,
    ),
  );
  const turnId = getString(getRecord(first, "turn"), "id");
  assert.ok(turnId);
  const tool = await Promise.race([held.promise, deadline()]);
  assert.ok(tool, "Codex did not request the dynamic tool.");
  assert.equal(tool.turnId, turnId);
  let toolResponseSent = false;
  let ackBeforeToolResponse = false;
  const ack = runCauseEffect(
    connection.request(
      "turn/steer",
      { threadId, expectedTurnId: turnId, input: [{ type: "text", text: STEERING }] },
      decodeRecordResponse,
    ),
  ).then((value) => {
    ackBeforeToolResponse = !toolResponseSent;
    return value;
  });
  // If acknowledgement waits on the held tool, release it so cleanup can finish, then fail order.
  await Promise.race([ack, deadline()]);
  toolResponseSent = true;
  connection.respond(tool.id, { success: false, contentItems: [{ type: "inputText", text: CANCELLED }] });
  await ack;
  assert.ok(await Promise.race([ended.promise.then(() => true), deadline()]), "The steered turn did not end.");
  report.ackBeforeToolResponse = ackBeforeToolResponse;
  report.steeringReachedModel = requests[1]?.hasSteering === true;
  report.cancelledToolResultReachedModel = requests[1]?.hasCancelled === true;
  report.modelRequests = requests.length;
  assert.equal(report.ackBeforeToolResponse, true);
  assert.equal(report.steeringReachedModel, true);
  assert.equal(report.cancelledToolResultReachedModel, true);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (client) await runCauseEffect(client.stop()).catch(() => {});
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(home, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}

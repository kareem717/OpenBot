import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createEffect, createRoot, createSignal, flush } from "solid-js";
import { createConversationRoutineCards } from "../src/renderer/src/features/conversation/conversation-routine-cards";

const out = resolve(import.meta.dirname, "../.openbot-build/webhook-card-reconnect-e2e"),
  subscriptions = new Set();
let failList = !0,
  listReads = 0,
  statusReads = 0,
  failedRead = () => {};
const failed = new Promise((resolve) => {
    failedRead = resolve;
  }),
  agent = {
    id: "agent-webhook-fixture",
    name: "Webhook fixture",
    title: "",
    description: "",
    notifications: !1,
    provider: "codex",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    threadId: "fixture-thread",
    avatarSeed: "webhook-fixture",
    avatarHue: null,
    avatarUrl: null,
    time: "",
    preview: "",
  },
  routine = {
    id: "fixture-webhook",
    owner: { kind: "agent", id: agent.id },
    name: "Reconnect fixture",
    instruction: "Never runs.",
    active: !1,
    timezone: "UTC",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    trigger: { kind: "webhook", url: "https://example.test/local-fixture", eventType: null, filters: [] },
  },
  message = {
    id: "fixture-marker",
    turnId: "fixture-turn",
    author: "agent",
    body: "",
    time: "",
    kind: "action-marker",
    actionMarker: {
      kind: "routine-lifecycle",
      action: "created",
      routineId: routine.id,
      name: routine.name,
      sourceAgentId: agent.id,
      timestamp: new Date().toISOString(),
    },
  },
  marker = message.actionMarker;
assert.ok(marker);
const host = createServer((request, response) => {
  if (request.url === "/routines") {
    listReads += 1;
    response
      .writeHead(failList ? 503 : 200, { "content-type": "application/json" })
      .end(JSON.stringify(failList ? { error: "The local fixture is unavailable." } : [routine]));
  } else if (request.url === "/status") {
    statusReads += 1;
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ supported: !0, connected: !0 }));
  } else response.writeHead(404).end();
});
await new Promise((done) => host.listen(0, "127.0.0.1", done));
const address = host.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`,
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", {
  configurable: !0,
  value: {
    openbot: {
      agent: {
        onEvent: (listener) => {
          subscriptions.add(listener);
          return () => subscriptions.delete(listener);
        },
      },
      events: {
        listRoutines: async (input, serverId) => {
          assert.equal(input.owner.kind, "agent");
          assert.equal(input.owner.id, agent.id);
          assert.equal(serverId, "fixture-host");
          const response = await fetch(`${origin}/routines`);
          if (!response.ok) {
            failedRead();
            throw Error("The fixture's first routine load failed.");
          }
          return await response.json();
        },
        getStatus: async () => {
          return await (await fetch(`${origin}/status`)).json();
        },
      },
    },
  },
});
/** @type {import("@openbot/contracts/ipc").ServerSummary} */
const server = {
    id: "fixture-host",
    kind: "remote",
    name: "Fixture host",
    state: "online",
    apiUrl: null,
    remoteDesktopAvailable: !1,
    notificationsMuted: !1,
    notificationsMutedUntil: null,
    logoUrl: null,
    role: "owner",
    active: !0,
    connectionSequence: 1,
    compatibility: {
      localAppVersion: "0.60.3",
      hostAppVersion: "0.60.3",
      localProtocol: { minimum: 1, maximum: 9 },
      hostProtocol: { minimum: 1, maximum: 9 },
      negotiatedProtocol: 9,
      capabilities: ["events-v1"],
    },
  },
  scope = createRoot((dispose) => {
    const [currentServer, setServer] = createSignal(server);
    return {
      cards: createConversationRoutineCards(
        {
          agent,
          get server() {
            return currentServer();
          },
          routines: [],
          availableRoutineIds: [],
        },
        () => [message],
        () => "fixture-thread",
      ),
      setServer,
      currentServer,
      dispose,
    };
  }),
  card = () => scope.cards.webhookRoutineCard(message, marker);
function waitForCard() {
  return new Promise((resolve, reject) => {
    const dispose = createRoot((dispose) => {
        createEffect(card, (value) => {
          if (value) {
            clearTimeout(timeout);
            dispose();
            resolve();
          }
        });
        return dispose;
      }),
      timeout = setTimeout(() => {
        dispose();
        reject(Error("The webhook card did not load after reconnect."));
      }, 1e4);
    flush();
  });
}
const report = { passed: !1, checks: [], listReads: 0, statusReads: 0 },
  pass = (name) => {
    report.checks.push(name);
    process.stdout.write(`PASS ${name}
`);
  };
try {
  flush();
  await failed;
  flush();
  assert.equal(card(), void 0);
  assert.equal(listReads, 1);
  pass("A failed real HTTP load leaves the webhook marker without a card");
  failList = !1;
  scope.setServer({ ...scope.currentServer(), connectionSequence: 2 });
  flush();
  await waitForCard();
  assert.equal(listReads, 2);
  assert.equal(card()?.routine.id, routine.id);
  assert.equal(card()?.routine.owner.kind, routine.owner.kind);
  assert.equal(card()?.routine.owner.id, routine.owner.id);
  assert.equal(scope.cards.webhookRoutines.state.connected, !0);
  pass("Changing only connectionSequence reloads the API and restores the correct webhook card");
  scope.cards.webhookRoutines.setSecret(routine.id, "disposable-fixture-secret");
  flush();
  assert.ok(scope.cards.webhookRoutines.state.secrets[routine.id]);
  scope.setServer({ ...scope.currentServer(), connectionSequence: 3 });
  flush();
  assert.equal(scope.cards.webhookRoutines.state.secrets[routine.id], void 0);
  await waitForCard();
  assert.equal(listReads, 3);
  pass("A later reconnect clears the transient secret and reloads the card");
  scope.setServer({ ...scope.currentServer(), role: "member" });
  flush();
  assert.equal(card(), void 0);
  assert.equal(listReads, 3);
  assert.deepEqual(Object.keys(scope.cards.webhookRoutines.state.secrets), []);
  pass("A member gets no webhook card, secret or additional admin API read");
  scope.dispose();
  assert.equal(subscriptions.size, 0);
  pass("Disposing the real renderer scope removes its routine subscription");
  report.passed = !0;
} catch (error) {
  report.error = error instanceof Error ? error.message : "The webhook card reconnect check failed.";
  process.exitCode = 1;
} finally {
  scope.dispose();
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
  host.closeAllConnections();
  await new Promise((done) => host.close(() => done()));
  report.listReads = listReads;
  report.statusReads = statusReads;
  await mkdir(out, { recursive: !0 });
  await writeFile(
    resolve(out, "report.json"),
    `${JSON.stringify(report, null, 2)}
`,
  );
}
process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${resolve(out, "report.json")}
`);
if (report.error)
  process.stdout.write(`${report.error}
`);

// Checks that the host updates the iOS Live Activity when the WebRTC path of the phone fails (#3583).
// iOS can suspend the app before its `away` registration goes out. Signal reports the lost connection
// only about 150 s later, and until then the activity kept "Working" after the turn ended. The failed
// ICE path now marks the session away without closing it, and the path that comes back ends that.
// A request in another thread keeps its notification when the activity shows a different request.
// A completed turn clears only the waits of that same thread and turn in the shared coordinator.
//
// It runs the real Live Activity push service with a synthetic runtime snapshot and a local relay
// adapter, and opens each push with the widget code. It sends nothing. Run it with
// `bun scripts/live-activity-ice-away-e2e.ts`. Writes .openbot-build/live-activity-ice-away-e2e/report.json.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentEvent, AgentRuntimeSnapshot } from "@openbot/contracts/ipc";
import type { LiveActivityRelayPush } from "@openbot/contracts/live-activity-relay";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { mobileTranslateFor } from "@openbot/i18n/mobile";
import { createOpenBotLogger } from "@openbot/logging";
import { DynamicIslandCoordinator } from "@openbot/team-client/dynamic-island-coordinator";
import { liveActivityIslandText } from "@openbot/team-client/live-activity-props";
import {
  encodeLiveActivityBytes,
  LIVE_ACTIVITY_SECRET_BYTES,
  liveActivityKeys,
} from "@openbot/team-client/live-activity-seal";
import { Effect } from "effect";
import { openSealedLiveActivity } from "../apps/mobile/src/features/live-activity/model/live-activity-open";
import { LiveActivityPushService } from "../src/main/live-activity-push";
import type { PushNotificationSubject } from "../src/main/push-notifications";

const OUT = resolve(import.meta.dirname, "../.openbot-build/live-activity-ice-away-e2e");
const STEP_DEADLINE_MS = 10_000;
const SESSION = "fixture-session";
const AGENT = "fixture-agent";
const REPLY = { agentId: AGENT, kind: "reply" } as const;
const logger = createOpenBotLogger("live-activity-ice-away-e2e");

const events = new EventEmitter<{ event: [AgentEvent] }>();
const secret = randomBytes(LIVE_ACTIVITY_SECRET_BYTES);
const keys = liveActivityKeys(secret);
const pushes: LiveActivityRelayPush[] = [];
const waiters = new Set<() => void>();
let working = true;
type RuntimeAttention = Pick<AgentRuntimeSnapshot, "pendingPrompts" | "pendingApprovals" | "pendingBrowserTakeovers">;
const noAttention: RuntimeAttention = { pendingPrompts: [], pendingApprovals: [], pendingBrowserTakeovers: [] };
let attention = noAttention;

function snapshot(): AgentRuntimeSnapshot {
  return {
    agents: [
      {
        id: AGENT,
        name: "Fixture agent",
        notifications: true,
        preview: "Done.",
        updatedAt: "2026-10-28T00:00:00.000Z",
        avatarSeed: AGENT,
        avatarHue: null,
        avatarUrl: null,
      },
    ],
    activeTurns: working ? [{ agentId: AGENT, threadId: AGENT, turnId: "fixture-turn" }] : [],
    work: [],
    latestMessages: working
      ? []
      : [{ agentId: AGENT, id: "fixture-message", text: "Done.", createdAt: "2026-10-28T00:00:00.000Z" }],
    attentionComplete: true,
    ...attention,
    failedTurns: [],
  };
}

function attentionCases(): {
  name: string;
  attention: RuntimeAttention;
  subject: Extract<PushNotificationSubject, { requestId: string | number }>;
}[] {
  const requests = [1, 2].map((requestId) => ({
    requestId,
    agentId: AGENT,
    threadId: `fixture-side-${requestId}`,
    turnId: `fixture-wait-${requestId}`,
  }));
  return [
    {
      name: "question",
      attention: {
        ...noAttention,
        pendingPrompts: requests.map((request) => ({
          ...request,
          questions: [{ id: "q", header: "Question", question: "Which one?", options: null, isSecret: false }],
        })),
      },
      subject: { agentId: AGENT, kind: "input", requestId: 2 },
    },
    {
      name: "approval",
      attention: {
        ...noAttention,
        pendingApprovals: requests.map((request) => ({
          ...request,
          kind: "command",
          command: "fixture-command",
          cwd: null,
          reason: null,
          grantRoot: null,
          permissions: null,
          truncated: false,
        })),
      },
      subject: { agentId: AGENT, kind: "approval", requestId: 2 },
    },
    {
      name: "takeover",
      attention: {
        ...noAttention,
        pendingBrowserTakeovers: requests.map((request) => ({ ...request, tabId: `fixture-tab-${request.requestId}` })),
      },
      subject: { agentId: AGENT, kind: "browser", requestId: 2 },
    },
  ];
}

/** Waits for push number `count`, which can already have gone out. */
function pushNumber(count: number): Promise<LiveActivityRelayPush> {
  return new Promise((resolvePush, reject) => {
    const deadline = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`No push number ${count} before the deadline.`));
    }, STEP_DEADLINE_MS);
    const check = () => {
      const push = pushes[count - 1];
      if (!push) return;
      clearTimeout(deadline);
      waiters.delete(check);
      resolvePush(push);
    };
    waiters.add(check);
    check();
  });
}

function shownMode(push: LiveActivityRelayPush): string {
  assert.equal(push.event, "update");
  assert.ok(push.sealed, "An update must carry sealed content.");
  const opened = openSealedLiveActivity(
    push.sealed,
    encodeLiveActivityBytes(keys.seal),
    encodeLiveActivityBytes(keys.tag),
  );
  assert.ok(opened, "The widget must open the push.");
  const props = JSON.parse(opened);
  assert.ok(isDynamicRecord(props) && typeof props.mode === "string");
  return props.mode;
}

const steps: { name: string; passed: boolean; detail?: unknown }[] = [];
async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    steps.push({ name, passed: true, detail: await run() });
  } catch (error) {
    steps.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

const service = new LiveActivityPushService({
  agents: {
    on: (event, listener) => events.on(event, listener),
    off: (event, listener) => events.off(event, listener),
    getRuntimeSnapshot: snapshot,
    listConversationReads: () => ({
      [AGENT]: working
        ? { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null }
        : { unreadCount: 1, firstUnreadMessageId: "fixture-message", throughMessageId: null },
    }),
  },
  send: (push) =>
    Effect.sync(() => {
      pushes.push(push);
      for (const wake of waiters) wake();
      return "sent" as const;
    }),
  memberActive: (memberId) => memberId === "fixture-member",
  randomBytes,
});

let passed = false;
try {
  await step("a phone in the foreground gets no push", async () => {
    service.register(
      SESSION,
      {
        memberId: "fixture-member",
        hiddenAgentIds: () => new Set<string>(),
        readOptions: {
          excludeRoutineEvents: true,
          excludeRoutineRunEvents: true,
          excludeHostedSiteEvents: true,
          excludeRoutineQuietAnswers: true,
        },
      },
      {
        serverId: "fixture-server",
        token: "ab".repeat(32),
        environment: "development",
        secret: encodeLiveActivityBytes(secret),
        locale: "en",
        away: false,
        photos: [],
      },
    );
    // `showsEvent` is true only while the host counts the phone as away, which is when it pushes.
    assert.equal(service.showsEvent(SESSION, REPLY, null, null), false);
    assert.equal(pushes.length, 0);
    return { away: false, pushes: pushes.length };
  });

  await step("a failed path sends the host state at once", async () => {
    service.disconnected(SESSION);
    // The island shows the work, so it does not show a reply or a question: the phone gets a notification.
    assert.equal(service.showsEvent(SESSION, REPLY, null, null), false);
    assert.equal(service.showsEvent(SESSION, { agentId: AGENT, kind: "input", requestId: 1 }, null, null), false);
    const mode = shownMode(await pushNumber(1));
    assert.equal(mode, "working");
    return { away: true, mode };
  });

  await step("the end of the turn reaches the activity while the path is lost", async () => {
    working = false;
    events.emit("event", {
      type: "turn-completed",
      agentId: AGENT,
      threadId: AGENT,
      turnId: "fixture-turn",
      status: "completed",
    });
    const mode = shownMode(await pushNumber(2));
    assert.notEqual(mode, "working");
    return { mode };
  });

  await step("a path that comes back stops the host pushes and drops a waiting alert", async () => {
    // An event alert waits for the event delay. The path comes back before it goes out.
    assert.equal(service.showsEvent(SESSION, REPLY, { sound: "default" }, null), true);
    service.reconnected(SESSION);
    assert.equal(service.showsEvent(SESSION, REPLY, null, null), false);
    return { away: false };
  });

  await step("a second failed path sends the same view again, with no old alert", async () => {
    // The phone showed its own state in between, so the host must not skip a view equal to its last push.
    service.disconnected(SESSION);
    const push = await pushNumber(3);
    const mode = shownMode(push);
    assert.equal(mode, "message");
    assert.equal(push.alert, null);
    return { mode, alert: push.alert };
  });

  for (const item of attentionCases()) {
    await step(`a hidden ${item.name} keeps its notification`, async () => {
      attention = item.attention;
      assert.equal(service.showsEvent(SESSION, item.subject, null, null), true);
      assert.equal(service.showsEvent(SESSION, { ...item.subject, requestId: 1 }, null, null), false);
      assert.equal(service.showsEvent(SESSION, { ...item.subject, requestId: "2" }, null, null), true);
      const nextPush = pushes.length + 1;
      events.emit("event", { type: "runtime-snapshot", snapshot: snapshot() });
      const mode = shownMode(await pushNumber(nextPush));
      assert.equal(mode, item.name);
      return { mode, displayedRequest: 2, hiddenRequestNotifies: true };
    });

    await step(`another thread ending keeps the pending ${item.name}`, async () => {
      const coordinator = new DynamicIslandCoordinator(() => liveActivityIslandText(mobileTranslateFor("en")));
      const serverId = "fixture-background-server";
      coordinator.applyEvent({ serverId, event: { type: "runtime-snapshot", snapshot: snapshot() } }, "foreground");
      const complete = (threadId: string, turnId: string) => {
        coordinator.applyEvent(
          { serverId, event: { type: "turn-completed", agentId: AGENT, threadId, turnId, status: "completed" } },
          "foreground",
        );
      };
      const otherTurns: [string, string][] = [
        [AGENT, "fixture-other-turn"],
        [AGENT, "fixture-wait-2"],
        ["fixture-side-2", "fixture-other-turn"],
      ];
      for (const [threadId, turnId] of otherTurns) {
        complete(threadId, turnId);
        const presentation = coordinator.presentation([serverId]);
        assert.equal(presentation.mode, item.name);
        assert.ok("item" in presentation && "requestId" in presentation.item);
        assert.equal(presentation.item.requestId, 2);
      }
      complete("fixture-side-2", "fixture-wait-2");
      const state = coordinator.serverState(serverId);
      assert.equal(state?.pendingPrompts[AGENT], undefined);
      assert.equal(state?.pendingApprovals[AGENT], undefined);
      return { keptAfterOtherThread: true, clearedAfterOwnTurn: true };
    });
  }
  passed = true;
} catch {
  passed = false;
} finally {
  await Effect.runPromise(service.dispose());
  const listenersRemaining = events.listenerCount("event");
  if (listenersRemaining !== 0) passed = false;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, "report.json"),
    `${JSON.stringify(
      {
        passed,
        surface:
          "LiveActivityPushService disconnected/reconnected -> coordinator -> seal -> local relay -> widget open",
        transport: "injected local send adapter; no account, APNs, provider, or model",
        steps,
        pushes: pushes.map((push) => ({ event: push.event, priority: push.priority })),
        listenersRemaining,
      },
      null,
      2,
    )}\n`,
  );
}
logger.info(`live-activity-ice-away-e2e: ${passed ? "passed" : "failed"} (${join(OUT, "report.json")})`);
process.exit(passed ? 0 : 1);

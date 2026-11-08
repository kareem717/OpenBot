// Drives real SQLite history queries, bounded tool handlers and persistent review progress.
// No provider, account or user data is used. Writes .openbot-build/history-review-e2e/report.json.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentSummary,
  type ChannelMessage,
  CONTEXT_RESET_ITEM_TYPE,
  type ConversationMessage,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { HistoryReviewTools } from "../src/backend/agent/history-review-tools";
import { HistoryTools } from "../src/backend/agent/history-tools";
import type { OpenBotToolResponse } from "../src/backend/agent/routine-tools";
import { BUILTIN_TOOL_CATALOG } from "../src/backend/agent/tool-catalog";
import { AgentStore } from "../src/backend/agent-store";
import { AgentThreadStore } from "../src/backend/agent-threads/agent-thread-store";
import { ChannelStore } from "../src/backend/channel-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const root = await mkdtemp(join(tmpdir(), "openbot-history-review-"));
const reportPath = resolve(import.meta.dirname, "../.openbot-build/history-review-e2e/report.json");
const cases: string[] = [];
const database = new OpenBotDatabase(root);
const run = runCauseEffect;
function parse<T>(result: OpenBotToolResponse): T {
  assert(result.success);
  return JSON.parse(result.contentItems[0]?.text ?? "null");
}
interface Source {
  sourceKey: string;
  kind: string;
  id: string;
  archived: boolean;
  reviewable: boolean;
}
interface Listing {
  sources: Source[];
  nextCursor: string | null;
  through: string;
}
interface Page {
  messages: Array<{ messageId: string; text: string; nextOffset: number | null }>;
  nextCursor: string | null;
}
interface ChannelPage {
  messages: Array<{ messageId: string; text: string; nextOffset: number | null }>;
  nextCursor: number | null;
}
interface Progress {
  backfillCompleted: boolean;
  completedThrough: string | null;
  exclusions: { sourceKey: string; reason: string }[];
  run: {
    reviewId: string;
    through: string;
    after: string | null;
    sourceCursor: string;
    sourcesReviewed: number;
    observed: {
      sourceKey: string;
      nextCursor: string | number | null;
      pending: { messageId: string; offset: number }[];
    } | null;
    position: { sourceKey: string; nextCursor: string | number | null } | null;
  } | null;
}
const agent: AgentSummary = {
  id: "chief",
  provider: "codex",
  name: "Chief",
  title: "Coordinator",
  description: "",
  notifications: true,
  model: "gpt-6.1-sol",
  reasoningEffort: "medium",
  threadId: "openbot-thread-chief",
  workspacePath: join(root, "chief"),
  preview: "",
  updatedAt: "2026-01-01T00:00:00.000Z",
  avatarSeed: "chief",
  avatarHue: null,
  avatarUrl: null,
};
const foreign = { ...agent, id: "other", name: "Other", threadId: "openbot-thread-other" };
const message = (id: string, text: string, createdAt: string): ConversationMessage => ({
  id,
  author: "user",
  text,
  createdAt,
  status: "completed",
});
try {
  await run(database.initialize());
  database.replaceAgents("history-fixture-roster", [agent, foreign], "agents.updated");
  database.persistConversation(
    {
      agentId: agent.id,
      threadId: agent.threadId,
      activeTurnId: null,
      revision: 0,
      messages: [
        message("old", "Before-reset fact", "2026-01-01T00:00:00.000Z"),
        {
          ...message("reset", "Reset", "2026-02-01T00:00:00.000Z"),
          author: "system",
          source: "system",
          itemType: CONTEXT_RESET_ITEM_TYPE,
        },
        ...Array.from({ length: 27 }, (_, i) =>
          message(`current-${i}`, `Current fact ${i}`, `2026-03-01T00:00:${String(i).padStart(2, "0")}.000Z`),
        ),
      ],
    },
    "history-fixture-chat",
  );
  const threads = new AgentThreadStore(database);
  const archived = threads.create({ agentId: agent.id, title: "Archived task", titleSource: "auto", origin: "user" });
  threads.close(archived.taskId);
  database.persistConversation(
    {
      agentId: agent.id,
      threadId: archived.threadId,
      activeTurnId: null,
      revision: 0,
      messages: [message("archived-fact", "Retained archived task", "2026-03-02T00:00:00.000Z")],
    },
    "history-fixture-archived",
  );
  const channels = new ChannelStore(database);
  const channel = channels.create("review-channel", {
    name: "Review",
    title: "Review channel",
    instructions: "",
    members: [{ agentId: agent.id }],
    leadAgentId: agent.id,
  });
  const channelMessages: ChannelMessage[] = Array.from({ length: 23 }, (_, i) => ({
    id: `channel-${i}`,
    channelId: channel.id,
    sequence: i + 1,
    author: { kind: "member", id: "person", name: "Person" },
    taskId: null,
    superseded: false,
    message: message(
      `channel-${i}`,
      i === 0 ? "Long retained fact ".repeat(800) : `Channel fact ${i}`,
      `2026-03-01T01:00:${String(i).padStart(2, "0")}.000Z`,
    ),
  }));
  channels.commit("history-fixture-channel", {
    channel: { ...channel, archived: true },
    messages: channelMessages,
    tasks: [],
    assignments: [],
  });
  const isolated = channels.create("zz-isolated", {
    name: "Private channel",
    title: "",
    instructions: "",
    isolated: true,
    members: [{ agentId: agent.id }],
    leadAgentId: agent.id,
  });
  channels.commit("history-fixture-isolated", { channel: isolated, messages: [], tasks: [], assignments: [] });
  const store = new AgentStore(root, join(root, "home"), database);
  let review = new HistoryReviewTools(database, channels, (text) => text);
  const history = new HistoryTools({
    store,
    redact: (text) => text,
    capturedSteps: () => Effect.succeed(null),
    reviewedPage: (owner, threadId, input, page) => review.recordRead(owner, `thread:${threadId}`, input, page),
  });
  const call = async <T>(tool: string, args: unknown): Promise<T> =>
    parse<T>(await run(review.call(agent.id, tool, args)));
  const read = async (args: unknown) =>
    parse<Page>(await run(history.call(agent.id, agent.threadId ?? "", "history_read", args)));
  for (const name of ["history_list", "history_review", "history_read_channel"])
    assert(BUILTIN_TOOL_CATALOG.some((tool) => tool.name === `openbot.${name}`));
  cases.push("new-tools-discoverable-in-live-catalog");
  const normal = await read({ limit: 20 });
  assert(!normal.messages.some((entry) => entry.messageId === "old"));
  const allIds: string[] = [];
  let before: string | undefined;
  do {
    const page = await read({ limit: 4, before, includeBeforeReset: true });
    allIds.push(...page.messages.map((entry) => entry.messageId));
    before = page.nextCursor ?? undefined;
  } while (before);
  assert.equal(new Set(allIds).size, 28);
  assert(allIds.includes("old"));
  cases.push("full-retained-thread-pages-with-pre-reset-history-and-no-duplicates");
  const window = await read({
    includeBeforeReset: true,
    after: "2026-03-01T00:00:10.000Z",
    through: "2026-03-01T00:00:15.000Z",
  });
  assert.deepEqual(
    new Set(window.messages.map((entry) => entry.messageId)),
    new Set(Array.from({ length: 5 }, (_, i) => `current-${i + 11}`)),
  );
  cases.push("fixed-time-window-has-contiguous-exclusive-after-inclusive-through");
  assert.equal(database.ownsReviewThread(agent.id, foreign.threadId), false);
  await assert.rejects(run(history.call(agent.id, foreign.threadId, "history_read", {})));
  await assert.rejects(run(review.call(foreign.id, "history_read_channel", { channelId: channel.id })));
  cases.push("foreign-thread-and-nonmember-channel-reads-refused");
  const started = await call<Progress>("history_review", { action: "start", timezone: "America/Toronto" });
  assert(started.run);
  const reviewId = started.run.reviewId;
  let listing = await call<Listing>("history_list", { through: started.run.through, limit: 1 });
  const sources = [...listing.sources];
  while (listing.nextCursor) {
    listing = await call<Listing>("history_list", { cursor: listing.nextCursor, limit: 1 });
    sources.push(...listing.sources);
  }
  assert.equal(sources.length, 4);
  assert(sources.some((source) => source.id === archived.threadId && source.archived));
  assert(sources.some((source) => source.id === channel.id && source.archived));
  assert(!sources.some((source) => source.id === foreign.threadId));
  cases.push("stable-source-pagination-includes-archived-threads-and-member-channels");
  assert.equal(
    (await call<{ status: string }>("history_review", { action: "complete", reviewId })).status,
    "review-incomplete",
  );
  await call("history_review", { action: "checkpoint", reviewId, sourceKey: sources[0]?.sourceKey, nextCursor: 10 });
  review = new HistoryReviewTools(database, channels, (text) => text);
  const resumed = await call<Progress>("history_review", { action: "start" });
  assert.equal(resumed.run?.reviewId, reviewId);
  assert.equal(resumed.run?.position?.nextCursor, 10);
  assert.equal(resumed.run?.sourcesReviewed, 0);
  assert.equal(
    (
      await call<{ status: string }>("history_review", {
        action: "checkpoint",
        reviewId,
        sourceKey: sources[1]?.sourceKey,
        nextCursor: null,
        sourceComplete: true,
      })
    ).status,
    "source-order",
  );
  assert.equal(
    (
      await call<{ status: string }>("history_review", {
        action: "checkpoint",
        reviewId,
        sourceKey: sources[0]?.sourceKey,
        nextCursor: null,
        sourceComplete: true,
      })
    ).status,
    "source-incomplete",
  );
  cases.push("restart-resumes-uncommitted-page-and-refuses-skipped-sources");
  const channelIds: string[] = [];
  let beforeSequence: number | undefined;
  do {
    const page = await call<ChannelPage>("history_read_channel", {
      channelId: channel.id,
      through: started.run.through,
      beforeSequence,
      limit: 3,
    });
    channelIds.push(...page.messages.map((entry) => entry.messageId));
    beforeSequence = page.nextCursor ?? undefined;
  } while (beforeSequence);
  assert.equal(new Set(channelIds).size, 23);
  await call("history_review", {
    action: "checkpoint",
    reviewId,
    sourceKey: sources[0]?.sourceKey,
    nextCursor: null,
    messageId: "channel-0",
    offset: 4000,
  });
  assert.equal(
    (
      await call<{ status: string }>("history_review", {
        action: "checkpoint",
        reviewId,
        sourceKey: sources[0]?.sourceKey,
        nextCursor: null,
        sourceComplete: true,
      })
    ).status,
    "source-incomplete",
  );
  cases.push("unfinished-observed-text-cannot-be-discarded-by-a-complete-checkpoint");
  let longText = "";
  let offset = 0;
  do {
    const page = await call<ChannelPage>("history_read_channel", {
      channelId: channel.id,
      messageId: "channel-0",
      offset,
      through: started.run.through,
    });
    const entry = page.messages[0];
    assert(entry);
    longText += entry.text;
    offset = entry.nextOffset ?? 0;
  } while (offset);
  assert.equal(longText, channelMessages[0]?.message.text);
  cases.push("channel-pagination-and-long-message-offsets-read-every-character");
  for (const source of sources) {
    if (source.kind === "thread") {
      let cursor: string | undefined;
      do {
        const page = parse<Page>(
          await run(
            history.call(agent.id, source.id, "history_read", {
              includeBeforeReset: true,
              through: started.run.through,
              before: cursor,
              limit: 4,
            }),
          ),
        );
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    if (!source.reviewable)
      assert.equal(
        (await call<{ status: string }>("history_read_channel", { channelId: source.id })).status,
        "isolated-channel",
      );
    const checkpoint = await call<Progress>("history_review", {
      action: "checkpoint",
      reviewId,
      sourceKey: source.sourceKey,
      nextCursor: null,
      sourceComplete: true,
      ...(!source.reviewable ? { exclude: true } : {}),
    });
    assert(checkpoint.run, `Source ${source.sourceKey} was not acknowledged`);
    assert.equal(checkpoint.run.sourceCursor, source.sourceKey);
  }
  const complete = await call<Progress>("history_review", { action: "complete", reviewId });
  assert.equal(complete.backfillCompleted, true);
  assert.equal(complete.completedThrough, started.run.through);
  assert.deepEqual(complete.exclusions, [{ sourceKey: `channel:${isolated.id}`, reason: "isolated-channel" }]);
  cases.push("isolated-channel-is-excluded-without-transcript-or-content-coverage");
  const repeat = await call<Progress>("history_review", { action: "start", mode: "backfill" });
  assert.equal(repeat.run, null);
  cases.push("complete-backfill-stays-complete-and-never-restarts");
  const stateFile = join(root, "history-review-v1", `${createHash("sha256").update(agent.id).digest("hex")}.json`);
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  saved.completedThrough = "2026-01-01T05:00:00.000Z";
  await writeFile(stateFile, JSON.stringify(saved));
  const daily = await call<Progress>("history_review", { action: "start", mode: "daily", timezone: "America/Toronto" });
  assert.equal(daily.run?.after, saved.completedThrough);
  assert(daily.run);
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(daily.run.through));
  assert.equal(local, "00:00");
  cases.push("daily-window-catches-up-without-a-gap-and-ends-at-local-midnight");
  const recovery = async <T>(tool: string, args: unknown): Promise<T> =>
    parse<T>(await run(review.call(foreign.id, tool, args)));
  const revokedChannel = channels.create("a-revoked", {
    name: "Revocation fixture",
    title: "",
    instructions: "",
    members: [{ agentId: foreign.id }],
    leadAgentId: foreign.id,
  });
  const revokedMessages = channelMessages
    .slice(1, 4)
    .map((entry, index) => ({ ...entry, id: `revoked-${index}`, channelId: revokedChannel.id }));
  channels.commit("recovery-channel", {
    channel: revokedChannel,
    messages: revokedMessages,
    tasks: [],
    assignments: [],
  });
  const retained = "zz-retained-primary";
  database.connection
    .prepare("INSERT INTO projection_threads VALUES (?, ?, ?, NULL, ?, ?, 0)")
    .run(retained, foreign.id, "Retained old chat", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.persistConversation(
    {
      agentId: foreign.id,
      threadId: retained,
      activeTurnId: null,
      revision: 0,
      messages: [
        message("retained-one", "First retained fact", "2026-03-01T00:00:00.000Z"),
        message("retained-two", "Second retained fact", "2026-03-01T00:00:01.000Z"),
      ],
    },
    "recovery-retained",
  );
  const recovering = await recovery<Progress>("history_review", { action: "start", timezone: "America/Toronto" });
  assert(recovering.run);
  const recoveryId = recovering.run.reviewId;
  const recoveryThrough = recovering.run.through;
  const partial = await recovery<ChannelPage>("history_read_channel", {
    channelId: revokedChannel.id,
    through: recoveryThrough,
    limit: 1,
  });
  assert(partial.nextCursor !== null);
  await recovery("history_review", {
    action: "checkpoint",
    reviewId: recoveryId,
    sourceKey: `channel:${revokedChannel.id}`,
    nextCursor: partial.nextCursor,
  });
  const inserted = channels.create("0-inserted-earlier", {
    name: "Inserted fixture",
    title: "",
    instructions: "",
    members: [{ agentId: foreign.id }],
    leadAgentId: foreign.id,
  });
  channels.commit("recovery-earlier-source", {
    channel: { ...inserted, createdAt: "2026-01-01T00:00:00.000Z" },
    messages: [],
    tasks: [],
    assignments: [],
  });
  const withEarlier = await recovery<Progress>("history_review", { action: "status" });
  assert.equal(withEarlier.run?.observed?.sourceKey, `channel:${revokedChannel.id}`);
  assert.equal(withEarlier.run?.position?.sourceKey, `channel:${revokedChannel.id}`);
  channels.delete(inserted.id);
  channels.commit("recovery-revoke-member", {
    channel: { ...revokedChannel, members: [] },
    messages: [],
    tasks: [],
    assignments: [],
  });
  await assert.rejects(recovery("history_read_channel", { channelId: revokedChannel.id, through: recoveryThrough }));
  const revoked = await recovery<Progress>("history_review", { action: "status" });
  assert.equal(revoked.run?.position, null);
  assert.equal(revoked.run?.observed, null);
  assert.equal(revoked.run?.sourcesReviewed, 0);
  cases.push("membership-revocation-clears-stale-cursors-but-earlier-insertion-does-not");
  await run(
    history.call(foreign.id, foreign.threadId, "history_read", { includeBeforeReset: true, through: recoveryThrough }),
  );
  const continued = await recovery<Progress>("history_review", {
    action: "checkpoint",
    reviewId: recoveryId,
    sourceKey: `thread:${foreign.threadId}`,
    nextCursor: null,
    sourceComplete: true,
  });
  assert.equal(continued.run?.sourcesReviewed, 1);
  await run(
    history.call(foreign.id, retained, "history_read", {
      includeBeforeReset: true,
      through: recoveryThrough,
      limit: 1,
    }),
  );
  const finalPending = await recovery<Progress>("history_review", { action: "status" });
  assert(finalPending.run?.observed?.nextCursor);
  assert.equal(finalPending.run?.position, null);
  database.connection.prepare("DELETE FROM projection_threads WHERE thread_id = ?").run(retained);
  const recoveredComplete = await recovery<Progress>("history_review", { action: "complete", reviewId: recoveryId });
  assert.equal(recoveredComplete.backfillCompleted, true);
  assert.deepEqual(
    recoveredComplete.exclusions.map((entry) => entry.sourceKey).sort(),
    [`channel:${revokedChannel.id}`, `thread:${retained}`].sort(),
  );
  assert(recoveredComplete.exclusions.every((entry) => entry.reason === "vanished-or-revoked"));
  cases.push("final-source-disappearance-records-exclusion-before-review-completes");

  const repair = { ...agent, id: "repair", name: "Repair fixture", threadId: "openbot-thread-repair" };
  database.replaceAgents("restart-source-roster", [agent, foreign, repair], "agents.updated");
  const repairing = async <T>(tool: string, args: unknown): Promise<T> =>
    parse<T>(await run(review.call(repair.id, tool, args)));
  const staleChannel = channels.create("b-stale-message", {
    name: "Stale message fixture",
    title: "",
    instructions: "",
    members: [{ agentId: repair.id }],
    leadAgentId: repair.id,
  });
  const staleMessages = [channelMessages[1], channelMessages[0]].map((entry, index) => {
    assert(entry);
    return { ...entry, id: `stale-${index}`, channelId: staleChannel.id };
  });
  channels.commit("restart-source-channel", {
    channel: staleChannel,
    messages: staleMessages,
    tasks: [],
    assignments: [],
  });
  const repairingRun = await repairing<Progress>("history_review", { action: "start", timezone: "America/Toronto" });
  assert(repairingRun.run);
  const repairId = repairingRun.run.reviewId;
  const repairThrough = repairingRun.run.through;
  const stalePage = await repairing<ChannelPage>("history_read_channel", {
    channelId: staleChannel.id,
    through: repairThrough,
  });
  assert(stalePage.messages.some((entry) => entry.nextOffset !== null));
  const removed = channels.message(staleChannel.id, "stale-1");
  assert(removed);
  channels.deleteMessage(staleChannel, removed);
  await assert.rejects(
    repairing("history_read_channel", {
      channelId: staleChannel.id,
      through: repairThrough,
      messageId: removed.id,
      offset: 4000,
    }),
  );
  const restarted = await repairing<Progress>("history_review", {
    action: "restart_source",
    reviewId: repairId,
    sourceKey: `channel:${staleChannel.id}`,
  });
  assert.equal(restarted.run?.observed, null);
  assert.equal(restarted.run?.position, null);
  assert.equal(restarted.run?.sourceCursor, "");
  assert.equal(restarted.run?.sourcesReviewed, 0);
  assert.equal(
    (
      await repairing<{ status: string }>("history_review", {
        action: "checkpoint",
        reviewId: repairId,
        sourceKey: `channel:${staleChannel.id}`,
        nextCursor: null,
        sourceComplete: true,
      })
    ).status,
    "source-incomplete",
  );
  const retainedPage = await repairing<ChannelPage>("history_read_channel", {
    channelId: staleChannel.id,
    through: repairThrough,
  });
  assert.equal(retainedPage.messages.length, 1);
  assert.equal(retainedPage.messages[0]?.messageId, "stale-0");
  await repairing("history_review", {
    action: "checkpoint",
    reviewId: repairId,
    sourceKey: `channel:${staleChannel.id}`,
    nextCursor: null,
    sourceComplete: true,
  });
  await run(
    history.call(repair.id, repair.threadId, "history_read", { includeBeforeReset: true, through: repairThrough }),
  );
  await repairing("history_review", {
    action: "checkpoint",
    reviewId: repairId,
    sourceKey: `thread:${repair.threadId}`,
    nextCursor: null,
    sourceComplete: true,
  });
  const repairedComplete = await repairing<Progress>("history_review", { action: "complete", reviewId: repairId });
  assert.equal(repairedComplete.backfillCompleted, true);
  cases.push("deleted-pending-message-restarts-only-its-source-and-requires-full-reread");
  await mkdir(join(reportPath, ".."), { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify({ status: "passed", cases, messagesRead: allIds.length, channelMessagesRead: channelIds.length, sources: sources.length, schemaUnchanged: true }, null, 2)}\n`,
  );
  // Machine-readable: no transcript, private configuration or credentials.
  process.stdout.write(`${JSON.stringify({ status: "passed", cases: cases.length, report: reportPath })}\n`);
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
}

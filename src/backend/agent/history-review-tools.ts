import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";
import { Effect } from "effect";
import { z } from "zod";
import { isMemberThinking } from "../channel-history";
import type { ChannelStore } from "../channel-store";
import { databaseRows, requiredNumberColumn, requiredStringColumn } from "../database/database-rows";
import type { OpenBotDatabase } from "../openbot-database";
import { openBotToolResult } from "./routine-tools";
import { toolStep } from "./tool-operation";

const id = z.string().min(1).max(512);
const cursor = z.string().min(1).max(4096);
const pageCursor = z.union([cursor, z.number().int().min(0)]);
const bounds = { after: z.iso.datetime().optional(), through: z.iso.datetime().optional() };
const listShape = {
  cursor: cursor.optional(),
  afterSource: z.string().max(512).describe("Resume after history_review run.sourceCursor.").optional(),
  through: bounds.through,
  limit: z.number().int().min(1).max(25).optional(),
};
const channelShape = {
  channelId: id,
  ...bounds,
  beforeSequence: z.number().int().min(0).optional(),
  messageId: id.optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(10).optional(),
};
const reviewShape = {
  action: z.enum(["status", "start", "checkpoint", "restart_source", "complete"]),
  mode: z.enum(["backfill", "daily"]).optional(),
  timezone: z.string().min(1).max(128).optional(),
  reviewId: id.optional(),
  sourceKey: id.optional(),
  nextCursor: pageCursor.nullable().optional(),
  messageId: id.optional(),
  offset: z.number().int().min(0).optional(),
  sourceComplete: z.boolean().optional(),
  exclude: z.boolean().optional(),
};
const positionSchema = z.strictObject({
  sourceKey: id,
  nextCursor: pageCursor.nullable(),
  messageId: id.optional(),
  offset: z.number().int().min(0).optional(),
});
const exclusionSchema = z.strictObject({ sourceKey: id, reason: z.enum(["isolated-channel", "vanished-or-revoked"]) });
const runSchema = z.strictObject({
  reviewId: id,
  mode: z.enum(["backfill", "daily"]),
  after: z.iso.datetime().nullable(),
  through: z.iso.datetime(),
  timezone: z.string(),
  sourceCursor: z.string(),
  sourcesReviewed: z.number().int().min(0),
  position: positionSchema.nullable(),
  observed: z
    .strictObject({
      sourceKey: id,
      nextCursor: pageCursor.nullable(),
      pending: z.array(z.strictObject({ messageId: id, offset: z.number().int().min(0) })).max(20),
    })
    .nullable(),
  exclusions: z.array(exclusionSchema),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  agentId: id,
  backfillCompleted: z.boolean(),
  completedThrough: z.iso.datetime().nullable(),
  run: runSchema.nullable(),
  exclusions: z.array(exclusionSchema),
});
type ReviewState = z.infer<typeof stateSchema>;

export interface HistoryReviewReadInput {
  after?: string;
  through?: string;
  before?: string;
  beforeSequence?: number;
  messageId?: string;
  offset?: number;
  includeBeforeReset?: boolean;
}
export interface HistoryReviewReadPage {
  nextCursor: string | number | null;
  messages: { messageId: string; offset: number; nextOffset: number | null }[];
}

class ReviewTransition extends Error {
  constructor(
    readonly status: string,
    readonly instruction: string,
  ) {
    super(instruction);
  }
}

export const HISTORY_REVIEW_TOOL_DEFINITIONS = [
  {
    name: "history_list",
    description:
      "Page your retained chats, archived threads and current-member channels. Keep through fixed; pass nextCursor as cursor until null, or resume from history_review sourceCursor with afterSource. Read ids with history_read or history_read_channel. Other agents' chats and purged data stay unavailable.",
    shape: listShape,
  },
  {
    name: "history_read_channel",
    description:
      "Read a current-member channel from your own chat or routine, also archived. Pass nextCursor as beforeSequence until null; keep after/through fixed. Read long messages with messageId and offset=nextOffset. Starts no channel task. Isolated channels are listed as exclusions; their text stays in channel work.",
    shape: channelShape,
  },
  {
    name: "history_review",
    description:
      "Durable review: start once with backfill, then daily and the user's timezone. start resumes; daily catches up to local midnight. Read history_list sources with run bounds and includeBeforeReset. After memory changes, checkpoint sourceKey/nextCursor and unfinished messageId/offset. sourceComplete needs all text and nextCursor:null. For deleted or changed page/message refs, restart_source with reviewId/sourceKey resets only that source's progress; reread it. complete refuses unread sources.",
    shape: reviewShape,
  },
];

/** Read-only cross-session retrieval and a small, per-agent durable review checkpoint. */
export class HistoryReviewTools {
  constructor(
    readonly database: OpenBotDatabase,
    readonly channels: ChannelStore,
    readonly redact: (text: string) => string,
  ) {}

  readonly call = Effect.fn("HistoryReviewTools.call")(function* (
    this: HistoryReviewTools,
    agentId: string,
    tool: string,
    input: unknown,
  ) {
    return yield* toolStep(() => {
      try {
        if (tool !== "history_review") this.load(agentId);
        if (tool === "history_list") return openBotToolResult(this.list(agentId, input));
        if (tool === "history_read_channel") return openBotToolResult(this.readChannel(agentId, input));
        return openBotToolResult(this.review(agentId, input));
      } catch (error) {
        if (error instanceof ReviewTransition)
          return openBotToolResult({ accepted: false, status: error.status, instruction: error.instruction });
        throw error;
      }
    });
  }).bind(this);

  /** Records only observed text coverage, never transcript content or proposed memories. */
  recordRead(agentId: string, sourceKey: string, input: HistoryReviewReadInput, page: HistoryReviewReadPage): void {
    const state = this.load(agentId);
    const run = state.run;
    if (!run || (sourceKey.startsWith("thread:") && !input.includeBeforeReset)) return;
    const after = input.after ? new Date(input.after).toISOString() : null;
    const through = input.through ? new Date(input.through).toISOString() : null;
    if (after !== run.after || through !== run.through) return;
    const next = this.database.listReviewSources(agentId, run.sourceCursor, run.through, 1)[0];
    if (next?.sourceKey !== sourceKey || !next.reviewable) return;
    const previous = run.observed;
    if (input.messageId) {
      if (!previous || previous.sourceKey !== sourceKey) return;
      const pending = previous.pending.find((item) => item.messageId === input.messageId);
      const entry = page.messages.find((item) => item.messageId === input.messageId);
      if (!pending || !entry || (input.offset ?? 0) !== pending.offset || entry.offset !== pending.offset) return;
      previous.pending = previous.pending.filter((item) => item.messageId !== input.messageId);
      if (entry.nextOffset !== null) previous.pending.push({ messageId: entry.messageId, offset: entry.nextOffset });
    } else {
      const supplied = input.before ?? input.beforeSequence ?? null;
      if (
        previous &&
        (previous.sourceKey !== sourceKey ||
          previous.pending.length > 0 ||
          previous.nextCursor === null ||
          supplied !== previous.nextCursor)
      )
        return;
      if (!previous && supplied !== null) return;
      run.observed = {
        sourceKey,
        nextCursor: page.nextCursor,
        pending: page.messages.flatMap((entry) =>
          entry.nextOffset === null ? [] : [{ messageId: entry.messageId, offset: entry.nextOffset }],
        ),
      };
    }
    this.save(state);
  }

  private list(agentId: string, input: unknown) {
    const args = z.strictObject(listShape).parse(input);
    const decoded = args.cursor
      ? z
          .strictObject({ agentId: id, after: id, through: z.iso.datetime() })
          .parse(JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8")))
      : null;
    if (
      decoded &&
      (args.afterSource !== undefined ||
        decoded.agentId !== agentId ||
        (args.through && new Date(args.through).toISOString() !== decoded.through))
    )
      this.unavailable();
    const through =
      decoded?.through ?? (args.through ? new Date(args.through).toISOString() : new Date().toISOString());
    const limit = args.limit ?? 15;
    const rows = this.database.listReviewSources(agentId, decoded?.after ?? args.afterSource ?? "", through, limit + 1);
    const sources = rows.slice(0, limit).map((row) => ({ ...row, title: this.redact(redactText(row.title)) }));
    const last = sources.at(-1);
    return {
      sources,
      through,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ agentId, after: last.sourceKey, through })).toString("base64url")
          : null,
      retention:
        "Only retained content is available. Permanently deleted messages, threads and channels were purged; no review can recover them.",
    };
  }

  private readChannel(agentId: string, input: unknown) {
    const args = z.strictObject(channelShape).parse(input);
    const channel = this.channels.get(args.channelId);
    if (!channel.members.some((member) => member.agentId === agentId)) this.unavailable();
    if (channel.isolated)
      throw new ReviewTransition(
        "isolated-channel",
        "This channel keeps its facts inside the channel. Review it through an assigned channel task; this personal review must record an exclusion.",
      );
    const after = args.after ? new Date(args.after).toISOString() : null;
    const through = args.through ? new Date(args.through).toISOString() : null;
    const selected = databaseRows(
      this.database.connection
        .prepare(`SELECT message_id, sequence FROM projection_channel_messages
      WHERE channel_id = ? AND sequence < ? AND json_extract(message_json, '$.deleted') IS NOT 1
      AND (? IS NULL OR json_extract(message_json, '$.message.createdAt') > ?)
      AND (? IS NULL OR json_extract(message_json, '$.message.createdAt') <= ?)
      AND (? IS NULL OR message_id = ?) ORDER BY sequence DESC LIMIT ?`)
        .all(
          args.channelId,
          args.beforeSequence ?? Number.MAX_SAFE_INTEGER,
          after,
          after,
          through,
          through,
          args.messageId ?? null,
          args.messageId ?? null,
          args.messageId ? 1 : (args.limit ?? 5) + 1,
        ),
    );
    const limit = args.messageId ? 1 : (args.limit ?? 5);
    const messages: Array<{
      messageId: string;
      sequence: number;
      author: string;
      createdAt: string;
      text: string;
      offset: number;
      nextOffset: number | null;
      totalCharacters: number;
    }> = [];
    let anchor: number | null = null;
    let more = selected.length > limit;
    for (const row of selected.slice(0, limit)) {
      const sequence = requiredNumberColumn(row, "sequence");
      const message = this.channels.message(args.channelId, requiredStringColumn(row, "message_id"));
      if (!message || isMemberThinking(message)) {
        anchor = sequence;
        continue;
      }
      const text = this.redact(redactText(message.message.text));
      const offset = args.messageId ? (args.offset ?? 0) : 0;
      if (offset > text.length) this.unavailable();
      let size = Math.min(4000, text.length - offset);
      while (JSON.stringify(text.slice(offset, offset + size)).length > 6000) size = Math.floor(size / 2);
      const entry = {
        messageId: message.id,
        sequence,
        author: this.redact(redactText(message.author.name)),
        createdAt: message.message.createdAt,
        text: text.slice(offset, offset + size),
        offset,
        nextOffset: offset + size < text.length ? offset + size : null,
        totalCharacters: text.length,
      };
      if (messages.length && JSON.stringify(openBotToolResult({ messages: [...messages, entry] })).length > 14000) {
        more = true;
        break;
      }
      messages.push(entry);
      anchor = sequence;
    }
    if (args.messageId && messages.length === 0) this.unavailable();
    const result = {
      channelId: channel.id,
      isolated: channel.isolated,
      order: "newest-first",
      after,
      through,
      messages,
      nextCursor: !args.messageId && more ? anchor : null,
    };
    this.recordRead(agentId, `channel:${channel.id}`, args, result);
    return result;
  }

  private review(agentId: string, input: unknown) {
    const args = z.strictObject(reviewShape).parse(input);
    const state = this.load(agentId);
    if (args.action === "status") return state;
    if (args.action === "start") {
      if (state.run) return state;
      const mode = args.mode ?? (state.backfillCompleted ? "daily" : "backfill");
      if (mode === "backfill" && state.backfillCompleted) return state;
      if (mode === "daily" && !state.backfillCompleted)
        throw new ReviewTransition("backfill-required", "Complete the one-time history backfill first.");
      const timezone = args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const now = new Date();
      const through = mode === "backfill" ? now.toISOString() : localMidnight(now, timezone);
      const after =
        mode === "backfill"
          ? null
          : (state.completedThrough ?? localMidnight(new Date(now.getTime() - 36 * 3600000), timezone));
      if (after && after >= through) return state;
      state.run = {
        reviewId: randomUUID(),
        mode,
        after,
        through,
        timezone,
        sourceCursor: "",
        sourcesReviewed: 0,
        position: null,
        observed: null,
        exclusions: [],
      };
    } else {
      const run = state.run;
      if (!run || run.reviewId !== args.reviewId)
        throw new ReviewTransition("review-changed", "Call history_review status and resume its current reviewId.");
      if (args.action === "checkpoint" || args.action === "restart_source") {
        const next = this.database.listReviewSources(agentId, run.sourceCursor, run.through, 1)[0];
        if (!next || next.sourceKey !== args.sourceKey)
          throw new ReviewTransition(
            "source-order",
            "Checkpoint the next source in history_list order; no source may be skipped.",
          );
        if (args.action === "restart_source") {
          run.position = null;
          run.observed = null;
        } else if (args.sourceComplete) {
          if (args.nextCursor !== null || args.messageId || args.offset !== undefined)
            throw new ReviewTransition("source-incomplete", "Finish the source's pages and text before completing it.");
          if (!next.reviewable) {
            if (!args.exclude)
              throw new ReviewTransition(
                "exclusion-required",
                "This source needs a channel-scoped review. Set exclude:true to record the coverage gap.",
              );
            run.exclusions.push({ sourceKey: next.sourceKey, reason: "isolated-channel" });
          } else {
            if (
              args.exclude ||
              !run.observed ||
              run.observed.sourceKey !== next.sourceKey ||
              run.observed.nextCursor !== null ||
              run.observed.pending.length > 0
            )
              throw new ReviewTransition(
                "source-incomplete",
                "Read all source pages and outstanding text offsets with the run's fixed bounds, then checkpoint again.",
              );
            run.sourcesReviewed += 1;
          }
          run.sourceCursor = next.sourceKey;
          run.position = null;
          run.observed = null;
        } else {
          run.position = {
            sourceKey: next.sourceKey,
            nextCursor: args.nextCursor ?? null,
            ...(args.messageId ? { messageId: args.messageId } : {}),
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
          };
        }
      } else {
        if (
          run.position ||
          run.observed ||
          this.database.listReviewSources(agentId, run.sourceCursor, run.through, 1).length > 0
        )
          throw new ReviewTransition(
            "review-incomplete",
            "The review still has unread sources. Resume its checkpoint before completing it.",
          );
        state.backfillCompleted ||= run.mode === "backfill";
        state.completedThrough = run.through;
        state.exclusions = run.exclusions;
        state.run = null;
      }
    }
    this.save(state);
    return state;
  }

  private file(agentId: string): string {
    return join(
      dirname(this.database.path),
      "history-review-v1",
      `${createHash("sha256").update(agentId).digest("hex")}.json`,
    );
  }

  private load(agentId: string): ReviewState {
    const file = this.file(agentId);
    const state: ReviewState = existsSync(file)
      ? stateSchema.parse(JSON.parse(readFileSync(file, "utf8")))
      : { version: 1, agentId, backfillCompleted: false, completedThrough: null, run: null, exclusions: [] };
    if (state.agentId !== agentId) this.unavailable();
    const run = state.run;
    if (run) {
      let reconciled = false;
      const pendingKeys = new Set(
        [run.position?.sourceKey, run.observed?.sourceKey].filter((key): key is string => key !== undefined),
      );
      for (const key of pendingKeys) {
        // A new earlier source is not a revocation. Keep its predecessor's read evidence intact.
        if (this.database.reviewSourceEligible(agentId, key, run.through)) continue;
        if (!run.exclusions.some((entry) => entry.sourceKey === key && entry.reason === "vanished-or-revoked"))
          run.exclusions.push({ sourceKey: key, reason: "vanished-or-revoked" });
        if (run.position?.sourceKey === key) run.position = null;
        if (run.observed?.sourceKey === key) run.observed = null;
        reconciled = true;
      }
      if (reconciled) this.save(state);
    }
    return state;
  }

  private save(state: ReviewState): void {
    const file = this.file(state.agentId);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  private unavailable(): never {
    throw new Error(sourceText("error.agent.historyUnavailable"));
  }
}

/** A local-day boundary, with the timezone offset evaluated at midnight (including DST). */
function localMidnight(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = (value: Date) =>
    Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  const day = parts(date);
  const target = Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day));
  let result = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const shown = parts(new Date(result));
    const wall = Date.UTC(
      Number(shown.year),
      Number(shown.month) - 1,
      Number(shown.day),
      Number(shown.hour),
      Number(shown.minute),
      Number(shown.second),
    );
    result += target - wall;
  }
  return new Date(result).toISOString();
}

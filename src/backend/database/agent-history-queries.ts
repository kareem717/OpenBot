import { CONTEXT_RESET_ITEM_TYPE } from "@openbot/contracts/ipc";
import { ORDER_KEY_COLUMNS, ORDER_KEY_DESC, ORDERED_THREAD_MESSAGES } from "./conversation-queries";
import type { DatabaseCore } from "./database-core";
import {
  databaseRow,
  databaseRows,
  decodeConversationMessageJson,
  optionalStringColumn,
  requiredStringColumn,
} from "./database-rows";

export interface AgentHistorySelection {
  before?: string;
  messageId?: string;
  author?: string;
  includeBeforeReset?: boolean;
  after?: string;
  through?: string;
  limit: number;
}

/** Model history reads use a thread and reset boundary; UI history remains unchanged. */
export class AgentHistoryQueries {
  readonly #core: DatabaseCore;
  constructor(core: DatabaseCore) {
    this.#core = core;
  }

  read(agentId: string, threadId: string, selection: AgentHistorySelection) {
    const owner = this.#core.connection
      .prepare("SELECT thread_id FROM projection_threads WHERE thread_id = ? AND agent_id = ?")
      .get(threadId, agentId);
    if (!owner) throw new Error("History is unavailable in this conversation.");
    const cte = `${ORDERED_THREAD_MESSAGES}, visible AS (
      SELECT ordered.*, message.message_json FROM ordered
      JOIN projection_thread_messages message ON message.thread_id = ? AND message.message_id = ordered.message_id
    ), boundary AS (
      SELECT * FROM visible WHERE item_type = ? AND author = 'system'
      AND json_extract(message_json, '$.source') = 'system' AND json_extract(message_json, '$.status') = 'completed'
      ORDER BY ${ORDER_KEY_DESC} LIMIT 1
    ), allowed AS (
      SELECT * FROM visible WHERE ${selection.includeBeforeReset ? "1" : "0"} = 1 OR NOT EXISTS (SELECT 1 FROM boundary)
      OR (${ORDER_KEY_COLUMNS}) > (SELECT ${ORDER_KEY_COLUMNS} FROM boundary)
    )`;
    const bindings = [threadId, threadId, CONTEXT_RESET_ITEM_TYPE];
    const reset = databaseRow(this.#core.connection.prepare(`${cte} SELECT message_id FROM boundary`).get(...bindings));
    const resetMessageId = !selection.includeBeforeReset && reset ? requiredStringColumn(reset, "message_id") : null;
    const anchorId = selection.messageId ?? selection.before;
    if (
      anchorId &&
      !this.#core.connection
        .prepare(`${cte} SELECT message_id FROM allowed WHERE message_id = ?`)
        .get(...bindings, anchorId)
    ) {
      throw new Error("History reference is unavailable. Read recent history again.");
    }
    const rows = databaseRows(
      this.#core.connection
        .prepare(`${cte}
      SELECT message_json,
        (SELECT provider_session_id FROM projection_turns WHERE thread_id = ? AND turn_id = json_extract(allowed.message_json, '$.turnId')) AS provider_session_id
      FROM allowed WHERE author IN ('user', 'assistant', 'agent')
        AND COALESCE(item_type, '') != 'commentary'
        AND COALESCE(json_extract(message_json, '$.delivery.status'), 'completed') IN ('completed', 'failed', 'interrupted')
        AND (? IS NULL OR author = ?)
        AND (? IS NULL OR message_id = ?)
        AND (? IS NULL OR created_at > ?)
        AND (? IS NULL OR created_at <= ?)
        AND (? IS NULL OR (${ORDER_KEY_COLUMNS}) < (SELECT ${ORDER_KEY_COLUMNS} FROM allowed WHERE message_id = ?))
      ORDER BY ${ORDER_KEY_DESC} LIMIT ?`)
        .all(
          ...bindings,
          threadId,
          selection.author ?? null,
          selection.author ?? null,
          selection.messageId ?? null,
          selection.messageId ?? null,
          selection.after ?? null,
          selection.after ?? null,
          selection.through ?? null,
          selection.through ?? null,
          selection.before ?? null,
          selection.before ?? null,
          selection.limit,
        ),
    );
    return {
      resetMessageId,
      messages: rows.map((row) => ({
        message: decodeConversationMessageJson(requiredStringColumn(row, "message_json")),
        providerSessionId: optionalStringColumn(row, "provider_session_id"),
      })),
    };
  }

  /** Explicit review reads never expose a channel's execution context or an external messaging thread. */
  ownsReviewThread(agentId: string, threadId: string): boolean {
    return (
      this.#core.connection
        .prepare(`SELECT 1 FROM projection_threads t
      WHERE t.agent_id = ? AND t.thread_id = ?
      AND NOT EXISTS (SELECT 1 FROM projection_channel_contexts c WHERE c.thread_id = t.thread_id)
      AND NOT EXISTS (SELECT 1 FROM projection_messaging_threads m WHERE m.thread_id = t.thread_id)`)
        .get(agentId, threadId) !== undefined
    );
  }

  /** Stable source ids page independently of activity, so a busy chat cannot move behind the cursor. */
  listReviewSources(agentId: string, after: string, through: string, limit: number, sourceKey?: string) {
    return databaseRows(
      this.#core.connection
        .prepare(`WITH sources AS (
      SELECT 'thread:' || t.thread_id AS source_key, 'thread' AS kind, t.thread_id AS id,
        COALESCE(side.title, t.title) AS title, side.archived_at IS NOT NULL AS archived, 0 AS isolated, t.created_at AS created_at
      FROM projection_threads t LEFT JOIN projection_agent_threads side ON side.thread_id = t.thread_id
      WHERE t.agent_id = ?
        AND NOT EXISTS (SELECT 1 FROM projection_channel_contexts c WHERE c.thread_id = t.thread_id)
        AND NOT EXISTS (SELECT 1 FROM projection_messaging_threads m WHERE m.thread_id = t.thread_id)
      UNION ALL
      SELECT 'channel:' || c.channel_id, 'channel', c.channel_id,
        json_extract(c.channel_json, '$.name'), COALESCE(json_extract(c.channel_json, '$.archived'), 0), COALESCE(json_extract(c.channel_json, '$.isolated'), 0),
        json_extract(c.channel_json, '$.createdAt')
      FROM projection_channels c
      WHERE EXISTS (SELECT 1 FROM json_each(c.channel_json, '$.members') member
        WHERE json_extract(member.value, '$.agentId') = ?)
    ) SELECT * FROM sources WHERE source_key > ? AND created_at <= ?
      AND (? IS NULL OR source_key = ?) ORDER BY source_key LIMIT ?`)
        .all(agentId, agentId, after, through, sourceKey ?? null, sourceKey ?? null, limit),
    ).map((row) => ({
      sourceKey: requiredStringColumn(row, "source_key"),
      kind: requiredStringColumn(row, "kind"),
      id: requiredStringColumn(row, "id"),
      title: requiredStringColumn(row, "title"),
      archived: row.archived === 1,
      reviewable: row.isolated !== 1,
      ...(row.isolated === 1 ? { exclusion: "isolated-channel" } : {}),
    }));
  }
}

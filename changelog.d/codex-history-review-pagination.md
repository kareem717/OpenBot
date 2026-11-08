### Added

- Agents can now list all their retained chats and side threads in pages, including archived
  threads and retained messages before a context reset. The normal history tools still read only
  after the latest reset unless a review explicitly requests older messages. Agents cannot select
  another agent's private chat or read a channel's private execution context.

- An agent can read the shared history of a channel it currently belongs to from its own chat or
  a routine, without starting channel work. Archived channels are included. Message cursors and
  long-text offsets let a review read the complete retained text within bounded tool responses.
  Fixed UTC time bounds filter messages before paging. Membership is checked on each call.
  Isolated channels appear as explicit exclusions; their transcript stays inside channel work.

- Session-review routines can now save progress with `history_review`: one full backfill, then
  daily windows through local midnight in the user's timezone. An interrupted run resumes its
  fixed window and saved page position. A completed backfill does not run again. Missed days are
  included in the next daily window. A run cannot finish while a source remains unchecked, and
  the source cursor can advance only in the returned order. Successful read handlers persist
  the observed page cursor and unfinished text offsets. A source cannot be marked complete by
  discarding an unfinished offset or claiming its cursor is null. Unread database lookahead does
  not count. Isolated sources are recorded as exclusions, not content coverage. Known incomplete
  review transitions return a safe status and instructions to resume.

- If a pending source is deleted or channel access is revoked, the review records a
  `vanished-or-revoked` coverage exclusion and clears its stale progress. It can then continue
  without restoring deleted text or bypassing membership. Inserting another source earlier in
  the order does not erase valid evidence. A deleted or changed message anchor can be recovered
  with `restart_source`, which resets only the next source's progress and requires a full reread
  of its retained text. It never advances coverage or restarts a completed backfill.

- Checkpoints prove returned text coverage, not model comprehension, behavior improvement or
  memory persistence. Automatic memory edits can remain staged until turn completion. Review
  routines must distinguish staged edits from committed memory ids and verify persistence on
  a later turn before reporting a successful improvement.

- Existing review routines can use these tools after the host restart. The tools do not create
  or duplicate schedules. Their per-agent progress file is written atomically beside the host
  database. No database migration, schema change, or history deletion is required. Restoring the
  previous application archive rolls back the implementation; the additive progress files can
  remain on disk and are ignored by the previous build.

- Permanently deleted chats, threads, channels, and message text were purged by the existing
  deletion operations and cannot be recovered. Retained deleted or old primary thread records
  remain readable only when they still belong to the reviewing agent.

- Focused verification: `bun scripts/history-review-e2e.ts` drives the real SQLite queries and
  tool handlers with temporary data. It checks complete thread and channel pagination, pre-reset
  and archived content, fixed windows, long-message offsets, ownership and membership refusals,
  checkpoint restart, early-completion and skipped-source refusal, one-time completion, and daily
  catch-up through Toronto midnight. It also checks membership revocation mid-page, a vanished
  final source, and deletion of a pending long message followed by a source-only restart. The
  report is written under `.openbot-build`.

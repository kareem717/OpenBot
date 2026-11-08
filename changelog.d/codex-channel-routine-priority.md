### Fixed

- Channel requests can now reserve an idle agent before a queued background routine starts.
  The existing host turn limit still applies. Starting and running routines finish first;
  they are not interrupted. A ready person or teammate message at the mailbox head keeps its place.

- Recovery moves a queued channel assignment's own delivery to the front of its mailbox.
  This prevents its reservation from blocking another message while the reserved delivery
  waits behind that message. It reuses the stored assignment and request without repeating work.

- Focused verification uses real channel routines, channel commands, SQLite and mailbox state
  with temporary fixture data. It checks queued background priority, active routine holds,
  completion and queue wakes, request replay, restored queue order, and duplicate prevention.
  No database migration, data reset, or released IPC change is required.

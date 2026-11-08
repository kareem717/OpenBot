### Changed

- Merged upstream v0.65.0 into the fork and kept the fork's additions: unlimited capacity and memory,
  history review, browser sign-in and native control, channel routing and the update feed.
- A plan continuation uses upstream's new work-announcement check and also the fork's work verbs.
  "I'll update you" does not continue a turn.
- A session review that names a thread, `includeBeforeReset` or `through` stays in one thread.
  Upstream's search across chats handles the other searches.
- A wait in a side thread still shows in "Needs you" and in the agent dock state.

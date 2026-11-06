### Fixed

- Keep delegated channel work running when a scheduled request or agent handoff arrives. Routing
  can select the same member without replacing that member's earlier task.
- Resume the delegated task branch when a channel message says Continue or Resume, including a
  message addressed to one member. Preserve dependencies and completed results.
- Show queued requests from people in Waiting for replies when the named member cannot start yet.
- Show a stopped task when an agent ends without a required reply. Quiet scheduled requests can
  still finish silently. **Check the task's work before you continue it; OpenBot does not repeat it
  automatically.** Existing stopped tasks keep their saved state.

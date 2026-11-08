### Fixed

- Replies to channel coordinator questions now reach the routing model as the latest task
  direction. The original task instruction stays available as context. Before this change,
  the current reply was excluded from recent context and the coordinator could ask again
  about the old unclear request without seeing the clarification.

- The clarification uses the existing bounded request-text and routing-prompt limits.
  The same task, source links and current request remain durable. Routing still chooses
  the member; the change does not start duplicate tasks or bypass member access checks.
  No database migration, data reset or released IPC change is required.

- The focused real-service E2E checks an unclear request, a linked coordinator question,
  the person's clarification, member assignment and duplicate prevention. It writes a
  report under `.openbot-build/channel-routing-clarification-e2e`.

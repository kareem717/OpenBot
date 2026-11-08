### Fixed

- Cursor payment-method refusals now show a billing error. Channels show the provider's billing
  blocker instead of asking you to reassign a message. Later scheduled runs keep the original billing
  alert instead of adding duplicate stopped tasks.
- Restored browser tabs keep their task chat. Restarting OpenBot no longer moves a task's tab to the
  agent's main chat and leaves the task unable to continue its browser session.
- The server owner can see the live browser during a card-verification takeover. Agent images,
  previews, recordings, and other members' views remain blocked while the page contains a filled card.

### Fixed

- Fix webhook setup in side threads and branches. A direct user message can create, update, or delete a webhook routine there, and its create or update card stays in that thread. Routine runs, agent messages, channel requests, and messaging requests cannot gain this permission.
- Stop automatic plan continuation when the turn posts an MCP sign-in card. The plan waits for a new user message instead of running again while sign-in is needed.
- Show MCP sign-in, routine, and marketplace action cards in side threads and branches. Refresh connector details when a new sign-in card arrives. Continue sends to the card's thread and keeps the composer draft.

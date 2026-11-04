### Fixed

- Stop automatic plan continuation when webhook signing keys, MCP setup, or a cancelled request need the user's action. Detect an explicit wait before a closing status sentence. A later user message can resume the work.
- Restore server capabilities after Retry on a connection that is already open, so thread and browser controls remain available.
- Reload webhook cards after a server reconnects.
- Let an accepted user steering message release its pending browser handoff, so the agent can act on the new message.
- Load external Codex MCP tool definitions through tool search, so large connector lists do not fill the initial context window. Refresh existing provider sessions while keeping the same chats.

### Changed

- Use Bun 1.4.4 for repository checks and release builds, matching the patched runtime already shipped with the app.
- Require managed Codex 0.166.0 or newer for native MCP discovery.

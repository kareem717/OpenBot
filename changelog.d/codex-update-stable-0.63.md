### Changed

- Include the original OpenBot 0.63.0 stable update while keeping the desktop fork's browser,
  credential, channel, input, notification, unlimited collection, and private update fixes.

### Fixed

- Open large channels without the host reply size error. Updated clients and hosts can transfer
  JSON replies up to 100 MiB in chunks, with all saved tasks and messages kept intact.
  Older clients retain their existing transport limits.

### Fixed

- Keep an existing browser automation connection available after supplied credentials are registered.
  Before, a second connection request could fail while the first connection was still live.
- Show browser write request starts, redirects, and response status codes in diagnostics. Agents can
  inspect this evidence when a sign-in page does not advance, without sending passwords or request bodies.

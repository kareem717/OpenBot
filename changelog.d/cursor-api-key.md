### Added

- Cursor can sign in with an API key saved in Settings › Providers › Cursor, on this computer or on a
  joined server whose host advertises `cursor-api-key-v1`. The host gives the key to the Cursor CLI as
  `CURSOR_API_KEY`; a saved key comes before one in the host's environment. The key stays in
  OpenBot's encrypted key store and never goes back to a client.

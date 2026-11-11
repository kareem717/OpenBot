### Fixed

- Hosted egress: keep name lookups working when the host replaces its resolver file, for example
  after a Tailscale update on the host. Before, all providers lost their connection until the
  service restarted. Run `install` and `attach` again, then restart the daemon and the services.

### Changed

- Bring in upstream v0.68.0 and keep the additions of this branch: no capacity limits, paged MCP
  server, skill and channel memory lists, native browser control, the saved Cursor API key, and
  the isolated update feed.

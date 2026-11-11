### Fixed

- Hosted egress: keep name lookups working when the host replaces its resolver file, for example
  after a Tailscale update on the host. Before, all providers lost their connection until the
  service restarted. Run `install` and `attach` again, then restart the daemon and the services.

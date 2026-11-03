# Dedicated exit node for hosted OpenBot

This optional Linux setup routes OpenBot through one Tailscale exit node. It leaves
host SSH, the host Tailscale node, and unrelated services on their current routes.
It uses a new Tailscale identity. Do not copy another service's Tailscale state.

The root helper, config, units, and service drop-ins live outside `/opt/OpenBot`.
An OpenBot update can replace the application and its base units. It does not
replace these files. Keep these files under operator control and review them when
upstream adds a new network-using unit.

## Scope and boundary

The namespace covers `openbot.service`, its terminal/browser/provider/MCP children,
the three updater service units, and installed OpenBot Agent Relay enroll, history,
and identity services. Timers and path units only trigger those services. Each
service uses the same namespace and Tailscale DNS. An NSS override prevents libc
from asking the host `systemd-resolved` over its Unix socket.

Only `tailscaled` enters `openbottunnel.slice`. Its documented `0x80000/0xff0000`
transport mark and its bootstrap DNS sockets can use the physical underlay. All
other output must use loopback or `tailscale0`. This rule applies to IPv4, IPv6,
and root updater jobs. A stopped tunnel leaves application egress blocked.
This is routing isolation for normal processes. An administrator with root access
can change the rules or start a process outside the namespace.

The helper adds one named veth, one dedicated namespace, one owned nftables NAT
table, and two interface-scoped jumps to one owned iptables FORWARD chain. The
jumps allow the owned veth through a host Docker/UFW FORWARD drop policy. They do
not change foreign chains, forwarding policy, host exit-node preferences, or
another service's namespace. Host IPv4 forwarding must already be enabled.

The application still uses its current database, home, files, display, D-Bus,
keyring, and filesystem Unix control socket. Its TCP loopback belongs to the new
namespace. For example, a host SSH tunnel to `127.0.0.1:38231` no longer reaches
the Team API. Use `nsenter` or an explicitly reviewed local bridge. Do not publish
that API to the host network. Check any other host-loopback dependency before
attachment. The new node has its own Tailscale IP. Test remote account sign-in,
WebRTC, display access, and the native client after the service restart.

## Prepare without moving the application

Use Linux with systemd, unified cgroup v2, `iproute2`, nftables, iptables, curl,
Python 3, and a kernel-TUN Tailscale installation. The operator must have root.
Inspect existing routes and firewall ownership before install. Do not use an
underlay subnet that overlaps another route.

Copy `scripts/hosting/egress/` to the server. Create `/etc/openbot-egress` with
mode `0700`. Copy `config.example.json` to `/etc/openbot-egress/config.json`, set
mode `0600`, and set its root ownership. Replace the placeholder values:

- `exit_node`: the approved exit node's full Tailscale DNS name or IP.
- `bootstrap_dns`: one to three IPv4 DNS resolvers reachable from the host.
- `expected_exit_ipv4`: the public IPv4 address independently checked on the exit node.
- `expected_exit_ipv6`: optional public IPv6 address, independently checked there.
  Omit this key only if the exit node does not provide IPv6; preflight must prove
  that IPv6 egress is blocked.
- `service_user`: the existing non-root OpenBot service account.
- `link_subnet`: optional unused link-local IPv4 `/30`; default `169.254.177.0/30`.

Do not put this completed file, node state, auth keys, or private addresses in Git.
The helper does not accept an auth key and does not print config values.

```sh
sudo python3 scripts/hosting/egress/openbot-egress.py install
sudo systemctl start openbot-egress-tailscaled.service
sudo /usr/local/libexec/openbot-egress/openbot-egress.py login
```

The login command shows the new node's actual approval URL when authentication
is required. Complete that approval and grant this node access to the exit node.
These steps start only the isolated transport. OpenBot keeps its current network.
The host Tailscale state and exit-node settings stay unchanged.

## Verify before attachment

```sh
sudo /usr/local/libexec/openbot-egress/openbot-egress.py verify
```

Preflight checks the selected online exit node, exact namespace guard fingerprint,
owned FORWARD rules, tunnel route, expected public IPv4 and IPv6, and DNS through
the tunnel. It then stops only the dedicated daemon and checks direct IPv4, IPv6,
and DNS attempts in a root probe service outside the tunnel cgroup. Those attempts
must fail. It restarts the daemon and checks egress again. A successful result
writes a root-only, current-boot proof tied to the config. It cannot run after
application drop-ins are present because that test would stop application units.

Before attachment, record the host public egress and the unrelated firewall and
Tailscale state. The host must stay on its current route. Do not change host
Tailscale preferences to implement this feature.

## Attach and activate after review

```sh
sudo /usr/local/libexec/openbot-egress/openbot-egress.py attach
```

This writes drop-ins for the known installed units, enables the dedicated network
and daemon for boot, and reloads systemd. It does not restart the application.
The main unit's privileged updater trigger uses `!` instead of `+` to retain the
network and resolver namespace while running as root.

Stop the active OpenBot-owned services and restart them in their existing order.
Run the update apply unit before the main unit. Restart existing enabled Relay
services as needed. Do not start enroll services that were not running. Confirm
that each active service's network namespace inode equals
`/run/netns/openbot-egress`, including each updater process while it runs.

Check normal use from the native client: account connection, a provider request,
terminal HTTPS and DNS, browser HTTPS, MCP child traffic, display input, Team API
through the namespace, and an update-feed check. Check that the host public egress,
SSH, host Tailscale identity/preferences, and unrelated service routes and firewall
rules remain unchanged. Do not mark deployment complete until these checks pass.

If the daemon stops, systemd stops attached units. Start the daemon and restart the
application units after repair. There is no direct-network fallback. To remove the
feature, first stop attached application units; review and remove only these owned
`egress.conf` drop-ins, reload systemd, then restart the application on its prior
network. Keep the root config and node state until the operator chooses to remove
them. Do not flush host firewall tables or delete another service's state.

References: [Tailscale exit nodes](https://tailscale.com/docs/features/exit-nodes),
[daemon flags](https://tailscale.com/docs/reference/tailscaled),
[userspace proxy limits](https://tailscale.com/docs/concepts/userspace-networking),
[MagicDNS without DNS replacement](https://tailscale.com/docs/reference/faq/dns-resolv-conf),
[network namespace unit options](https://freedesktop.org/software/systemd/man/latest/systemd.exec.html#NetworkNamespacePath=),
and [nftables socket cgroup matching](https://www.netfilter.org/projects/nftables/manpage.html).

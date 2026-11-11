#!/usr/bin/python3
"""Root-owned OpenBot egress operations. No host exit-node or foreign firewall changes."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import shlex
import socket
import stat
import subprocess
import sys
import time

BASE = Path('/etc/openbot-egress')
RUN = Path('/run/openbot-egress')
LIBEXEC = Path('/usr/local/libexec/openbot-egress')
NS = 'openbot-egress'
HOST_LINK = 'obot-egress0'
PEER_LINK = 'uplink0'
TABLE = 'openbot_egress'
CHAIN = 'OPENBOT-EGRESS'
OWNER = 'openbot-egress-v1'
SOCKET = str(RUN / 'tailscaled.sock')
TAIL = 'openbot-egress-tailscaled.service'
READY = 'openbot-egress-ready.service'
SLICE = 'openbottunnel.slice'
UNITS = ('openbot.service', 'openbot-update.service', 'openbot-update-apply.service',
         'openbot-update-request.service', 'openbot-agent-relay-enroll.service',
         'openbot-agent-relay-history.service', 'openbot-agent-relay-identity.service')


def run(*args, check=True, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True)
    if check and result.returncode:
        # Do not log daemon output: login URLs and operator values can be private.
        raise RuntimeError(f'{args[0]} failed ({result.returncode})')
    return result


def nsrun(*args, **kwargs):
    # Preserve the host cgroup mount so nft can resolve the daemon slice path.
    return run('nsenter', '--net=/run/netns/' + NS, '--', *args, **kwargs)


def private_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise RuntimeError(f'{path} must be a root-owned regular file with mode 0600')
    return path.read_text()


def config():
    directory = BASE.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_mode & 0o077:
        raise RuntimeError('Operator config directory must be root-owned with mode 0700')
    cfg = json.loads(private_file(BASE / 'config.json'))
    allowed = {'exit_node', 'bootstrap_dns', 'expected_exit_ipv4', 'expected_exit_ipv6',
               'link_subnet', 'service_user'}
    if not isinstance(cfg, dict) or set(cfg) - allowed:
        raise RuntimeError('Invalid operator config keys')
    target = cfg.get('exit_node', '')
    if not isinstance(target, str) or not target or len(target) > 253 or any(c.isspace() for c in target) or target.startswith('-'):
        raise RuntimeError('exit_node must be an IP address or Tailscale node name')
    dns = cfg.get('bootstrap_dns', [])
    if not isinstance(dns, list) or not 1 <= len(dns) <= 3:
        raise RuntimeError('Set one to three bootstrap_dns IPv4 addresses')
    cfg['bootstrap_dns'] = [str(ipaddress.IPv4Address(address)) for address in dns]
    cfg['expected_exit_ipv4'] = str(ipaddress.IPv4Address(cfg['expected_exit_ipv4']))
    if cfg.get('expected_exit_ipv6'):
        cfg['expected_exit_ipv6'] = str(ipaddress.IPv6Address(cfg['expected_exit_ipv6']))
    network = ipaddress.IPv4Network(cfg.get('link_subnet', '10.254.177.0/30'))
    private_ranges = map(ipaddress.IPv4Network, ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
    if network.prefixlen != 30 or not any(network.subnet_of(block) for block in private_ranges):
        raise RuntimeError('link_subnet must be an RFC1918 IPv4 /30')
    cfg['subnet'] = str(network)
    cfg['host_ip'], cfg['peer_ip'] = map(str, network.hosts())
    cfg['service_user'] = cfg.get('service_user', 'openbot')
    if pwd.getpwnam(cfg['service_user']).pw_uid == 0:
        raise RuntimeError('OpenBot must use a non-root account')
    return cfg


def write(path, contents, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise RuntimeError(f'Refusing symlink: {path}')
    temp = path.with_name(path.name + '.new')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'w') as file:
        file.write(contents)
    os.replace(temp, path)
    os.chmod(path, mode)


def resolver_bind(source):
    # systemd mounts on the target of the /etc/resolv.conf link. The host replaces that target by
    # rename, and a rename removes a file mount in all other mount namespaces: the service then
    # reads the host stub resolver, which the namespace cannot reach. A mount on the directory
    # of the target stays.
    link = Path('/etc/resolv.conf')
    target = link.resolve()
    if not link.is_symlink() or target.parent == link.parent:
        return f'{source}:{link}'
    return f'{source}.d:{target.parent}'


def write_resolver(source, contents):
    write(source, contents)
    directory = Path(str(source) + '.d')
    write(directory / Path('/etc/resolv.conf').resolve().name, contents)
    # The service account must read the directory after the mount.
    os.chmod(directory, 0o755)


def guard(cfg):
    dns = ', '.join(cfg['bootstrap_dns'])
    return f'''table inet {TABLE} {{
 comment "{OWNER}"
 chain output {{
  type filter hook output priority -10; policy drop;
  oifname "lo" accept
  oifname "tailscale0" accept
  socket cgroupv2 level 1 "{SLICE}" meta mark & 0xff0000 == 0x80000 accept
  socket cgroupv2 level 1 "{SLICE}" ip daddr {{ {dns} }} udp dport 53 accept
  socket cgroupv2 level 1 "{SLICE}" ip daddr {{ {dns} }} tcp dport 53 accept
  counter drop
 }}
}}
'''


def guard_digest():
    data = json.loads(nsrun('nft', '-j', 'list', 'table', 'inet', TABLE).stdout)
    def stable(value):
        if isinstance(value, dict):
            return {key: stable(item) for key, item in value.items()
                    if key not in ('handle', 'packets', 'bytes', 'metainfo')}
        if isinstance(value, list):
            return [stable(item) for item in value if not (isinstance(item, dict) and 'metainfo' in item)]
        return value
    return hashlib.sha256(json.dumps(stable(data), sort_keys=True).encode()).hexdigest()


def table_owned(command):
    result = command('nft', '-j', 'list', 'table', 'inet', TABLE, check=False)
    if result.returncode:
        return False
    tables = [entry['table'] for entry in json.loads(result.stdout)['nftables'] if 'table' in entry]
    if len(tables) != 1 or tables[0].get('comment') != OWNER:
        raise RuntimeError('Firewall table name already has another owner')
    return True


def forward_rules(cfg):
    return [('-s', cfg['peer_ip'] + '/32', '-i', HOST_LINK, '-m', 'comment', '--comment', OWNER, '-j', 'ACCEPT'),
            ('-d', cfg['peer_ip'] + '/32', '-o', HOST_LINK, '-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED', '-m', 'comment', '--comment', OWNER, '-j', 'ACCEPT'),
            ('-m', 'comment', '--comment', OWNER, '-j', 'DROP')]


def forward_jumps():
    return [('-' + direction, HOST_LINK, '-m', 'comment', '--comment', OWNER, '-j', CHAIN) for direction in ('i', 'o')]


def ensure_forward(cfg):
    current = run('iptables', '-w', '-S', CHAIN, check=False)
    expected = [shlex.join(['-A', CHAIN, *rule]) for rule in forward_rules(cfg)]
    if current.returncode == 0:
        actual = [shlex.join(shlex.split(line)) for line in current.stdout.splitlines() if line.startswith('-A ')]
        if actual != expected:
            raise RuntimeError('Owned FORWARD chain has unexpected rules; inspect it before changes')
    else:
        run('iptables', '-w', '-N', CHAIN)
        for rule in forward_rules(cfg):
            run('iptables', '-w', '-A', CHAIN, *rule)
    for rule in forward_jumps():
        if run('iptables', '-w', '-C', 'FORWARD', *rule, check=False).returncode:
            run('iptables', '-w', '-I', 'FORWARD', '1', *rule)


def network(cfg):
    if Path('/proc/sys/net/ipv4/ip_forward').read_text().strip() != '1':
        raise RuntimeError('Host IPv4 forwarding must already be enabled')
    if not Path('/sys/fs/cgroup/' + SLICE).is_dir():
        raise RuntimeError('Start the dedicated tunnel slice first (cgroup v2 required)')
    marker = RUN / 'network.json'
    identity = {'owner': OWNER, 'subnet': cfg['subnet']}
    namespaces = run('ip', 'netns', 'list').stdout.splitlines()
    exists = any(line.split()[0] == NS for line in namespaces)
    if exists:
        if {key: json.loads(private_file(marker)).get(key) for key in identity} != identity:
            raise RuntimeError('Namespace has no matching ownership record')
    else:
        # Fail before mutation if another route/link uses the underlay range or name.
        for route in json.loads(run('ip', '-j', 'route', 'show', 'table', 'all').stdout):
            dest = route.get('dst', 'default')
            if dest != 'default' and ipaddress.ip_network(dest).overlaps(ipaddress.ip_network(cfg['subnet'])):
                raise RuntimeError('Underlay subnet overlaps an existing host route')
        if run('ip', 'link', 'show', HOST_LINK, check=False).returncode == 0:
            raise RuntimeError('Underlay link name already exists')
        run('ip', 'netns', 'add', NS)
        write(marker, json.dumps(identity), 0o600)
    # Install the output drop policy before the namespace gets an uplink.
    prefix = f'delete table inet {TABLE}\n' if table_owned(nsrun) else ''
    nsrun('nft', '-f', '-', data=prefix + guard(cfg))
    link = run('ip', '-j', '-d', 'link', 'show', HOST_LINK, check=False)
    if link.returncode:
        run('ip', 'link', 'add', HOST_LINK, 'type', 'veth', 'peer', 'name', PEER_LINK, 'netns', NS)
        run('ip', 'link', 'set', HOST_LINK, 'alias', OWNER)
    elif json.loads(link.stdout)[0].get('ifalias') != OWNER:
        raise RuntimeError('Underlay link has another owner')
    run('ip', 'address', 'replace', cfg['host_ip'] + '/30', 'dev', HOST_LINK)
    nsrun('ip', 'address', 'replace', cfg['peer_ip'] + '/30', 'dev', PEER_LINK)
    nsrun('ip', 'link', 'set', 'lo', 'up')
    nsrun('ip', 'link', 'set', PEER_LINK, 'up')
    run('ip', 'link', 'set', HOST_LINK, 'up')
    nsrun('ip', 'route', 'replace', 'default', 'via', cfg['host_ip'], 'dev', PEER_LINK)
    # This table owns only NAT for the exact new veth/source. No foreign table is changed.
    prefix = f'delete table inet {TABLE}\n' if table_owned(run) else ''
    run('nft', '-f', '-', data=prefix + f'''table inet {TABLE} {{
 comment "{OWNER}"
 chain source_nat {{
  type nat hook postrouting priority srcnat; policy accept;
  iifname "{HOST_LINK}" ip saddr {cfg['peer_ip']} masquerade
 }}
}}
''')
    ensure_forward(cfg)
    write(marker, json.dumps({**identity, 'guard_sha256': guard_digest()}), 0o600)
    print('Owned namespace and underlay are ready. Host exit-node settings are unchanged.')


def status():
    return json.loads(run('tailscale', '--socket=' + SOCKET, 'status', '--json').stdout)


def ready(cfg):
    data = status()
    exit_node = data.get('ExitNodeStatus') or {}
    if data.get('BackendState') != 'Running' or not exit_node.get('Online'):
        raise RuntimeError('Dedicated exit node is not ready')
    prefs = json.loads(run('tailscale', '--socket=' + SOCKET, 'debug', 'prefs').stdout)
    if not prefs.get('ExitNodeID') or prefs.get('ExitNodeID') != exit_node.get('ID') or prefs.get('ExitNodeAllowLANAccess'):
        raise RuntimeError('Dedicated exit-node preferences are not fail-closed')
    peers = (data.get('Peer') or {}).values()
    selected = next((peer for peer in peers if peer.get('ID') == exit_node.get('ID')), None)
    if selected is None or cfg['exit_node'].rstrip('.') not in [selected.get('HostName'), selected.get('DNSName', '').rstrip('.'), *(selected.get('TailscaleIPs') or [])]:
        raise RuntimeError('Selected exit node differs from operator config')
    if not table_owned(nsrun):
        raise RuntimeError('Namespace output guard is absent')
    marker = json.loads(private_file(RUN / 'network.json'))
    if guard_digest() != marker.get('guard_sha256'):
        raise RuntimeError('Namespace guard changed since setup')
    current = run('iptables', '-w', '-S', CHAIN).stdout
    actual = [shlex.join(shlex.split(line)) for line in current.splitlines() if line.startswith('-A ')]
    expected = [shlex.join(['-A', CHAIN, *rule]) for rule in forward_rules(cfg)]
    if actual != expected:
        raise RuntimeError('Owned FORWARD chain changed since setup')
    for rule in forward_jumps():
        run('iptables', '-w', '-C', 'FORWARD', *rule)
    route = nsrun('ip', '-j', 'route', 'get', '1.1.1.1').stdout
    if json.loads(route)[0].get('dev') != 'tailscale0':
        raise RuntimeError('Internet route does not use the dedicated tunnel')
    return data


def external_ip(family):
    url = 'https://api.ipify.org' if family == 4 else 'https://api6.ipify.org'
    result = run('curl', '-' + str(family), '--fail', '--silent', '--show-error', '--max-time', '12', url, check=False)
    if result.returncode:
        return None
    return str(ipaddress.ip_address(result.stdout.strip()))


def application_dns(cfg):
    # resolv.conf supports three servers. Preserve MagicDNS, then public fallbacks.
    return ['100.100.100.100', *cfg['bootstrap_dns'][:2]]


def dns_query(address, require_answer=False):
    # One uncached UDP query; no host NSS or systemd-resolved socket is used.
    packet = b'\x53\x29\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01'
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(3)
        try:
            sock.sendto(packet, (address, 53))
            response = sock.recv(2048)
            if len(response) < 12 or response[:2] != b'\x53\x29' or not response[2] & 0x80:
                return False
            if require_answer:
                return response[3] & 0x0f == 0 and int.from_bytes(response[6:8], 'big') > 0
            return True
        except (TimeoutError, OSError):
            return False


def probe(cfg, down):
    # This command MUST run in the probe service, never in the tunnel slice.
    if os.stat('/proc/self/ns/net').st_ino != os.stat('/run/netns/' + NS).st_ino:
        raise RuntimeError('Probe is outside the owned namespace')
    if SLICE in Path('/proc/self/cgroup').read_text():
        raise RuntimeError('Probe must not receive the daemon underlay exception')
    if down:
        # Test the TUN DNS and direct underlay DNS, with both UDP and TCP paths.
        for address in dict.fromkeys([*application_dns(cfg), *cfg['bootstrap_dns']]):
            if dns_query(address):
                raise RuntimeError('DNS leaked while the tunnel was stopped')
        for address in [cfg['bootstrap_dns'][0], '2606:4700:4700::1111']:
            family = socket.AF_INET6 if ':' in address else socket.AF_INET
            with socket.socket(family, socket.SOCK_STREAM) as sock:
                sock.settimeout(3)
                if sock.connect_ex((address, 53)) == 0:
                    raise RuntimeError('Direct IP traffic leaked while the tunnel was stopped')
        print(json.dumps({'fail_closed_ipv4': True, 'fail_closed_ipv6': True, 'fail_closed_dns': True}))
    else:
        ipv4, ipv6 = external_ip(4), external_ip(6)
        if ipv4 != cfg['expected_exit_ipv4']:
            raise RuntimeError('IPv4 egress does not match the operator-verified exit address')
        if ipv6 != cfg.get('expected_exit_ipv6'):
            raise RuntimeError('IPv6 egress differs from expected address (omit it only if IPv6 is blocked)')
        if not dns_query(cfg['bootstrap_dns'][0], require_answer=True):
            raise RuntimeError('Public DNS through the tunnel returned no valid answer')
        print(json.dumps({'exit_ipv4_verified': True, 'exit_ipv6': 'verified' if ipv6 else 'blocked', 'dns_verified': True}))


def probe_service(down=False):
    return run('systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--unit=openbot-egress-probe',
               '--property=NetworkNamespacePath=/run/netns/' + NS,
               '--property=BindReadOnlyPaths=' + resolver_bind(BASE / 'resolv.conf') + ' ' + str(BASE / 'nsswitch.conf') + ':/etc/nsswitch.conf',
               str(LIBEXEC / 'openbot-egress.py'), 'probe-down' if down else 'probe-up')


def verify(cfg):
    for unit in UNITS:
        fragment = Path('/etc/systemd/system/' + unit + '.d/egress.conf')
        if fragment.exists():
            raise RuntimeError('Stop attached application units and remove owned drop-ins before disruptive preflight')
    ready(cfg)
    up = probe_service().stdout
    try:
        run('systemctl', 'stop', TAIL)
        down = probe_service(True).stdout
    finally:
        run('systemctl', 'start', TAIL)
    wait_ready(cfg)
    probe_service()
    write(RUN / 'verified.json', json.dumps({'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'config': cfg}), 0o600)
    print(up.strip())
    print(down.strip())
    print('Preflight passed. OpenBot services and host exit-node settings are unchanged.')


def wait_ready(cfg):
    for attempt in range(30):
        try:
            ready(cfg)
            return
        except RuntimeError:
            if attempt == 29:
                raise
            time.sleep(1)


def install(cfg):
    source = Path(__file__).resolve().parent
    for name in ('openbot-egress.py', 'openbottunnel.slice', 'openbot-egress-network.service',
                 TAIL, READY):
        target = LIBEXEC / name if name.endswith('.py') else Path('/etc/systemd/system') / name
        if target.exists() and target.read_text() != (source / name).read_text():
            if name != 'openbot-egress.py' and OWNER not in target.read_text():
                raise RuntimeError('Refusing to overwrite a unit with another owner')
        write(target, (source / name).read_text(), 0o755 if name.endswith('.py') else 0o644)
    write_resolver(BASE / 'bootstrap-resolv.conf', ''.join('nameserver ' + address + '\n' for address in cfg['bootstrap_dns']))
    write_resolver(BASE / 'resolv.conf', ''.join('nameserver ' + address + '\n' for address in application_dns(cfg)) + 'options timeout:2 attempts:2\n')
    # The unit file is static, so the daemon gets its resolver mount from a drop-in.
    write(Path('/etc/systemd/system/' + TAIL + '.d/resolver.conf'), f'''# {OWNER}
[Service]
BindReadOnlyPaths=
BindReadOnlyPaths={resolver_bind(BASE / 'bootstrap-resolv.conf')} {BASE}/nsswitch.conf:/etc/nsswitch.conf
''')
    original = Path('/etc/nsswitch.conf').read_text().splitlines()
    write(BASE / 'nsswitch.conf', '\n'.join('hosts: files dns' if line.lstrip().startswith('hosts:') else line for line in original) + '\n')
    run('systemctl', 'daemon-reload')
    print('Helper and units installed. No service started; no app drop-ins or routes changed.')


def attach(cfg):
    proof = json.loads(private_file(RUN / 'verified.json'))
    if proof != {'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'config': cfg}:
        raise RuntimeError('Run preflight verification in this boot with the current config first')
    ready(cfg)
    probe_service()
    installed = []
    for unit in UNITS:
        if not run('systemctl', 'show', unit, '-p', 'LoadState', '--value').stdout.strip() == 'loaded':
            continue
        if unit == 'openbot.service' or unit.startswith('openbot-agent-relay-'):
            user = run('systemctl', 'show', unit, '-p', 'User', '--value').stdout.strip()
            if user != cfg['service_user']:
                raise RuntimeError('OpenBot service account differs from operator config')
        contents = f'''# {OWNER}: survives replacement of /opt/OpenBot and base units.
[Unit]
Requires={READY}
After={READY}
BindsTo=openbot-egress-network.service {TAIL}
[Service]
NetworkNamespacePath=/run/netns/{NS}
BindReadOnlyPaths={resolver_bind(BASE / 'resolv.conf')} {BASE}/nsswitch.conf:/etc/nsswitch.conf
'''
        if unit == 'openbot.service':
            contents += 'ExecStartPre=\nExecStartPre=-!/opt/OpenBot/hosted/openbot-hosted-update trigger\n'
        destination = Path('/etc/systemd/system/' + unit + '.d/egress.conf')
        if destination.exists() and OWNER not in destination.read_text():
            raise RuntimeError('Refusing to overwrite another service drop-in')
        write(destination, contents)
        installed.append(unit)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', 'openbot-egress-network.service', TAIL)
    print(json.dumps({'dropins_written': installed, 'restart_required': True, 'host_exit_unchanged': True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('install', 'network', 'login', 'ready', 'verify', 'probe-up', 'probe-down', 'attach'))
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Run as root')
    cfg = config()
    if args.command == 'install':
        install(cfg)
    elif args.command == 'network':
        network(cfg)
    elif args.command == 'login':
        # Deliberately interactive: do not collect, copy, or persist an auth key.
        subprocess.run(['tailscale', '--socket=' + SOCKET, 'up', '--hostname=openbot-egress', '--accept-dns=false', '--exit-node=' + cfg['exit_node'], '--exit-node-allow-lan-access=false'], check=True)
    elif args.command == 'ready':
        wait_ready(cfg)
    elif args.command == 'verify':
        verify(cfg)
    elif args.command.startswith('probe-'):
        probe(cfg, args.command == 'probe-down')
    elif args.command == 'attach':
        attach(cfg)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, KeyError, ValueError, OSError, subprocess.CalledProcessError) as error:
        # Errors contain fixed operation descriptions, not subprocess output or config values.
        print('OpenBot egress operation failed: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""Host-only certificate mount/renewal for an already configured MEET coturn.

No issuance, key copying, permission changes, device replacement, application
updates, or firewall changes. Run check first; apply/renew require root.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import subprocess
import sys
import time

TARGET = '/var/meet-tls'
DEST = '/etc/coturn/certs'
STATE = Path('/var/lib/meet-turn-cert')


class SetupError(Exception):
    pass


def run(args):
    # Never echo captured command output on error: guest config may be sensitive.
    result = subprocess.run(args, capture_output=True, timeout=45)
    if result.returncode:
        raise SetupError('Command failed: ' + args[0] + ' (output withheld)')
    return result.stdout


def query(container, suffix=''):
    value = json.loads(run(['incus', 'query', '/1.0/instances/' + container + suffix]))
    return value.get('metadata', value)


def guest(cfg, *args):
    return run(['incus', 'exec', cfg['container'], '--', *args])


def validate_config(cfg):
    if not isinstance(cfg, dict):
        raise SetupError('Config must be a JSON object')
    expected = {'container', 'domain', 'source', 'device', 'coturn', 'interface', 'port'}
    if set(cfg) - expected or not {'container', 'domain', 'source'} <= set(cfg):
        raise SetupError('Config requires container, domain, source; unknown fields refused')
    cfg = {'device': 'meet-tls', 'coturn': 'external-proxy-coturn-1', 'interface': 'eth0', 'port': 5349, **cfg}
    for field in ('container', 'device', 'coturn', 'interface'):
        if not isinstance(cfg[field], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}', cfg[field]):
            raise SetupError('Invalid ' + field)
    if not isinstance(cfg['domain'], str) or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+', cfg['domain']):
        raise SetupError('Use an exact lowercase DNS hostname, not a wildcard')
    if type(cfg['port']) is not int or not 1 <= cfg['port'] <= 65535:
        raise SetupError('Invalid TLS port')
    if not isinstance(cfg['source'], str):
        raise SetupError('Source must be a path string')
    source = Path(cfg['source'])
    if not source.is_absolute() or source.name != cfg['domain'] or source.is_symlink():
        raise SetupError('Source must be the explicit single-hostname directory')
    cfg['source'] = str(source.resolve())
    return cfg


def validate_source(cfg):
    source = Path(cfg['source'])
    if not source.is_dir() or source.stat().st_mode & 0o022:
        raise SetupError('Certificate directory missing or writable by group/others')
    domain = cfg['domain']
    allowed = {domain + suffix for suffix in ('.crt', '.key', '.json')}
    for entry in source.iterdir():
        if entry.name not in allowed or entry.is_symlink() or not entry.is_file():
            raise SetupError('Refusing shared certificate directories, subdirectories or symlinks')
    cert, key = source / (domain + '.crt'), source / (domain + '.key')
    for file in (cert, key):
        if not file.is_file() or file.is_symlink():
            raise SetupError('Expected regular hostname.crt and hostname.key files')
    if key.stat().st_mode & 0o077:
        raise SetupError('Private key must have no group/other permissions; no chmod is performed')
    run(['openssl', 'x509', '-in', str(cert), '-noout', '-checkhost', domain])
    run(['openssl', 'x509', '-in', str(cert), '-noout', '-checkend', '86400'])
    sans = run(['openssl', 'x509', '-in', str(cert), '-noout', '-ext', 'subjectAltName']).decode()
    names = re.findall(r'DNS:([^,\s]+)', sans)
    if names != [domain] or re.search(r'IP Address:|URI:|email:', sans):
        raise SetupError('Certificate must cover only the selected DNS hostname')
    # Public certificate only. Python never opens or copies the private key.
    der = run(['openssl', 'x509', '-in', str(cert), '-outform', 'DER'])
    return hashlib.sha256(der).hexdigest()


def check_devices(cfg, instance):
    if instance.get('type') != 'container' or instance.get('status') != 'Running':
        raise SetupError('Target must be a running Incus container')
    devices = instance.get('expanded_devices', {})
    wanted = {'type': 'disk', 'source': cfg['source'], 'path': TARGET, 'readonly': 'true', 'shift': 'true'}
    for name, device in devices.items():
        mount = device.get('path', '').rstrip('/')
        if name == cfg['device']:
            if any(device.get(k) != v for k, v in wanted.items()):
                raise SetupError('Existing device differs; refusing to replace or modify it')
        elif device.get('type') == 'disk' and mount and (mount == TARGET or mount.startswith(TARGET + '/') or TARGET.startswith(mount + '/')):
            raise SetupError('Existing mount overlaps target; refusing to hide it')
    return cfg['device'] in devices


def check_coturn(cfg):
    label = guest(cfg, 'docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}}', cfg['coturn']).decode().strip()
    if label != 'coturn':
        raise SetupError('Selected Docker container is not the coturn compose service')
    mounts = json.loads(guest(cfg, 'docker', 'inspect', '--format', '{{json .Mounts}}', cfg['coturn']))
    matches = [m for m in mounts if m.get('Destination') == DEST]
    if len(matches) != 1 or matches[0].get('Type') != 'bind' or matches[0].get('Source') != TARGET or matches[0].get('RW') is not False:
        raise SetupError('Configure coturn certificate bind mount as /var/meet-tls:/etc/coturn/certs:ro first')
    for line in ('cert=' + DEST + '/' + cfg['domain'] + '.crt', 'pkey=' + DEST + '/' + cfg['domain'] + '.key', 'tls-listening-port=' + str(cfg['port'])):
        guest(cfg, 'docker', 'exec', cfg['coturn'], 'grep', '-Fqx', line, '/etc/coturn/turnserver.conf')


def verify_tls(cfg, fingerprint):
    addresses = query(cfg['container'], '/state').get('network', {}).get(cfg['interface'], {}).get('addresses', [])
    ips = [a['address'] for a in addresses if a.get('family') == 'inet' and a.get('scope') == 'global']
    if len(ips) != 1:
        raise SetupError('Expected one global IPv4 on selected guest interface')
    context = ssl.create_default_context()
    for attempt in range(10):
        try:
            with socket.create_connection((ips[0], cfg['port']), timeout=3) as raw:
                with context.wrap_socket(raw, server_hostname=cfg['domain']) as connection:
                    actual = hashlib.sha256(connection.getpeercert(binary_form=True)).hexdigest()
                    if actual != fingerprint:
                        raise SetupError('TLS endpoint is not serving the selected certificate')
                    return
        except (OSError, SetupError):
            if attempt == 9:
                raise SetupError('TLS verification failed: check coturn logs, certificate/key match and host-to-guest reachability') from None
            time.sleep(1)


def execute(cfg, action, state_dir=STATE):
    fingerprint = validate_source(cfg)
    present = check_devices(cfg, query(cfg['container']))
    check_coturn(cfg)
    if not present:
        # Refuse manual mounts, symlinks and existing files even when Incus
        # has no recorded disk device at this path. Never hide guest data.
        guest(cfg, 'sh', '-c', 'if [ -e "$1" ] || [ -L "$1" ]; then [ -d "$1" ] && [ ! -L "$1" ] && ! mountpoint -q -- "$1" && [ -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)" ]; fi', 'sh', TARGET)
    if action == 'check':
        print('Preflight passed; mount ' + ('already matches' if present else 'would be added') + '; no changes made')
        return
    # Root-owned state holds only a public certificate fingerprint. Serializes
    # timer/manual runs and commits state only after successful TLS verification.
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state_dir.is_symlink() or state_dir.stat().st_uid != os.geteuid() or state_dir.stat().st_mode & 0o077:
        raise SetupError('State directory must be private and owned by the invoking root user')
    state = state_dir / (cfg['container'] + '--' + cfg['domain'] + '.sha256')
    lock_path = state.with_suffix('.lock')
    fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if state.is_symlink():
            raise SetupError('Refusing symlink state file')
        previous = state.read_text().strip() if state.exists() else None
        if action == 'renew' and (not present or previous is None):
            raise SetupError('Run apply successfully before enabling renewal checks')
        if not present:
            run(['incus', 'config', 'device', 'add', cfg['container'], cfg['device'], 'disk', 'source=' + cfg['source'], 'path=' + TARGET, 'readonly=true', 'shift=true'])
            if not check_devices(cfg, query(cfg['container'])):
                raise SetupError('Device verification failed')
        changed = previous != fingerprint
        if changed or not present:
            # Restart rebuilds Docker bind mounts after the host mount, and
            # reloads TLS after renewal. Existing TURN allocations may interrupt.
            guest(cfg, 'docker', 'restart', cfg['coturn'])
        for suffix in ('.crt', '.key'):
            guest(cfg, 'docker', 'exec', cfg['coturn'], 'test', '-r', DEST + '/' + cfg['domain'] + suffix)
        verify_tls(cfg, fingerprint)
        if validate_source(cfg) != fingerprint:
            raise SetupError('Certificate changed during verification; retry after renewal completes')
        temporary = state.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(fingerprint + '\n')
        os.replace(temporary, state)
        print('TLS certificate verified; coturn ' + ('restarted' if changed or not present else 'unchanged'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'apply', 'renew'])
    parser.add_argument('--config', required=True, help='Explicit JSON config; no credentials')
    args = parser.parse_args()
    if args.action != 'check' and os.geteuid() != 0:
        raise SetupError('apply/renew must run as root on the Incus host')
    config_path = Path(args.config)
    info = config_path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise SetupError('Config must be a regular file owned by the caller and not group/other writable')
    cfg = validate_config(json.loads(config_path.read_text()))
    execute(cfg, args.action)


if __name__ == '__main__':
    try:
        main()
    except (SetupError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print('TURN certificate setup stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)

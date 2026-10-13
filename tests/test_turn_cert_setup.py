#!/usr/bin/env python3
"""No Incus, certificate issuance, private keys or live services used here."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('turn_cert', Path(__file__).resolve().parents[1] / 'deploy/external-proxy/turn-cert.py')
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class CertificateSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'meet.example.com'
        self.source.mkdir(mode=0o700)
        for suffix in ('.crt', '.key'):
            path = self.source / ('meet.example.com' + suffix)
            path.write_text('non-credential test fixture')
            path.chmod(0o600)
        self.cfg = mod.validate_config({'container': 'pp-MEET', 'domain': 'meet.example.com', 'source': str(self.source), 'device': 'meet-tls'})
        self.device = {'type': 'disk', 'source': str(self.source), 'path': mod.TARGET, 'readonly': 'true', 'shift': 'true'}
        self.instance = {'type': 'container', 'status': 'Running', 'expanded_devices': {'root': {'type': 'disk', 'path': '/'}, 'meet-tls': self.device}}
        self.state = Path(self.temp.name) / 'state'

    def cert_command(self, args):
        self.assertEqual(args[0], 'openssl')
        self.assertNotIn(str(self.source / 'meet.example.com.key'), args)
        if '-ext' in args:
            return b'X509v3 Subject Alternative Name:\n DNS:meet.example.com\n'
        if '-outform' in args:
            return b'public certificate DER fixture'
        return b''

    def test_single_hostname_source_without_reading_private_key(self):
        with patch.object(mod, 'run', side_effect=self.cert_command):
            self.assertEqual(len(mod.validate_source(self.cfg)), 64)

    def test_refuse_shared_directory(self):
        (self.source / 'other.example.com.key').write_text('fixture')
        with self.assertRaises(mod.SetupError):
            mod.validate_source(self.cfg)

    def test_refuse_symlink_key(self):
        key = self.source / 'meet.example.com.key'
        key.unlink()
        key.symlink_to('/not-read')
        with self.assertRaises(mod.SetupError):
            mod.validate_source(self.cfg)

    def test_refuse_weak_key_permissions(self):
        (self.source / 'meet.example.com.key').chmod(0o644)
        with self.assertRaises(mod.SetupError):
            mod.validate_source(self.cfg)

    def test_refuse_multihost_certificate(self):
        with patch.object(mod, 'run', return_value=b'DNS:meet.example.com, DNS:other.example.com'):
            with self.assertRaises(mod.SetupError):
                mod.validate_source(self.cfg)

    def test_refuse_expired_certificate(self):
        with patch.object(mod, 'run', side_effect=mod.SetupError('expired')):
            with self.assertRaises(mod.SetupError):
                mod.validate_source(self.cfg)

    def test_preserve_conflicting_and_inherited_mounts(self):
        for key, value in [('readonly', 'false'), ('shift', 'false'), ('source', '/other')]:
            with self.subTest(key=key):
                self.device[key], old = value, self.device[key]
                with self.assertRaises(mod.SetupError):
                    mod.check_devices(self.cfg, self.instance)
                self.device[key] = old
        self.instance['expanded_devices']['inherited'] = {'type': 'disk', 'path': mod.TARGET + '/child'}
        with self.assertRaises(mod.SetupError):
            mod.check_devices(self.cfg, self.instance)

    def exercise(self, action, present=True, previous=None, tls_failure=False):
        if not present:
            self.instance['expanded_devices'].pop('meet-tls', None)
        if previous:
            self.state.mkdir(mode=0o700, exist_ok=True)
            (self.state / 'pp-MEET--meet.example.com.sha256').write_text(previous + '\n')
        with patch.object(mod, 'validate_source', return_value='new'), patch.object(mod, 'query', return_value=self.instance), patch.object(mod, 'check_coturn'), patch.object(mod, 'guest') as guest, patch.object(mod, 'run') as run, patch.object(mod, 'verify_tls', side_effect=mod.SetupError('TLS failed') if tls_failure else None) as tls:
            def add(args):
                self.assertEqual(args[:5], ['incus', 'config', 'device', 'add', 'pp-MEET'])
                self.assertIn('readonly=true', args)
                self.assertIn('shift=true', args)
                self.instance['expanded_devices']['meet-tls'] = self.device
            run.side_effect = add
            if tls_failure:
                with self.assertRaises(mod.SetupError):
                    mod.execute(self.cfg, action, self.state)
            else:
                mod.execute(self.cfg, action, self.state)
            return guest.call_args_list, run.call_count, tls.call_count

    def test_check_is_read_only(self):
        calls, changes, tls = self.exercise('check', present=False)
        self.assertEqual((changes, tls), (0, 0))
        self.assertFalse(self.state.exists())
        self.assertFalse(any('restart' in c.args for c in calls))

    def test_apply_adds_only_missing_readonly_device_and_restarts_only_coturn(self):
        calls, changes, tls = self.exercise('apply', present=False)
        self.assertEqual((changes, tls), (1, 1))
        restarts = [c for c in calls if 'restart' in c.args]
        self.assertEqual(len(restarts), 1)
        self.assertEqual(restarts[0].args[1:], ('docker', 'restart', 'external-proxy-coturn-1'))

    def test_unchanged_renewal_verifies_without_restart(self):
        calls, changes, tls = self.exercise('renew', previous='new')
        self.assertEqual((changes, tls), (0, 1))
        self.assertFalse(any('restart' in c.args for c in calls))

    def test_changed_renewal_restarts_and_records_after_verification(self):
        calls, changes, tls = self.exercise('renew', previous='old')
        self.assertEqual((changes, tls), (0, 1))
        self.assertEqual(sum('restart' in c.args for c in calls), 1)
        self.assertEqual((self.state / 'pp-MEET--meet.example.com.sha256').read_text(), 'new\n')

    def test_failed_verification_keeps_previous_fingerprint(self):
        self.exercise('renew', previous='old', tls_failure=True)
        self.assertEqual((self.state / 'pp-MEET--meet.example.com.sha256').read_text(), 'old\n')

    def test_renew_cannot_add_mount(self):
        with patch.object(mod, 'validate_source', return_value='new'), patch.object(mod, 'query', return_value={'type': 'container', 'status': 'Running', 'expanded_devices': {}}), patch.object(mod, 'check_coturn'), patch.object(mod, 'guest'), patch.object(mod, 'run') as run:
            with self.assertRaises(mod.SetupError):
                mod.execute(self.cfg, 'renew', self.state)
            run.assert_not_called()

    def test_nonempty_or_manually_mounted_destination_prevents_changes(self):
        self.instance['expanded_devices'].pop('meet-tls')
        with patch.object(mod, 'validate_source', return_value='new'), patch.object(mod, 'query', return_value=self.instance), patch.object(mod, 'check_coturn'), patch.object(mod, 'guest', side_effect=mod.SetupError('destination occupied')), patch.object(mod, 'run') as run:
            with self.assertRaises(mod.SetupError):
                mod.execute(self.cfg, 'apply', self.state)
            run.assert_not_called()
            self.assertFalse(self.state.exists())

    def test_coturn_requires_readonly_expected_mount(self):
        mount = {'Type': 'bind', 'Source': mod.TARGET, 'Destination': mod.DEST, 'RW': False}
        with patch.object(mod, 'guest', side_effect=[b'coturn', json.dumps([mount]).encode(), b'', b'', b'']) as guest:
            mod.check_coturn(self.cfg)
            self.assertEqual(guest.call_count, 5)
        mount['RW'] = True
        with patch.object(mod, 'guest', side_effect=[b'coturn', json.dumps([mount]).encode()]):
            with self.assertRaises(mod.SetupError):
                mod.check_coturn(self.cfg)

    def test_source_domain_and_config_injection_rejected(self):
        for update in ({'domain': '*.example.com'}, {'container': 'guest;echo bad'}, {'source': '/var/lib/caddy'}, {'unknown': True}, {'container': None}, {'domain': []}, {'source': 5}):
            with self.subTest(update=update), self.assertRaises(mod.SetupError):
                mod.validate_config({**self.cfg, **update})


if __name__ == '__main__':
    unittest.main()

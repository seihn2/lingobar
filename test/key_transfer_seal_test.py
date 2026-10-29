"""Synthetic-key-only encryption sender tests; no SSH, VM or supplier access."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import tempfile
import termios
import time
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts/secure-key"
SPEC = importlib.util.spec_from_file_location("lingobar_seal_tests", SCRIPTS / "seal.py")
sealer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sealer)
DUMMY = b"synthetic-not-a-real-key-123456789"


class FakeCrypto:
    @staticmethod
    def challenge_hash(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    @staticmethod
    def validate_challenge(value, now):
        if value["expiresAt"] <= now:
            raise ValueError("expired")

    @staticmethod
    def seal(_challenge, _key, _now):
        return {"version": 1, "sessionId": "synthetic", "ciphertext": "only-ciphertext"}


class SealTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.challenge = {"expiresAt": 1300, "synthetic": True}
        self.path = Path(self.directory.name) / "challenge.json"
        self.path.write_text(json.dumps(self.challenge)); self.path.chmod(0o600)
        self.profile = {"version": 1, "enabled": True, "challengeFile": str(self.path),
                        "challengeSha256": FakeCrypto.challenge_hash(self.challenge)}
        # Irreversible core limits have separate fresh-child tests. The actual
        # PTY child test below uses the real process protections.
        self.guard = patch.object(sealer.sender, "disable_core_dumps", return_value=None)
        self.guard.start(); self.addCleanup(self.guard.stop)

    def test_disabled_profile_never_opens_challenge_imports_crypto_or_prompts(self):
        key = Mock()
        with patch.object(sealer, "_sibling", side_effect=AssertionError("no import")), \
             patch.object(sealer.sender, "read_public_file", side_effect=AssertionError("no read")), \
             patch("socket.socket", side_effect=AssertionError("no network")), \
             patch("subprocess.Popen", side_effect=AssertionError("no process")):
            with self.assertRaises(sealer.sender.TransferError):
                sealer.run_seal({"version": 1, "enabled": False, "challengeFile": None, "challengeSha256": None}, key_reader=key)
        key.assert_not_called()

    def test_profile_exact_fields_path_and_digest_rules(self):
        self.assertEqual(sealer.validate_profile(self.profile), self.profile)
        for mutant in [{"version": True}, {"enabled": 1}, {"version": 2}, {"unknown": True},
                       {"challengeFile": "relative"}, {"challengeFile": str(self.path) + "\n"},
                       {"challengeFile": str(self.path.parent / ".." / "challenge.json")},
                       {"challengeSha256": "A" * 64}, {"challengeSha256": "b" * 63}, {"challengeSha256": None}]:
            with self.subTest(mutant=mutant), self.assertRaises(sealer.sender.TransferError):
                sealer.validate_profile({**self.profile, **mutant})
        symlink = self.path.parent / "link"; symlink.symlink_to(self.path)
        with self.assertRaises(sealer.sender.TransferError):
            sealer.validate_profile({**self.profile, "challengeFile": str(symlink)})

    def test_hash_mismatch_is_rejected_before_key_entry(self):
        key = Mock()
        with self.assertRaises(sealer.sender.TransferError):
            sealer.run_seal({**self.profile, "challengeSha256": "0" * 64}, key_reader=key, clock=lambda: 1000, crypto=FakeCrypto)
        key.assert_not_called()

    def test_expiry_is_checked_before_and_after_typing(self):
        key = Mock()
        with self.assertRaises(ValueError):
            sealer.run_seal(self.profile, key_reader=key, clock=lambda: 1300, crypto=FakeCrypto)
        key.assert_not_called()
        buffer = bytearray(DUMMY); clock = iter([1000, 1300])
        with self.assertRaises(ValueError):
            sealer.run_seal(self.profile, key_reader=lambda: buffer, clock=lambda: next(clock), crypto=FakeCrypto)
        self.assertEqual(buffer, b"\0" * len(DUMMY))

    def test_single_key_entry_returns_ciphertext_without_network_or_subprocess(self):
        buffer = bytearray(DUMMY); key = Mock(return_value=buffer)
        with patch("socket.socket", side_effect=AssertionError("no network")), \
             patch("subprocess.Popen", side_effect=AssertionError("no process")):
            envelope = sealer.run_seal(self.profile, key_reader=key, clock=lambda: 1000, crypto=FakeCrypto)
        self.assertEqual(envelope["ciphertext"], "only-ciphertext")
        key.assert_called_once_with()
        self.assertNotIn(DUMMY.decode(), json.dumps(envelope))
        self.assertEqual(buffer, b"\0" * len(DUMMY))

    def test_encryption_failure_clears_buffer_without_output_or_retry(self):
        crypto = Mock(wraps=FakeCrypto); crypto.seal.side_effect = RuntimeError(DUMMY.decode())
        buffer = bytearray(DUMMY); key = Mock(return_value=buffer)
        with self.assertRaises(RuntimeError), patch("sys.stdout", new_callable=io.StringIO) as output:
            sealer.run_seal(self.profile, key_reader=key, clock=lambda: 1000, crypto=crypto)
        self.assertEqual(output.getvalue(), ""); key.assert_called_once_with()
        self.assertEqual(crypto.seal.call_count, 1)
        self.assertEqual(buffer, b"\0" * len(DUMMY))

    def test_overlong_key_is_rejected_without_seal_and_cleared(self):
        buffer = bytearray(b"x" * 129); crypto = Mock(wraps=FakeCrypto)
        with self.assertRaises(sealer.sender.TransferError):
            sealer.run_seal(self.profile, key_reader=lambda: buffer, clock=lambda: 1000, crypto=crypto)
        crypto.seal.assert_not_called(); self.assertEqual(buffer, b"\0" * 129)

    def test_main_never_prints_raw_errors_and_rejects_arguments(self):
        for error, status in [(RuntimeError(DUMMY.decode()), "blocked"), (KeyboardInterrupt(), "cancelled")]:
            with self.subTest(status=status), patch.object(sealer, "load_profile", return_value=self.profile), \
                 patch.object(sealer, "run_seal", side_effect=error), patch.object(sys, "argv", ["seal.py"]), \
                 patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(sealer.main(), 2)
            self.assertEqual(json.loads(output.getvalue())["status"], status)
            self.assertNotIn(DUMMY.decode(), output.getvalue())
        with patch.object(sys, "argv", ["seal.py", "not-an-input-option"]), \
             patch.object(sealer, "load_profile") as config, patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(sealer.main(), 2)
        config.assert_not_called()

    def test_actual_dummy_crypto_round_trip_contains_no_plaintext(self):
        crypto = sealer._sibling("envelope_crypto")
        private, challenge = crypto.create_challenge(sealer.sender.TARGET_ID, 1000)
        self.path.write_text(json.dumps(challenge))
        profile = {**self.profile, "challengeSha256": crypto.challenge_hash(challenge)}
        buffer = bytearray(DUMMY)
        with patch("socket.socket", side_effect=AssertionError("no network")), \
             patch("subprocess.Popen", side_effect=AssertionError("no process")):
            envelope = sealer.run_seal(profile, key_reader=lambda: buffer, clock=lambda: 1001, crypto=crypto)
            restored = crypto.unseal(private, challenge, envelope, 1001)
        self.assertEqual(restored, DUMMY)
        self.assertNotIn(DUMMY.decode(), json.dumps(envelope))
        self.assertEqual(buffer, b"\0" * len(DUMMY))
        restored[:] = b"\0" * len(restored)

    def test_real_dummy_pty_repeated_sigquit_restores_echo_without_ciphertext(self):
        master, slave = pty.openpty()
        self.addCleanup(os.close, master); self.addCleanup(os.close, slave)
        before = termios.tcgetattr(slave)
        child = r'''
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("seal",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
profile=json.loads(sys.argv[2]); tty=sys.argv[3]
real=m.sender.read_hidden_key
m.sender.read_hidden_key=lambda:real(tty)
class Crypto:
 def challenge_hash(self,v): return profile['challengeSha256']
 def validate_challenge(self,v,now): pass
 def seal(self,*a): raise RuntimeError('should not encrypt cancelled input')
m._sibling=lambda name:Crypto()
m.load_profile=lambda:profile
sys.argv=['seal.py']
sys.exit(m.main())
'''
        process = subprocess.Popen([sys.executable, "-I", "-B", "-c", child, str(SCRIPTS / "seal.py"),
                                    json.dumps(self.profile), os.ttyname(slave)], stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        observed = b""; deadline = time.monotonic() + 5
        while b"hidden; type directly" not in observed and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready: observed += os.read(master, 4096)
        self.assertIn(b"hidden; type directly", observed)
        self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
        os.write(master, b"synthetic-partial")
        os.kill(process.pid, signal.SIGQUIT); os.kill(process.pid, signal.SIGQUIT)
        out, err = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 2, err.decode())
        self.assertEqual(json.loads(out)["status"], "cancelled")
        self.assertEqual(termios.tcgetattr(slave), before)
        self.assertNotIn(b"synthetic-partial", out + err + observed)


if __name__ == "__main__":
    unittest.main()

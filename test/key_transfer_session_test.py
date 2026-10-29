"""Dummy-only Unix socket receiver tests. No SSH, VM, keys or supplier access."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/secure-key/session.py"
SPEC = importlib.util.spec_from_file_location("session_under_test", SCRIPT)
session = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(session)
crypto = session._load("envelope_crypto")
DUMMY = b"synthetic-only-never-real-key"
CHILD = """import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('dummy_session',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
if len(sys.argv)>4 and sys.argv[4] in ('expiry','generation_expiry'):
 values=iter([0,0,1000] if sys.argv[4]=='expiry' else [0,1000])
 m.time.monotonic=lambda: next(values,1000)
if len(sys.argv)>4 and sys.argv[4]=='install_failure':
 import errno
 def fail(*a): raise OSError(errno.ENOSPC,'dummy')
 m.receiver._link_anonymous=fail
if len(sys.argv)>4 and sys.argv[4]=='publication_uncertain':
 original=m.receiver._link_anonymous
 def interrupted(*a):
  original(*a)
  raise m.receiver.ReceiverError('dummy')
 m.receiver._link_anonymous=interrupted
r=m.serve(sys.argv[2],float(sys.argv[3]))
print(json.dumps(r),flush=True)
"""


@unittest.skipUnless(sys.platform == "linux" and hasattr(os, "O_TMPFILE"),
                     "Protected Unix receiver requires Linux")
class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lingobar-dummy-envelope-")
        self.root = Path(self.temporary.name)
        self.private = self.root / "private"
        self.private.mkdir(mode=0o700)
        self.state = self.root / "session"
        self.state.mkdir(mode=0o700)
        self.destination = self.private / "credential.json"
        self.config_path = self.root / "receiver.json"
        self.config = {"version": 2, "enabled": True,
                       "targetId": session.receiver.TARGET_ID,
                       "credentialsFile": str(self.destination),
                       "sessionDirectory": str(self.state)}
        self.write_config()
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=3)
        self.temporary.cleanup()

    def write_config(self):
        self.config_path.write_text(json.dumps(self.config))
        self.config_path.chmod(0o600)

    def start(self, lifetime=20, wait=True, fault="none"):
        child = subprocess.Popen([sys.executable, "-I", "-B", "-c", CHILD,
                                  str(SCRIPT), str(self.config_path), str(lifetime), fault],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(child)
        if wait:
            deadline = time.monotonic() + 15
            while not (self.state / "challenge.json").exists():
                if child.poll() is not None:
                    out, err = child.communicate()
                    self.fail("Session exited before challenge: " + repr((out, err)))
                if time.monotonic() > deadline:
                    self.fail("Session did not publish its public challenge")
                time.sleep(0.02)
        return child

    def challenge(self):
        return json.loads((self.state / "challenge.json").read_text())

    def envelope(self, challenge=None):
        return crypto.seal(challenge or self.challenge(), DUMMY, int(time.time()))

    def submit(self, value):
        # Local test clients intentionally bypass production signal guards only
        # to avoid irreversibly reducing the unittest parent's core limit.
        return session._client(self.config_path, session._encode(value))

    def finish(self, child):
        out, err = child.communicate(timeout=10)
        self.assertEqual(err, b"")
        self.assertNotIn(DUMMY, out + err)
        return json.loads(out)

    def assert_clean(self, result=True):
        self.assertEqual(set(path.name for path in self.state.iterdir()),
                         {"result.json"} if result else set())

    def test_real_protected_child_installs_dummy_and_leaves_only_public_result(self):
        child = self.start()
        envelope = self.envelope()
        self.assertNotIn(DUMMY.decode(), json.dumps(envelope))
        result = self.submit(envelope)
        self.assertEqual(result["status"], "installed")
        self.assertEqual(self.finish(child), result)
        self.assertEqual(json.loads(self.destination.read_text()), {"apiKey": DUMMY.decode()})
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o600)
        self.assert_clean()
        self.assertNotIn(DUMMY.decode(), (self.state / "result.json").read_text())

    def test_tampered_ciphertext_consumes_session_and_replay_cannot_revive(self):
        child = self.start()
        envelope = self.envelope()
        envelope["ciphertext"] = "A" + envelope["ciphertext"][1:]
        self.assertEqual(self.submit(envelope)["status"], "not_installed")
        self.assertEqual(self.finish(child)["status"], "not_installed")
        self.assertFalse(self.destination.exists())
        self.assertEqual(self.submit(envelope)["status"], "blocked")
        self.assert_clean()

    def test_wrong_context_and_duplicate_json_are_not_installed(self):
        child = self.start()
        envelope = self.envelope()
        envelope["sessionId"] = "0" * 32
        self.assertEqual(self.submit(envelope)["status"], "not_installed")
        self.finish(child)
        self.assertFalse(self.destination.exists())
        self.assert_clean()

    def test_cancel_consumes_session_without_credential(self):
        child = self.start()
        self.assertEqual(self.submit({"version": 1, "action": "cancel"})["status"], "cancelled")
        self.assertEqual(self.finish(child)["status"], "cancelled")
        self.assertFalse(self.destination.exists())
        self.assert_clean()

    def test_signal_cancellation_cleans_owned_files_without_install(self):
        child = self.start()
        os.kill(child.pid, signal.SIGQUIT)
        result = self.finish(child)
        self.assertEqual(result["status"], "not_installed")
        self.assertFalse(self.destination.exists())
        self.assert_clean()

    def test_monotonic_expiry_and_existing_result_block_new_session(self):
        child = self.start(lifetime=1.5, wait=False, fault="expiry")
        self.assertEqual(self.finish(child)["status"], "expired")
        self.assert_clean()
        second = self.start(wait=False)
        self.assertEqual(self.finish(second)["status"], "blocked")
        self.assertFalse(self.destination.exists())

    def test_key_generation_does_not_extend_monotonic_deadline(self):
        child = self.start(lifetime=1.5, wait=False, fault="generation_expiry")
        self.assertEqual(self.finish(child)["status"], "blocked")
        self.assert_clean(result=False)
        self.assertFalse(self.destination.exists())

    def test_existing_lock_and_bad_directory_permissions_fail_before_key_generation(self):
        for bad in ("lock", "permission"):
            with self.subTest(bad=bad):
                if bad == "lock":
                    (self.state / ".lock").write_text("stale-public-marker")
                else:
                    self.state.chmod(0o755)
                with mock.patch.object(session, "_load") as loader:
                    self.assertEqual(session._serve(self.config_path, 1)["status"], "blocked")
                    loader.assert_not_called()
                if bad == "lock":
                    self.assertEqual((self.state / ".lock").read_text(), "stale-public-marker")
                    (self.state / ".lock").unlink()
                else:
                    self.state.chmod(0o700)

    def test_second_server_refuses_without_removing_first_session(self):
        child = self.start()
        original = (self.state / "challenge.json").read_bytes()
        second = self.start(wait=False)
        self.assertEqual(self.finish(second)["status"], "blocked")
        self.assertEqual((self.state / "challenge.json").read_bytes(), original)
        self.assertEqual(self.submit({"version": 1, "action": "cancel"})["status"], "cancelled")
        self.finish(child)

    def test_changed_config_refuses_install_instead_of_redirecting(self):
        child = self.start()
        envelope = self.envelope()
        self.config["credentialsFile"] = str(self.private / "redirect.json")
        self.write_config()
        self.assertEqual(self.submit(envelope)["status"], "not_installed")
        self.finish(child)
        self.assertEqual(list(self.private.iterdir()), [])

    def test_credential_target_cannot_collide_with_public_control_files(self):
        for name in (*session.FILES, ".public-collision"):
            with self.subTest(name=name):
                self.config["credentialsFile"] = str(self.state / name)
                self.write_config()
                with self.assertRaises(session.receiver.ReceiverError):
                    session._configuration(self.config_path)
                self.assertEqual(list(self.state.iterdir()), [])

    def test_existing_target_does_not_publish_a_key(self):
        self.destination.write_text("existing-not-a-secret")
        child = self.start(wait=False)
        self.assertEqual(self.finish(child)["status"], "blocked")
        self.assertEqual(self.destination.read_text(), "existing-not-a-secret")
        self.assert_clean(result=False)

    def test_invalid_local_peer_never_reaches_message_or_install(self):
        fake = mock.Mock()
        fake.getsockopt.return_value = __import__("struct").pack("3i", 12, os.geteuid() + 1, 5)
        self.assertFalse(session._same_uid(fake))
        fake.recv.assert_not_called()

    def test_regular_stdin_unknown_fields_and_oversize_ciphertext_are_rejected(self):
        with tempfile.TemporaryFile() as file:
            with self.assertRaises(session.receiver.ReceiverError):
                session._read_ciphertext(file.fileno())
        for data in (b"x" * (session.MAX_CIPHERTEXT + 1),
                     b'{"version":1,"sessionId":"a","ciphertext":"x","apiKey":"dummy"}',
                     b'{"version":1,"version":1,"sessionId":"a","ciphertext":"x"}'):
            read_fd, write_fd = os.pipe()
            try:
                os.write(write_fd, data)
                os.close(write_fd)
                with self.assertRaises((session.receiver.ReceiverError, ValueError)):
                    session._read_ciphertext(read_fd)
            finally:
                os.close(read_fd)

    def test_guard_failure_prevents_config_and_socket_access(self):
        with mock.patch.object(session.receiver, "_disable_core_dumps", side_effect=RuntimeError("dummy")), \
                mock.patch.object(session, "_configuration") as config, \
                mock.patch.object(socket, "socket") as create:
            self.assertEqual(session.serve(self.config_path)["status"], "blocked")
            self.assertEqual(session.deliver(self.config_path)["status"], "blocked")
            self.assertEqual(session.cancel(self.config_path)["status"], "blocked")
            config.assert_not_called()
            create.assert_not_called()

    def test_cancel_during_client_cleanup_cannot_claim_known_failure(self):
        with mock.patch.object(session.receiver, "_disable_core_dumps"), \
                mock.patch.object(session, "_read_ciphertext", return_value=b"{}"), \
                mock.patch.object(session, "_client", side_effect=KeyboardInterrupt):
            self.assertEqual(session.deliver(self.config_path)["status"], "outcome_unknown")
            self.assertEqual(session.cancel(self.config_path)["status"], "outcome_unknown")

    def test_atomic_save_failure_consumes_session_without_plaintext_staging(self):
        child = self.start(fault="install_failure")
        self.assertEqual(self.submit(self.envelope())["status"], "not_installed")
        self.assertEqual(self.finish(child)["status"], "not_installed")
        self.assertEqual(list(self.private.iterdir()), [])
        self.assert_clean()

    def test_publication_uncertainty_preserves_file_and_never_claims_rollback(self):
        child = self.start(fault="publication_uncertain")
        self.assertEqual(self.submit(self.envelope())["status"], "outcome_unknown")
        self.assertEqual(self.finish(child)["status"], "outcome_unknown")
        self.assertEqual(json.loads(self.destination.read_text())["apiKey"], DUMMY.decode())
        self.assertEqual(json.loads((self.state / "result.json").read_text())["status"],
                         "outcome_unknown")
        self.assert_clean()

    def test_old_ciphertext_cannot_be_used_in_a_new_explicit_session(self):
        first = self.start()
        old = self.envelope()
        self.assertEqual(self.submit({"version": 1, "action": "cancel"})["status"], "cancelled")
        self.finish(first)
        # This is explicit operator cleanup after an inspected cancelled result,
        # not an automatic recovery or a permission to resend a real secret.
        (self.state / "result.json").unlink()
        second = self.start()
        self.assertEqual(self.submit(old)["status"], "not_installed")
        self.finish(second)
        self.assertFalse(self.destination.exists())

    def test_uncatchable_kill_leaves_only_public_stale_state_and_refuses_restart(self):
        first = self.start()
        first.kill()
        first.communicate(timeout=3)
        self.assertEqual(set(path.name for path in self.state.iterdir()),
                         {".lock", "transfer.sock", "challenge.json"})
        self.assertFalse(self.destination.exists())
        second = self.start(wait=False)
        self.assertEqual(self.finish(second)["status"], "blocked")
        self.assertEqual(set(path.name for path in self.state.iterdir()),
                         {".lock", "transfer.sock", "challenge.json"})

    def test_default_entrypoints_block_without_network_or_ciphertext_input(self):
        for mode in ("--serve", "--deliver", "--cancel", "--serve /tmp/other"):
            output = subprocess.run([sys.executable, "-I", "-B", str(SCRIPT), mode],
                                    input=DUMMY, capture_output=True, timeout=5)
            self.assertEqual(output.returncode, 2)
            self.assertEqual(json.loads(output.stdout)["status"], "blocked")
            self.assertNotIn(DUMMY, output.stdout + output.stderr)


if __name__ == "__main__":
    unittest.main()

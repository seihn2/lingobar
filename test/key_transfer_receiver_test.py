"""Synthetic local files/pipe/socketpair only. No SSH, provider or real secrets."""
import ctypes
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import types
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/secure-key/receive.py"
SPEC = importlib.util.spec_from_file_location("key_receiver_under_test", SCRIPT)
receiver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(receiver)
SECRET = "synthetic-dummy-only-never-a-real-key"


class ProtocolTests(unittest.TestCase):
    def test_default_configuration_and_extra_arguments_fail_closed(self):
        for arguments in (["--probe"], ["--receive"], ["--receive", "/tmp/target"]):
            output = subprocess.run([sys.executable, str(SCRIPT), *arguments],
                                    input=SECRET.encode(), capture_output=True,
                                    check=False, timeout=5)
            self.assertEqual(output.returncode, 2)
            self.assertEqual(json.loads(output.stdout)["status"], "blocked")
            self.assertNotIn(SECRET.encode(), output.stdout + output.stderr)

    def test_documented_linkat_fallback_uses_only_its_own_fd(self):
        for error in (errno.EPERM, errno.EACCES, errno.ENOENT):
            with self.subTest(error=error):
                link = mock.Mock(side_effect=[-1, 0])
                with mock.patch.object(ctypes, "CDLL", return_value=types.SimpleNamespace(linkat=link)), \
                        mock.patch.object(ctypes, "get_errno", return_value=error):
                    receiver._link_anonymous(21, 22, "credential.json")
                self.assertEqual(link.call_args_list, [
                    mock.call(21, b"", 22, b"credential.json", receiver.AT_EMPTY_PATH),
                    mock.call(receiver.AT_FDCWD, b"/proc/self/fd/21", 22,
                              b"credential.json", receiver.AT_SYMLINK_FOLLOW)])

    def test_existing_destination_error_never_attempts_a_second_link(self):
        link = mock.Mock(return_value=-1)
        with mock.patch.object(ctypes, "CDLL", return_value=types.SimpleNamespace(linkat=link)), \
                mock.patch.object(ctypes, "get_errno", return_value=errno.EEXIST):
            with self.assertRaises(OSError):
                receiver._link_anonymous(21, 22, "credential.json")
        self.assertEqual(link.call_count, 1)


@unittest.skipUnless(sys.platform == "linux" and hasattr(os, "O_TMPFILE"),
                     "Anonymous credential install requires Linux O_TMPFILE")
class ReceiverTests(unittest.TestCase):
    def setUp(self):
        # These storage fault tests must not irreversibly change the unittest
        # parent's resource/dumpability settings. Fresh child tests below use
        # the real guard, including an actual non-root anonymous install.
        self.core_guard = mock.patch.object(receiver, "_disable_core_dumps")
        self.core_guard.start()
        self.addCleanup(self.core_guard.stop)
        self.directory = tempfile.TemporaryDirectory(prefix="lingobar-dummy-key-")
        self.root = Path(self.directory.name)
        self.destination = self.root / "private"
        self.destination.mkdir(mode=0o700)
        self.filename = self.destination / "deepseek.json"
        self.config_path = self.root / "receiver.json"
        self.config = {"version": 1, "enabled": True,
                       "targetId": receiver.TARGET_ID,
                       "credentialsFile": str(self.filename)}
        self.write_config()
        self.payload = {"version": 1, "provider": "deepseek",
                        "targetId": receiver.TARGET_ID, "apiKey": SECRET}

    def tearDown(self):
        self.directory.cleanup()

    def write_config(self):
        self.config_path.write_text(json.dumps(self.config))
        self.config_path.chmod(0o600)

    def run_receive(self, payload=None, data=None, timeout=1):
        if data is None:
            data = json.dumps(self.payload if payload is None else payload).encode()
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, data)
            os.close(write_fd)
            write_fd = None
            result = receiver.receive(self.config_path, read_fd, timeout)
            self.assertNotIn(SECRET, json.dumps(result))
            return result
        finally:
            os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)

    def assert_empty(self):
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_probe_checks_anonymous_file_support_without_persisting_a_file(self):
        result = receiver.probe(self.config_path)
        self.assertEqual(result, {"version": 1, "status": "ready",
                                  "targetId": receiver.TARGET_ID,
                                  "receiverSha256": hashlib.sha256(SCRIPT.read_bytes()).hexdigest()})
        self.assert_empty()

    def test_real_unprivileged_initial_install_is_atomic_private_and_idempotently_refused(self):
        self.assertEqual(self.run_receive()["status"], "installed")
        self.assertEqual(json.loads(self.filename.read_text()), {"apiKey": SECRET})
        current = self.filename.stat()
        self.assertEqual(stat.S_IMODE(current.st_mode), 0o600)
        self.assertEqual(current.st_uid, os.geteuid())
        self.assertEqual(current.st_nlink, 1)
        before = self.filename.read_bytes()
        self.assertEqual(self.run_receive()["status"], "blocked")
        self.assertEqual(self.filename.read_bytes(), before)
        self.assertEqual([item.name for item in self.destination.iterdir()], ["deepseek.json"])

    def test_real_ssh_style_socketpair_input_is_supported(self):
        client, server = socket.socketpair()
        try:
            client.sendall(json.dumps(self.payload).encode())
            client.shutdown(socket.SHUT_WR)
            result = receiver.receive(self.config_path, server.fileno(), 1)
            self.assertEqual(result["status"], "installed")
        finally:
            client.close()
            server.close()

    def test_existing_noncredential_file_and_symlink_are_never_read_or_overwritten(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink):
                old = self.root / "old-file"
                old.write_text("SYNTHETIC-OLD-CONTENTS")
                if symlink:
                    self.filename.symlink_to(old)
                else:
                    self.filename.write_text("SYNTHETIC-OLD-CONTENTS")
                self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
                self.assertEqual(self.run_receive()["status"], "blocked")
                self.assertEqual(old.read_text(), "SYNTHETIC-OLD-CONTENTS")
                self.filename.unlink()

    def test_configuration_is_exact_enabled_owned_regular_and_private(self):
        changes = [lambda v: v.update(enabled=False), lambda v: v.update(version=True),
                   lambda v: v.update(version=2), lambda v: v.update(extra="reject"),
                   lambda v: v.update(targetId="another-target"),
                   lambda v: v.update(credentialsFile=None),
                   lambda v: v.update(credentialsFile="relative.json")]
        for change in changes:
            with self.subTest(change=change):
                candidate = dict(self.config)
                change(candidate)
                self.config_path.write_text(json.dumps(candidate))
                self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
                self.assert_empty()
        self.write_config()
        self.config_path.chmod(0o666)
        self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")

    def test_configuration_symlink_and_hardlink_are_rejected(self):
        real = self.root / "real-config.json"
        self.config_path.rename(real)
        self.config_path.symlink_to(real)
        self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
        self.config_path.unlink()
        os.link(real, self.config_path)
        self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
        self.assert_empty()

    def test_world_accessible_or_symlink_parent_destination_is_rejected(self):
        self.destination.chmod(0o755)
        self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
        self.destination.chmod(0o700)
        alias = self.root / "alias"
        alias.symlink_to(self.destination)
        self.config["credentialsFile"] = str(alias / "key.json")
        self.write_config()
        self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
        self.assert_empty()

    def test_disabled_or_missing_anonymous_file_support_never_creates_named_staging(self):
        with mock.patch.object(receiver.os, "open", side_effect=OSError(errno.EOPNOTSUPP, "synthetic")):
            self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
        self.assert_empty()

    def test_payload_exact_shape_provider_key_bounds_and_unicode(self):
        changes = [lambda v: v.update(extra=1), lambda v: v.pop("apiKey"),
                   lambda v: v.update(version=True), lambda v: v.update(version=2),
                   lambda v: v.update(provider="asr"), lambda v: v.update(targetId="wrong"),
                   lambda v: v.update(apiKey="x" * 15), lambda v: v.update(apiKey="x" * 2049),
                   lambda v: v.update(apiKey="x" * 16 + "\n"),
                   lambda v: v.update(apiKey="x" * 16 + " "),
                   lambda v: v.update(apiKey="x" * 16 + "あ"),
                   lambda v: v.update(apiKey=123)]
        for change in changes:
            with self.subTest(change=change):
                value = dict(self.payload)
                change(value)
                self.assertEqual(self.run_receive(payload=value)["status"], "not_installed")
                self.assert_empty()

    def test_payload_invalid_json_duplicate_keys_overflow_or_nonobject(self):
        values = [b"", b"{invalid", b"[]", b"null", b"\xff", b"x" * 4097,
                  b'{"version":1,"version":1,"provider":"deepseek","targetId":"lingobar-deepseek-primary","apiKey":"xxxxxxxxxxxxxxxx"}']
        for value in values:
            with self.subTest(length=len(value)):
                self.assertEqual(self.run_receive(data=value)["status"], "not_installed")
                self.assert_empty()

    def test_regular_file_input_is_refused(self):
        source = self.root / "synthetic-source.json"
        source.write_text(json.dumps(self.payload))
        with source.open("rb") as handle:
            self.assertEqual(receiver.receive(self.config_path, handle.fileno(), 1)["status"], "not_installed")
        self.assert_empty()

    def test_nonterminated_pipe_hits_deadline_without_creating_a_file(self):
        read_fd, write_fd = os.pipe()
        try:
            started = time.monotonic()
            self.assertEqual(receiver.receive(self.config_path, read_fd, 0.02)["status"], "not_installed")
            self.assertLess(time.monotonic() - started, 3)
            self.assert_empty()
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_short_writes_are_handled_without_truncation(self):
        actual = receiver.os.write
        with mock.patch.object(receiver.os, "write", side_effect=lambda fd, data: actual(fd, data[:3])):
            # Constructing the input pipe uses os.write too, so supply it first.
            read_fd, write_fd = os.pipe()
            try:
                actual(write_fd, json.dumps(self.payload).encode())
                os.close(write_fd)
                result = receiver.receive(self.config_path, read_fd, 1)
            finally:
                os.close(read_fd)
        self.assertEqual(result["status"], "installed")
        self.assertEqual(json.loads(self.filename.read_text()), {"apiKey": SECRET})

    def test_failures_before_link_leave_no_named_secret_file(self):
        stages = ("anonymous", "write", "file_sync", "link", "directory_changed")
        for stage in stages:
            with self.subTest(stage=stage):
                if stage == "anonymous":
                    patch = mock.patch.object(receiver, "_anonymous", side_effect=OSError("dummy failure"))
                elif stage == "write":
                    patch = mock.patch.object(receiver.os, "write", return_value=0)
                elif stage == "file_sync":
                    patch = mock.patch.object(receiver.os, "fsync", side_effect=OSError("dummy failure"))
                elif stage == "link":
                    patch = mock.patch.object(receiver, "_link_anonymous", side_effect=OSError(errno.EPERM, "dummy failure"))
                else:
                    original = receiver._directory_unchanged
                    calls = [0]
                    def change(target):
                        calls[0] += 1
                        if calls[0] > 1:
                            raise OSError("dummy failure")
                        original(target)
                    patch = mock.patch.object(receiver, "_directory_unchanged", side_effect=change)
                read_fd, write_fd = os.pipe()
                os.write(write_fd, json.dumps(self.payload).encode())
                os.close(write_fd)
                try:
                    with patch:
                        self.assertEqual(receiver.receive(self.config_path, read_fd, 1)["status"], "not_installed")
                finally:
                    os.close(read_fd)
                self.assert_empty()

    def test_directory_fsync_failure_is_uncertain_and_keeps_intended_final_file(self):
        original = receiver.os.fsync
        def fail_directory(descriptor):
            if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                raise OSError("dummy failure containing " + SECRET)
            original(descriptor)
        with mock.patch.object(receiver.os, "fsync", side_effect=fail_directory):
            result = self.run_receive()
        self.assertEqual(result["status"], "outcome_unknown")
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(json.loads(self.filename.read_text()), {"apiKey": SECRET})
        self.assertEqual(self.run_receive()["status"], "blocked")

    def test_racing_creator_is_preserved_and_link_failure_does_not_overwrite(self):
        actual = receiver._link_anonymous
        def raced(descriptor, directory_fd, name):
            self.filename.write_text("RACING-OWNER-FILE")
            actual(descriptor, directory_fd, name)
        with mock.patch.object(receiver, "_link_anonymous", side_effect=raced):
            self.assertEqual(self.run_receive()["status"], "not_installed")
        self.assertEqual(self.filename.read_text(), "RACING-OWNER-FILE")

    def test_interruption_after_kernel_publication_is_never_claimed_not_installed(self):
        actual = receiver._link_anonymous
        for error in (receiver.ReceiverError("synthetic cancellation"), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                def interrupted(descriptor, directory_fd, name):
                    actual(descriptor, directory_fd, name)
                    raise error
                with mock.patch.object(receiver, "_link_anonymous", side_effect=interrupted):
                    self.assertEqual(self.run_receive()["status"], "outcome_unknown")
                self.assertEqual(json.loads(self.filename.read_text()), {"apiKey": SECRET})
                self.assertEqual(self.run_receive()["status"], "blocked")
                self.filename.unlink()


@unittest.skipUnless(sys.platform == "linux", "Receiver hardening requires Linux")
class CoreAndSignalTests(unittest.TestCase):
    def child(self, body):
        setup = """
import ctypes,importlib.util,json,os,resource,signal,stat,sys,tempfile
from pathlib import Path
from unittest import mock
spec=importlib.util.spec_from_file_location('receiver_child',sys.argv[1])
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
"""
        output = subprocess.run([sys.executable, "-I", "-B", "-c",
                                 textwrap.dedent(setup) + textwrap.dedent(body), str(SCRIPT)],
                                capture_output=True, check=False, timeout=8)
        self.assertEqual(output.returncode, 0,
                         output.stderr.decode("utf-8", errors="replace"))
        self.assertNotIn(SECRET.encode(), output.stdout + output.stderr)
        return json.loads(output.stdout)

    def test_core_guard_failure_blocks_probe_and_receive_before_state_or_input(self):
        for failure in (OSError("synthetic failure"), RuntimeError("synthetic failure")):
            with self.subTest(failure=type(failure).__name__), \
                    mock.patch.object(receiver.resource, "setrlimit", side_effect=failure), \
                    mock.patch.object(receiver, "_open_target") as target, \
                    mock.patch.object(receiver, "_read_payload") as payload:
                self.assertEqual(receiver.probe()["status"], "blocked")
                self.assertEqual(receiver.receive()["status"], "blocked")
                target.assert_not_called(); payload.assert_not_called()

    def test_core_and_dumpable_readback_must_both_confirm_restriction(self):
        for limits, prctl_values in (((0, 1), [0, 0]), ((0, 0), [-1]), ((0, 0), [0, 1])):
            with self.subTest(limits=limits, prctl=prctl_values):
                prctl = mock.Mock(side_effect=prctl_values)
                with mock.patch.object(receiver.resource, "setrlimit") as restrict, \
                        mock.patch.object(receiver.resource, "getrlimit", return_value=limits), \
                        mock.patch.object(receiver.ctypes, "CDLL", return_value=types.SimpleNamespace(prctl=prctl)), \
                        mock.patch.object(receiver, "_open_target") as target:
                    self.assertEqual(receiver.receive()["status"], "blocked")
                    restrict.assert_called_once_with(receiver.resource.RLIMIT_CORE, (0, 0))
                    target.assert_not_called()

    def test_fresh_child_restricts_nonzero_core_limit_and_its_child_inherits_zero(self):
        result = self.child("""
initial=resource.getrlimit(resource.RLIMIT_CORE)
raised=initial[1]!=0
if raised:
 resource.setrlimit(resource.RLIMIT_CORE,(4096 if initial[1]==resource.RLIM_INFINITY else min(4096,initial[1]),initial[1]))
before=resource.getrlimit(resource.RLIMIT_CORE)
r._disable_core_dumps()
after=resource.getrlimit(resource.RLIMIT_CORE)
lib=ctypes.CDLL(None);dumpable=lib.prctl(3,0,0,0,0)
read_fd,write_fd=os.pipe();pid=os.fork()
if pid==0:
 os.close(read_fd);os.write(write_fd,json.dumps(list(resource.getrlimit(resource.RLIMIT_CORE))).encode());os._exit(0)
os.close(write_fd);inherited=json.loads(os.read(read_fd,1024));os.close(read_fd);os.waitpid(pid,0)
print(json.dumps({'raised':raised,'before':before,'after':after,'dumpable':dumpable,'child':inherited}))
""")
        self.assertEqual(result["after"], [0, 0])
        self.assertEqual(result["child"], [0, 0])
        self.assertEqual(result["dumpable"], 0)
        if result["raised"]:
            self.assertGreater(result["before"][0], 0)
        else:
            self.skipTest("Runner inherited hard core limit0; nonzero transition unavailable")

    def test_real_guard_still_allows_dummy_anonymous_install_as_current_nonroot_user(self):
        result = self.child("""
with tempfile.TemporaryDirectory(prefix='lingobar-guarded-dummy-') as directory:
 root=Path(directory);private=root/'private';private.mkdir(mode=0o700);destination=private/'key.json'
 config=root/'config.json';config.write_text(json.dumps({'version':1,'enabled':True,'targetId':r.TARGET_ID,'credentialsFile':str(destination)}));config.chmod(0o600)
 read_fd,write_fd=os.pipe();os.write(write_fd,json.dumps({'version':1,'provider':'deepseek','targetId':r.TARGET_ID,'apiKey':'dummy-key-for-guarded-install'}).encode());os.close(write_fd)
 result=r.receive(config,read_fd,1);os.close(read_fd)
 valid=destination.exists() and json.loads(destination.read_text())=={'apiKey':'dummy-key-for-guarded-install'}
 print(json.dumps({'status':result['status'],'valid':valid,'mode':stat.S_IMODE(destination.stat().st_mode) if valid else None,'uid':os.geteuid(),'core':resource.getrlimit(resource.RLIMIT_CORE),'dumpable':ctypes.CDLL(None).prctl(3,0,0,0,0)}))
""")
        self.assertEqual(result["status"], "installed")
        self.assertTrue(result["valid"])
        self.assertEqual(result["mode"], 0o600)
        self.assertNotEqual(result["uid"], 0, "This regression must exercise an unprivileged process")
        self.assertEqual(result["core"], [0, 0])
        self.assertEqual(result["dumpable"], 0)

    def test_sigquit_during_input_cancels_and_restores_handlers_and_mask(self):
        result = self.child("""
r._disable_core_dumps()
with tempfile.TemporaryDirectory(prefix='lingobar-quit-dummy-') as directory:
 root=Path(directory);private=root/'private';private.mkdir(mode=0o700);destination=private/'key.json'
 config=root/'config.json';config.write_text(json.dumps({'version':1,'enabled':True,'targetId':r.TARGET_ID,'credentialsFile':str(destination)}));config.chmod(0o600)
 handlers={n:signal.getsignal(n) for n in r.CANCEL_SIGNALS};mask=signal.pthread_sigmask(signal.SIG_BLOCK,set())
 def interrupted(*args):
  os.kill(os.getpid(),signal.SIGQUIT)
 with mock.patch.object(r,'_read_payload',side_effect=interrupted): result=r.receive(config,0,1)
 print(json.dumps({'status':result['status'],'empty':not destination.exists(),'handlersRestored':all(signal.getsignal(n)==h for n,h in handlers.items()),'maskRestored':signal.pthread_sigmask(signal.SIG_BLOCK,set())==mask}))
""")
        self.assertEqual(result["status"], "not_installed")
        self.assertTrue(result["empty"])
        self.assertTrue(result["handlersRestored"])
        self.assertTrue(result["maskRestored"])

    def test_repeated_sigquit_during_published_cleanup_cannot_skip_close_or_claim_rollback(self):
        result = self.child("""
r._disable_core_dumps()
with tempfile.TemporaryDirectory(prefix='lingobar-repeat-dummy-') as directory:
 root=Path(directory);private=root/'private';private.mkdir(mode=0o700);destination=private/'key.json'
 config=root/'config.json';config.write_text(json.dumps({'version':1,'enabled':True,'targetId':r.TARGET_ID,'credentialsFile':str(destination)}));config.chmod(0o600)
 read_fd,write_fd=os.pipe();os.write(write_fd,json.dumps({'version':1,'provider':'deepseek','targetId':r.TARGET_ID,'apiKey':'dummy-key-for-repeat-cancel'}).encode());os.close(write_fd)
 actual_link=r._link_anonymous;actual_close=r.os.close;state={'published':False,'injected':False,'closed':False}
 def link(*args):
  actual_link(*args);state['published']=True
 def close(fd):
  if state['published'] and not state['injected']:
   state['injected']=True;os.kill(os.getpid(),signal.SIGQUIT);os.kill(os.getpid(),signal.SIGTERM);os.kill(os.getpid(),signal.SIGQUIT)
   actual_close(fd);state['closed']=True
  else: actual_close(fd)
 handlers={n:signal.getsignal(n) for n in r.CANCEL_SIGNALS}
 with mock.patch.object(r,'_link_anonymous',side_effect=link),mock.patch.object(r.os,'close',side_effect=close): result=r.receive(config,read_fd,1)
 os.close(read_fd)
 print(json.dumps({'status':result['status'],'exists':destination.exists(),'closed':state['closed'],'injected':state['injected'],'handlersRestored':all(signal.getsignal(n)==h for n,h in handlers.items()),'pending':bool(signal.sigpending() & r.CANCEL_SIGNALS)}))
""")
        self.assertEqual(result["status"], "outcome_unknown")
        self.assertTrue(result["exists"])
        self.assertTrue(result["closed"])
        self.assertTrue(result["injected"])
        self.assertTrue(result["handlersRestored"])
        self.assertFalse(result["pending"])

    def test_repeated_sigquit_during_unpublished_buffer_cleanup_never_saves_the_key(self):
        result = self.child("""
from contextlib import contextmanager
r._disable_core_dumps()
with tempfile.TemporaryDirectory(prefix='lingobar-before-link-dummy-') as directory:
 root=Path(directory);private=root/'private';private.mkdir(mode=0o700);destination=private/'key.json'
 config=root/'config.json';config.write_text(json.dumps({'version':1,'enabled':True,'targetId':r.TARGET_ID,'credentialsFile':str(destination)}));config.chmod(0o600)
 read_fd,write_fd=os.pipe();os.write(write_fd,json.dumps({'version':1,'provider':'deepseek','targetId':r.TARGET_ID,'apiKey':'dummy-key-before-link-cancel'}).encode());os.close(write_fd)
 cleanup=r._cleanup_signals;sync=r.os.fsync;state={'synced':False,'injected':False}
 def fsync(fd):
  sync(fd)
  if stat.S_ISREG(os.fstat(fd).st_mode): state['synced']=True
 @contextmanager
 def interrupt_cleanup():
  with cleanup():
   if state['synced'] and not state['injected']:
    state['injected']=True;os.kill(os.getpid(),signal.SIGQUIT);os.kill(os.getpid(),signal.SIGTERM);os.kill(os.getpid(),signal.SIGQUIT)
   yield
 with mock.patch.object(r,'_cleanup_signals',interrupt_cleanup),mock.patch.object(r.os,'fsync',side_effect=fsync): result=r.receive(config,read_fd,1)
 os.close(read_fd)
 print(json.dumps({'status':result['status'],'empty':not destination.exists(),'injected':state['injected'],'pending':bool(signal.sigpending() & r.CANCEL_SIGNALS)}))
""")
        self.assertEqual(result["status"], "not_installed")
        self.assertTrue(result["empty"])
        self.assertTrue(result["injected"])
        self.assertFalse(result["pending"])


if __name__ == "__main__":
    unittest.main()

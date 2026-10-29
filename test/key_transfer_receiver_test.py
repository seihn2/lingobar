"""Dummy local installs only; retired plaintext transports never read stdin."""
import ctypes
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/secure-key/receive.py"
SPEC = importlib.util.spec_from_file_location("key_receiver_under_test", SCRIPT)
receiver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(receiver)
SECRET = b"synthetic-dummy-only-never-a-real-key"


class ProtocolTests(unittest.TestCase):
    def test_plaintext_cli_is_retired_for_every_argument_without_input(self):
        for arguments in ([], ["--probe"], ["--receive"], ["--receive", "/tmp/target"]):
            output = subprocess.run([sys.executable, "-I", "-B", str(SCRIPT), *arguments],
                                    input=SECRET, capture_output=True,
                                    check=False, timeout=5)
            self.assertEqual(output.returncode, 2)
            self.assertEqual(json.loads(output.stdout)["status"], "blocked")
            self.assertNotIn(SECRET, output.stdout + output.stderr)

    def test_plaintext_python_api_is_retired_even_with_enabled_arguments(self):
        with mock.patch.object(receiver.os, "read", side_effect=AssertionError("must not read")), \
                mock.patch.object(receiver, "_open_target") as target:
            self.assertEqual(receiver.receive("enabled-config", 0, 1)["status"], "blocked")
            target.assert_not_called()
        self.assertFalse(hasattr(receiver, "_read_payload"))
        self.assertFalse(hasattr(receiver, "_receive"))

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
        # Irreversible real protections are exercised only in fresh children.
        guard = mock.patch.object(receiver, "_disable_core_dumps")
        guard.start(); self.addCleanup(guard.stop)
        self.directory = tempfile.TemporaryDirectory(prefix="lingobar-dummy-key-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.destination = self.root / "private"
        self.destination.mkdir(mode=0o700)
        self.filename = self.destination / "deepseek.json"
        self.config_path = self.root / "receiver.json"
        self.config = {"version": 2, "enabled": True, "targetId": receiver.TARGET_ID,
                       "credentialsFile": str(self.filename),
                       "sessionDirectory": str(self.destination)}
        self.write_config()

    def write_config(self, value=None):
        self.config_path.write_text(json.dumps(self.config if value is None else value))
        self.config_path.chmod(0o600)

    def install(self, key=SECRET):
        result = receiver.install_key(self.config_path, key)
        self.assertNotIn(SECRET.decode(), json.dumps(result))
        return result

    def assert_empty(self):
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_probe_checks_anonymous_support_without_persisting_file(self):
        self.assertEqual(receiver.probe(self.config_path), {
            "version": 1, "status": "ready", "targetId": receiver.TARGET_ID,
            "receiverSha256": hashlib.sha256(SCRIPT.read_bytes()).hexdigest()})
        self.assert_empty()

    def test_real_unprivileged_install_is_atomic_private_and_repeat_refused(self):
        self.assertEqual(self.install()["status"], "installed")
        self.assertEqual(json.loads(self.filename.read_text()), {"apiKey": SECRET.decode()})
        current = self.filename.stat()
        self.assertEqual(stat.S_IMODE(current.st_mode), 0o600)
        self.assertEqual(current.st_uid, os.geteuid())
        self.assertEqual(current.st_nlink, 1)
        before = self.filename.read_bytes()
        self.assertEqual(self.install()["status"], "blocked")
        self.assertEqual(self.filename.read_bytes(), before)
        self.assertEqual([item.name for item in self.destination.iterdir()], ["deepseek.json"])

    def test_existing_file_and_symlink_never_read_or_overwritten(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink):
                old = self.root / "old-file"; old.write_text("SYNTHETIC-OLD-CONTENTS")
                if symlink:
                    self.filename.symlink_to(old)
                else:
                    self.filename.write_text("SYNTHETIC-OLD-CONTENTS")
                self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
                self.assertEqual(self.install()["status"], "blocked")
                self.assertEqual(old.read_text(), "SYNTHETIC-OLD-CONTENTS")
                self.filename.unlink()

    def test_config_exact_v2_enabled_owned_regular_private_and_bounded(self):
        changes = [lambda v: v.update(enabled=False), lambda v: v.update(version=True),
                   lambda v: v.update(version=1), lambda v: v.update(extra="reject"),
                   lambda v: v.update(targetId="another-target"),
                   lambda v: v.update(credentialsFile=None),
                   lambda v: v.update(credentialsFile="relative.json"),
                   lambda v: v.update(sessionDirectory=None),
                   lambda v: v.pop("sessionDirectory")]
        for change in changes:
            with self.subTest(change=change):
                candidate = dict(self.config); change(candidate); self.write_config(candidate)
                self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
                self.assert_empty()
        for raw in [b"[]", b"{broken", b"x" * 4097,
                    b'{"version":2,"version":2}']:
            self.config_path.write_bytes(raw)
            self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
        self.write_config(); self.config_path.chmod(0o666)
        self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")

    def test_config_symlink_and_hardlink_rejected(self):
        real = self.root / "real-config.json"; self.config_path.rename(real)
        self.config_path.symlink_to(real)
        self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
        self.config_path.unlink(); os.link(real, self.config_path)
        self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
        self.assert_empty()

    def test_config_changed_since_session_creation_rejects_new_destination(self):
        frozen = dict(self.config)
        alternative = self.destination / "other.json"
        self.config["credentialsFile"] = str(alternative)
        self.write_config()
        result = receiver.install_key(self.config_path, SECRET, expected_config=frozen)
        self.assertEqual(result["status"], "blocked")
        self.assert_empty()

    def test_world_accessible_or_symlink_target_parent_rejected(self):
        self.destination.chmod(0o755)
        self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
        self.destination.chmod(0o700)
        alias = self.root / "alias"; alias.symlink_to(self.destination)
        self.config["credentialsFile"] = str(alias / "key.json"); self.write_config()
        self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
        self.assert_empty()

    def test_missing_anonymous_support_never_falls_back_to_named_plaintext(self):
        with mock.patch.object(receiver, "_anonymous", side_effect=OSError(errno.EOPNOTSUPP, "synthetic")):
            self.assertEqual(receiver.probe(self.config_path)["status"], "blocked")
            self.assertEqual(self.install()["status"], "not_installed")
        self.assert_empty()

    def test_install_only_accepts_bounded_printable_ascii_bytes(self):
        for key in [None, 1, True, SECRET.decode(), b"x" * 15, b"x" * 129,
                    b"x" * 16 + b"\n", b"x" * 16 + b" ", b"x" * 16 + b"\xff"]:
            with self.subTest(type=type(key).__name__, length=len(key) if isinstance(key, (str, bytes)) else None):
                self.assertEqual(self.install(key)["status"], "not_installed")
                self.assert_empty()
        self.assertEqual(self.install(bytearray(SECRET))["status"], "installed")

    def test_short_writes_do_not_truncate(self):
        actual = receiver.os.write
        with mock.patch.object(receiver.os, "write", side_effect=lambda fd, data: actual(fd, data[:3])):
            self.assertEqual(self.install()["status"], "installed")
        self.assertEqual(json.loads(self.filename.read_text()), {"apiKey": SECRET.decode()})

    def test_failures_before_link_leave_no_named_secret(self):
        for stage in ("anonymous", "write", "file_sync", "link", "directory_changed"):
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
                    original, calls = receiver._directory_unchanged, [0]
                    def change(target):
                        calls[0] += 1
                        if calls[0] > 1: raise OSError("dummy failure")
                        original(target)
                    patch = mock.patch.object(receiver, "_directory_unchanged", side_effect=change)
                with patch:
                    self.assertEqual(self.install()["status"], "not_installed")
                self.assert_empty()

    def test_directory_fsync_failure_retains_final_file_and_reports_uncertainty(self):
        original = receiver.os.fsync
        def fail_directory(descriptor):
            if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                raise OSError("dummy failure containing " + SECRET.decode())
            original(descriptor)
        with mock.patch.object(receiver.os, "fsync", side_effect=fail_directory):
            self.assertEqual(self.install()["status"], "outcome_unknown")
        self.assertEqual(json.loads(self.filename.read_text()), {"apiKey": SECRET.decode()})
        self.assertEqual(self.install()["status"], "blocked")

    def test_racing_creator_is_preserved_without_overwrite(self):
        actual = receiver._link_anonymous
        def raced(descriptor, directory_fd, name):
            self.filename.write_text("RACING-OWNER-FILE"); actual(descriptor, directory_fd, name)
        with mock.patch.object(receiver, "_link_anonymous", side_effect=raced):
            self.assertEqual(self.install()["status"], "not_installed")
        self.assertEqual(self.filename.read_text(), "RACING-OWNER-FILE")

    def test_interruption_after_kernel_publication_is_never_false_rollback(self):
        actual = receiver._link_anonymous
        for error in (receiver.ReceiverError("synthetic cancellation"), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                def interrupted(descriptor, directory_fd, name):
                    actual(descriptor, directory_fd, name); raise error
                with mock.patch.object(receiver, "_link_anonymous", side_effect=interrupted):
                    self.assertEqual(self.install()["status"], "outcome_unknown")
                self.assertEqual(json.loads(self.filename.read_text()), {"apiKey": SECRET.decode()})
                self.assertEqual(self.install()["status"], "blocked"); self.filename.unlink()


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
        self.assertEqual(output.returncode, 0, output.stderr.decode("utf-8", errors="replace"))
        self.assertNotIn(SECRET, output.stdout + output.stderr)
        return json.loads(output.stdout)

    def test_guard_failure_blocks_probe_and_install_before_target_access(self):
        for failure in (OSError("synthetic failure"), RuntimeError("synthetic failure")):
            with self.subTest(failure=type(failure).__name__), \
                    mock.patch.object(receiver.resource, "setrlimit", side_effect=failure), \
                    mock.patch.object(receiver, "_open_target") as target:
                self.assertEqual(receiver.probe()["status"], "blocked")
                self.assertEqual(receiver.install_key("dummy", SECRET)["status"], "blocked")
                target.assert_not_called()

    def test_core_and_dumpable_readback_must_confirm_restriction(self):
        for limits, prctl_values in (((0, 1), [0, 0]), ((0, 0), [-1]), ((0, 0), [0, 1])):
            with self.subTest(limits=limits, prctl=prctl_values):
                prctl = mock.Mock(side_effect=prctl_values)
                with mock.patch.object(receiver.resource, "setrlimit") as restrict, \
                        mock.patch.object(receiver.resource, "getrlimit", return_value=limits), \
                        mock.patch.object(receiver.ctypes, "CDLL", return_value=types.SimpleNamespace(prctl=prctl)), \
                        mock.patch.object(receiver, "_open_target") as target:
                    self.assertEqual(receiver.install_key("dummy", SECRET)["status"], "blocked")
                    restrict.assert_called_once_with(receiver.resource.RLIMIT_CORE, (0, 0)); target.assert_not_called()

    def test_nonzero_core_limit_restricted_and_inherited(self):
        result = self.child("""
initial=resource.getrlimit(resource.RLIMIT_CORE);raised=initial[1]!=0
if raised: resource.setrlimit(resource.RLIMIT_CORE,(4096 if initial[1]==resource.RLIM_INFINITY else min(4096,initial[1]),initial[1]))
before=resource.getrlimit(resource.RLIMIT_CORE);r._disable_core_dumps()
read_fd,write_fd=os.pipe();pid=os.fork()
if pid==0:
 os.close(read_fd);os.write(write_fd,json.dumps(list(resource.getrlimit(resource.RLIMIT_CORE))).encode());os._exit(0)
os.close(write_fd);inherited=json.loads(os.read(read_fd,1024));os.close(read_fd);os.waitpid(pid,0)
print(json.dumps({'raised':raised,'before':before,'after':resource.getrlimit(resource.RLIMIT_CORE),'dumpable':ctypes.CDLL(None).prctl(3,0,0,0,0),'child':inherited}))
""")
        self.assertEqual(result["after"], [0, 0]); self.assertEqual(result["child"], [0, 0])
        self.assertEqual(result["dumpable"], 0)
        if result["raised"]: self.assertGreater(result["before"][0], 0)
        else: self.skipTest("Inherited hard core0; nonzero transition unavailable")

    def test_real_guard_allows_anonymous_install_as_nonroot(self):
        result = self.child("""
with tempfile.TemporaryDirectory(prefix='lingobar-guarded-dummy-') as directory:
 root=Path(directory);private=root/'private';private.mkdir(mode=0o700);destination=private/'key.json'
 config=root/'config.json';config.write_text(json.dumps({'version':2,'enabled':True,'targetId':r.TARGET_ID,'credentialsFile':str(destination),'sessionDirectory':str(private)}));config.chmod(0o600)
 result=r.install_key(config,bytearray(b'dummy-key-for-guarded-install'))
 valid=destination.exists() and json.loads(destination.read_text())=={'apiKey':'dummy-key-for-guarded-install'}
 print(json.dumps({'status':result['status'],'valid':valid,'mode':stat.S_IMODE(destination.stat().st_mode) if valid else None,'uid':os.geteuid(),'core':resource.getrlimit(resource.RLIMIT_CORE),'dumpable':ctypes.CDLL(None).prctl(3,0,0,0,0)}))
""")
        self.assertEqual(result["status"], "installed"); self.assertTrue(result["valid"])
        self.assertEqual(result["mode"], 0o600); self.assertNotEqual(result["uid"], 0)
        self.assertEqual(result["core"], [0, 0]); self.assertEqual(result["dumpable"], 0)

    def test_sigquit_before_install_restores_handlers_and_mask(self):
        result = self.child("""
r._disable_core_dumps()
handlers={n:signal.getsignal(n) for n in r.CANCEL_SIGNALS};mask=signal.pthread_sigmask(signal.SIG_BLOCK,set())
def interrupted(*args): os.kill(os.getpid(),signal.SIGQUIT)
with mock.patch.object(r,'_open_target',side_effect=interrupted): result=r.install_key('dummy',bytearray(b'dummy-sigquit-key'))
print(json.dumps({'status':result['status'],'handlersRestored':all(signal.getsignal(n)==h for n,h in handlers.items()),'maskRestored':signal.pthread_sigmask(signal.SIG_BLOCK,set())==mask}))
""")
        self.assertEqual(result["status"], "blocked")
        self.assertTrue(result["handlersRestored"]); self.assertTrue(result["maskRestored"])

    def test_repeated_sigquit_published_cleanup_closes_and_reports_uncertainty(self):
        result = self.child("""
r._disable_core_dumps()
with tempfile.TemporaryDirectory(prefix='lingobar-repeat-dummy-') as directory:
 root=Path(directory);private=root/'private';private.mkdir(mode=0o700);destination=private/'key.json'
 config=root/'config.json';config.write_text(json.dumps({'version':2,'enabled':True,'targetId':r.TARGET_ID,'credentialsFile':str(destination),'sessionDirectory':str(private)}));config.chmod(0o600)
 actual_link=r._link_anonymous;actual_close=r.os.close;state={'published':False,'injected':False,'closed':False}
 def link(*args): actual_link(*args);state['published']=True
 def close(fd):
  if state['published'] and not state['injected']:
   state['injected']=True;os.kill(os.getpid(),signal.SIGQUIT);os.kill(os.getpid(),signal.SIGTERM);os.kill(os.getpid(),signal.SIGQUIT)
   actual_close(fd);state['closed']=True
  else: actual_close(fd)
 handlers={n:signal.getsignal(n) for n in r.CANCEL_SIGNALS}
 with mock.patch.object(r,'_link_anonymous',side_effect=link),mock.patch.object(r.os,'close',side_effect=close): result=r.install_key(config,bytearray(b'dummy-key-for-repeat-cancel'))
 print(json.dumps({'status':result['status'],'exists':destination.exists(),'closed':state['closed'],'injected':state['injected'],'handlersRestored':all(signal.getsignal(n)==h for n,h in handlers.items()),'pending':bool(signal.sigpending() & r.CANCEL_SIGNALS)}))
""")
        self.assertEqual(result["status"], "outcome_unknown"); self.assertTrue(result["exists"])
        self.assertTrue(result["closed"]); self.assertTrue(result["injected"])
        self.assertTrue(result["handlersRestored"]); self.assertFalse(result["pending"])

    def test_repeated_sigquit_unpublished_cleanup_never_saves(self):
        result = self.child("""
from contextlib import contextmanager
r._disable_core_dumps()
with tempfile.TemporaryDirectory(prefix='lingobar-before-link-dummy-') as directory:
 root=Path(directory);private=root/'private';private.mkdir(mode=0o700);destination=private/'key.json'
 config=root/'config.json';config.write_text(json.dumps({'version':2,'enabled':True,'targetId':r.TARGET_ID,'credentialsFile':str(destination),'sessionDirectory':str(private)}));config.chmod(0o600)
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
 with mock.patch.object(r,'_cleanup_signals',interrupt_cleanup),mock.patch.object(r.os,'fsync',side_effect=fsync): result=r.install_key(config,bytearray(b'dummy-key-before-link-cancel'))
 print(json.dumps({'status':result['status'],'empty':not destination.exists(),'injected':state['injected'],'pending':bool(signal.sigpending() & r.CANCEL_SIGNALS)}))
""")
        self.assertEqual(result["status"], "not_installed"); self.assertTrue(result["empty"])
        self.assertTrue(result["injected"]); self.assertFalse(result["pending"])


if __name__ == "__main__":
    unittest.main()

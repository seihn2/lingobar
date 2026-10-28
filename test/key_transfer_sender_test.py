"""Dummy data only. No SSH, provider, desktop store or actual credential access."""
import base64
import copy
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import pty
import resource
import time
import select
import selectors
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("lingobar_secure_send", Path(__file__).resolve().parents[1] / "scripts/secure-key/send.py")
sender = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sender)
REAL_DISABLE_CORE_DUMPS = sender.disable_core_dumps
REAL_SSH_CHILD_CORE_POLICY = sender.ssh_child_core_policy
IDENTITY_DIRECTORY = None
IDENTITY_FILE = None
GUARD_PATCHES = []

def setUpModule():
    global IDENTITY_DIRECTORY, IDENTITY_FILE
    IDENTITY_DIRECTORY = tempfile.TemporaryDirectory()
    IDENTITY_FILE = str(Path(IDENTITY_DIRECTORY.name) / "synthetic_identity")
    Path(IDENTITY_FILE).write_bytes(b"dummy identity; not a private key")
    Path(IDENTITY_FILE).chmod(0o600)
    # Real irreversible process guards are tested in fresh children below.
    for name in ("disable_core_dumps", "ssh_child_core_policy"):
        item = patch.object(sender, name, return_value=None)
        item.start(); GUARD_PATCHES.append(item)

def tearDownModule():
    for item in GUARD_PATCHES: item.stop()
    IDENTITY_DIRECTORY.cleanup()

DUMMY = b"synthetic-not-a-real-key-123456789"
WIRE = struct.pack(">I", 11) + b"ssh-ed25519" + struct.pack(">I", 32) + bytes(range(32))


def profile():
    return {"version": 2, "enabled": True, "targetId": sender.TARGET_ID, "host": "203.0.113.10", "port": 22, "user": "lingobar",
            "identity_file": IDENTITY_FILE, "run_as": "direct", "sudo_policy": {"permission_verified": False, "stdin_logging_disabled_verified": False, "evidence_id": None},
            "hostKey": {"type": "ssh-ed25519", "base64": base64.b64encode(WIRE).decode(),
                        "sha256": "SHA256:" + base64.b64encode(hashlib.sha256(WIRE).digest()).decode().rstrip("=")}}


class ProfileTests(unittest.TestCase):
    def test_identity_path_is_metadata_only_and_explicitly_selected(self):
        with patch("builtins.open", side_effect=AssertionError("identity content must never be opened")), patch.object(Path, "read_bytes", side_effect=AssertionError("identity content must never be read")):
            self.assertEqual(sender.validate_identity_file(IDENTITY_FILE), IDENTITY_FILE)
            p = sender.validate_profile(profile())
            args = sender.ssh_arguments(p, "/synthetic/public_known_hosts", "probe")
        self.assertEqual(args[args.index("-i") + 1], IDENTITY_FILE)
        for item in ["IdentitiesOnly=yes", "IdentityAgent=none", "PreferredAuthentications=publickey", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "PKCS11Provider=none"]:
            self.assertIn(item, args)

    def test_identity_mutants_and_unsafe_permissions_fail_closed(self):
        for value in [None, "relative", "~/identity", "/tmp/%h/identity", "/tmp/identity\n", "/tmp/identity\x00", str(Path(IDENTITY_FILE).parent / ".." / "identity")]:
            with self.subTest(value=value), self.assertRaises((sender.TransferError, OSError)):
                sender.validate_identity_file(value)
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "dummy"; file.write_bytes(b"not a real private key"); file.chmod(0o600)
            link = Path(directory) / "link"; link.symlink_to(file)
            with self.assertRaises(sender.TransferError): sender.validate_identity_file(str(link))
            hard = Path(directory) / "hard"; os.link(file, hard)
            with self.assertRaises(sender.TransferError): sender.validate_identity_file(str(file))
            hard.unlink()
            for mode in [0o644, 0o660, 0o700, 0o000]:
                file.chmod(mode)
                with self.subTest(mode=mode), self.assertRaises(sender.TransferError): sender.validate_identity_file(str(file))
            for mode in [0o400, 0o600]:
                file.chmod(mode); self.assertEqual(sender.validate_identity_file(str(file)), str(file))
            actual = os.lstat(file)
            changed = Mock(st_mode=actual.st_mode, st_nlink=1, st_uid=os.getuid() + 1)
            with patch.object(sender.os, "lstat", return_value=changed), self.assertRaises(sender.TransferError): sender.validate_identity_file(str(file))

    def test_run_as_is_fixed_and_sudo_policy_is_required_before_any_probe(self):
        p = profile(); p["user"] = "azureuser"; p["run_as"] = "lingobar-test"
        key = Mock(); runner = Mock()
        for policy in [{"permission_verified": False, "stdin_logging_disabled_verified": False, "evidence_id": None},
                       {"permission_verified": True, "stdin_logging_disabled_verified": False, "evidence_id": "dummy"},
                       {"permission_verified": False, "stdin_logging_disabled_verified": True, "evidence_id": "dummy"}]:
            with self.subTest(policy=policy), self.assertRaises(sender.TransferError): sender.run_transfer({**p, "sudo_policy": policy}, key, runner)
        key.assert_not_called(); runner.assert_not_called()
        p["sudo_policy"] = {"permission_verified": True, "stdin_logging_disabled_verified": True, "evidence_id": "synthetic-reviewed-policy"}
        validated = sender.validate_profile(p)
        for mode in ["probe", "receive"]:
            args = sender.ssh_arguments(validated, "/synthetic/known_hosts", mode)
            self.assertEqual(args[-1], "/usr/bin/sudo -n -u lingobar-test -- /usr/bin/python3 -I -B /opt/lingobar-key-transfer/receive.py --" + mode)
            self.assertNotIn("sudo -l", " ".join(args)); self.assertNotIn("sudo -S", " ".join(args))
        for change in [{"run_as": "root"}, {"run_as": "lingobar-test;echo bad"}, {"run_as": ["sudo"]},
                       {"sudo_policy": {**p["sudo_policy"], "extra": True}}]:
            with self.subTest(change=change), self.assertRaises(sender.TransferError): sender.validate_profile({**p, **change})

    def test_dummy_pin_validates_and_known_hosts_uses_default_port_lookup(self):
        p = sender.validate_profile(profile())
        self.assertTrue(sender.public_known_hosts(p).startswith("203.0.113.10 ssh-ed25519 "))
        p["port"] = 2222
        self.assertTrue(sender.public_known_hosts(p).startswith("[203.0.113.10]:2222 "))
        p["host"] = "2001:db8::1"
        self.assertTrue(sender.public_known_hosts(p).startswith("[2001:db8::1]:2222 "))
        p["port"] = 22
        self.assertTrue(sender.public_known_hosts(p).startswith("2001:db8::1 ssh-ed25519 "))

    def test_closed_example_never_becomes_a_target(self):
        path = Path(sender.__file__).with_name("sender.example.json")
        with self.assertRaises(sender.TransferError):
            sender.validate_profile(json.loads(path.read_text()))

    def test_mutants_fail_closed(self):
        mutants = [
            {"version": True}, {"version": 1}, {"enabled": False}, {"enabled": 1}, {"targetId": "other"},
            {"host": None}, {"host": "example.com"}, {"host": "127.0.0.1"}, {"host": "::1"}, {"host": "0.0.0.0"},
            {"host": "fe80::1%en0"}, {"host": "224.0.0.1"}, {"host": "::"},
            {"port": True}, {"port": 0}, {"port": 65536}, {"port": "22"},
            {"user": "root"}, {"user": "name;touch /tmp/unsafe"}, {"user": "-oProxyCommand=unsafe"},
            {"hostKey": None}, {"extra": "rejected"},
        ]
        for change in mutants:
            with self.subTest(change=change), self.assertRaises(sender.TransferError):
                sender.validate_profile({**profile(), **change})
        for change in [{"type": "ssh-rsa"}, {"base64": "not valid"}, {"base64": base64.b64encode(WIRE[:-1]).decode()},
                       {"sha256": "SHA256:wrong"}, {"comment": "unknown"}]:
            p = profile(); p["hostKey"].update(change)
            with self.subTest(change=change), self.assertRaises(sender.TransferError):
                sender.validate_profile(p)

    def test_duplicate_json_fields_rejected(self):
        with self.assertRaises(sender.TransferError):
            sender.parse_json(b'{"version":1,"version":1}')

    def test_public_config_permissions_symlinks_and_size(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / "profile.json"; p.write_text("{}"); p.chmod(0o600)
            self.assertEqual(sender.read_public_file(p, 4096), b"{}")
            link = Path(directory) / "link.json"; link.symlink_to(p)
            with self.assertRaises(sender.TransferError): sender.read_public_file(link, 4096)
            p.chmod(0o666)
            with self.assertRaises(sender.TransferError): sender.read_public_file(p, 4096)
            p.chmod(0o600); p.write_bytes(b"x" * 4097)
            with self.assertRaises(sender.TransferError): sender.read_public_file(p, 4096)

    def test_arguments_and_environment_cannot_carry_the_api_key(self):
        p = sender.validate_profile(profile())
        args = sender.ssh_arguments(p, "/synthetic/public_known_hosts", "receive")
        for option in ["StrictHostKeyChecking=yes", "GlobalKnownHostsFile=/dev/null", "ForwardAgent=no", "AddKeysToAgent=no",
                       "ProxyCommand=none", "ProxyJump=none", "ClearAllForwardings=yes", "PermitLocalCommand=no",
                       "ControlMaster=no", "ControlPath=none", "ControlPersist=no", "SendEnv=-*", "BatchMode=yes"]:
            self.assertIn(option, args)
        self.assertEqual(args[:4], ["/usr/bin/ssh", "-F", "/dev/null", "-T"])
        self.assertEqual(args[-1], sender.REMOTE + " --receive")
        with patch.dict(os.environ, {"TRANSLATION_API_KEY": DUMMY.decode(), "LD_PRELOAD": "unsafe", "DYLD_INSERT_LIBRARIES": "unsafe", "SSH_ASKPASS": "unsafe", "SSH_AUTH_SOCK": "/synthetic/existing-agent"}, clear=True):
            env = sender.child_environment()
        self.assertEqual(set(env), {"PATH", "LC_ALL"})
        self.assertNotIn(DUMMY.decode(), repr(args) + repr(env))


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.receiver = Path(self.directory.name) / "receive.py"
        self.receiver.write_text("# synthetic receiver, never executed\n"); self.receiver.chmod(0o600)
        self.digest = hashlib.sha256(self.receiver.read_bytes()).hexdigest()

    def probe(self, **change):
        return json.dumps({"version": 1, "status": "ready", "targetId": sender.TARGET_ID, "receiverSha256": self.digest, **change}).encode()

    def reply(self, status="installed", **change):
        return json.dumps({"version": 1, "status": status, "targetId": sender.TARGET_ID, **change}).encode()

    def test_preflight_then_one_stdin_payload_no_secret_file_arguments_environment_or_output(self):
        key = bytearray(DUMMY); calls = []; files = []
        def runner(args, payload=None):
            pin = next(s.split("=", 1)[1] for s in args if s.startswith("UserKnownHostsFile="))
            files.append(pin)
            self.assertNotIn(DUMMY, Path(pin).read_bytes())
            self.assertEqual(stat.S_IMODE(Path(pin).stat().st_mode), 0o600)
            self.assertNotIn(DUMMY.decode(), repr(args) + repr(sender.child_environment()))
            calls.append((args, bytes(payload) if payload is not None else None, payload))
            return self.probe() if payload is None else self.reply()
        result = sender.run_transfer(profile(), lambda: key, runner, self.receiver)
        self.assertEqual(result, {"version": 1, "status": "installed", "targetId": sender.TARGET_ID})
        self.assertEqual(len(calls), 2); self.assertIsNone(calls[0][1])
        self.assertEqual(json.loads(calls[1][1]), {"version": 1, "provider": "deepseek", "targetId": sender.TARGET_ID, "apiKey": DUMMY.decode()})
        self.assertEqual(key, bytearray(len(DUMMY)))
        self.assertEqual(calls[1][2], bytearray(len(calls[1][2])))
        self.assertTrue(all(not Path(p).exists() for p in files))
        self.assertNotIn(DUMMY.decode(), json.dumps(result))

    def test_bad_profile_never_requests_key_or_opens_network(self):
        key = Mock(); runner = Mock()
        with self.assertRaises(sender.TransferError): sender.run_transfer({**profile(), "enabled": False}, key, runner, self.receiver)
        key.assert_not_called(); runner.assert_not_called()

    def test_bad_probe_and_host_failure_never_request_key(self):
        for response in [self.probe(receiverSha256="0" * 64), self.probe(targetId="other"), self.probe(version=True), b"not-json", self.probe(extra="no")]:
            key = Mock(); runner = Mock(return_value=response)
            self.assertEqual(sender.run_transfer(profile(), key, runner, self.receiver)["status"], "not_installed")
            key.assert_not_called(); self.assertEqual(runner.call_count, 1)
        key = Mock(); runner = Mock(side_effect=sender.TransferError("synthetic host mismatch"))
        self.assertEqual(sender.run_transfer(profile(), key, runner, self.receiver)["status"], "not_installed")
        key.assert_not_called(); self.assertEqual(runner.call_count, 1)

    def test_invalid_key_never_sends_receive(self):
        for data in [b"short", b"x" * 2049, b"a" * 16 + b"\n", b"a" * 16 + b" ", b"a" * 16 + b"\x7f"]:
            runner = Mock(return_value=self.probe())
            self.assertEqual(sender.run_transfer(profile(), lambda: bytearray(data), runner, self.receiver)["status"], "not_installed")
            self.assertEqual(runner.call_count, 1)

    def test_receive_failures_are_uncertain_without_retry_or_raw_errors(self):
        for failure in [sender.TransferError(DUMMY.decode()), TimeoutError(DUMMY.decode()), b"not-json", self.reply(status="unexpected"), self.reply(targetId="other"), self.reply(extra="unknown")]:
            key = bytearray(DUMMY)
            runner = Mock(side_effect=[self.probe(), failure])
            result = sender.run_transfer(profile(), lambda: key, runner, self.receiver)
            self.assertEqual(result["status"], "outcome_unknown")
            self.assertEqual(runner.call_count, 2); self.assertEqual(key, bytearray(len(DUMMY)))
            self.assertNotIn(DUMMY.decode(), json.dumps(result))

    def test_explicit_receiver_statuses_are_preserved(self):
        for status in ["installed", "not_installed", "outcome_unknown"]:
            runner = Mock(side_effect=[self.probe(), self.reply(status)])
            self.assertEqual(sender.run_transfer(profile(), lambda: bytearray(DUMMY), runner, self.receiver)["status"], status)
            self.assertEqual(runner.call_count, 2)

    def test_interruption_clears_payload_without_retry(self):
        key = bytearray(DUMMY); payloads = []
        def runner(args, payload=None):
            if payload is None: return self.probe()
            payloads.append(payload); raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt): sender.run_transfer(profile(), lambda: key, runner, self.receiver)
        self.assertEqual(key, bytearray(len(DUMMY))); self.assertEqual(payloads[0], bytearray(len(payloads[0])))


class HiddenInputTests(unittest.TestCase):
    def tty_exchange(self, input_bytes):
        master, slave = pty.openpty(); name = os.ttyname(slave)
        before = termios.tcgetattr(slave)
        read_fd, write_fd = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(read_fd); os.close(master)
            sender.disable_core_dumps = REAL_DISABLE_CORE_DUMPS
            try:
                value = sender.read_hidden_key(name)
                result = {"value": bytes(value).decode("ascii")}
            except BaseException as error:
                result = {"error": type(error).__name__}
            os.write(write_fd, json.dumps(result).encode()); os.close(write_fd)
            os._exit(0)
        os.close(write_fd)
        try:
            self.assertTrue(select.select([master], [], [], 3)[0])
            prompt = os.read(master, 4096)
            self.assertIn(b"hidden", prompt)
            self.assertFalse(termios.tcgetattr(slave)[3] & (termios.ECHO | termios.ECHONL))
            os.write(master, input_bytes)
            self.assertTrue(select.select([read_fd], [], [], 3)[0])
            result = json.loads(os.read(read_fd, 8192))
            os.waitpid(child, 0); child = None
            self.assertEqual(termios.tcgetattr(slave), before)
            capture = bytearray(prompt)
            while select.select([master], [], [], 0)[0]: capture.extend(os.read(master, 4096))
            self.assertNotIn(DUMMY, capture)
            if "error" in result:
                errors = {"TransferError": sender.TransferError, "error": termios.error, "KeyboardInterrupt": KeyboardInterrupt}
                return [], [errors[result["error"]]]
            return [bytearray(result["value"].encode())], []
        finally:
            if child is not None:
                os.kill(child, signal.SIGKILL); os.waitpid(child, 0)
            os.close(read_fd); os.close(master); os.close(slave)

    def test_dummy_real_pty_has_no_echo_and_restores_attributes(self):
        result, errors = self.tty_exchange(DUMMY + b"\n")
        self.assertEqual(errors, []); self.assertEqual(result, [bytearray(DUMMY)])

    def test_invalid_or_excess_input_restores_echo_and_flushes_tail(self):
        for payload in [b"short\n", b"x" * 2050 + b"\n"]:
            result, errors = self.tty_exchange(payload)
            self.assertEqual(result, []); self.assertEqual(errors, [sender.TransferError])

    def test_non_tty_never_falls_back_to_stdin(self):
        with tempfile.NamedTemporaryFile() as file:
            with self.assertRaises(sender.TransferError): sender.read_hidden_key(file.name)

    def test_worker_thread_cannot_disable_echo_without_main_thread_signal_handlers(self):
        errors = []
        def reader():
            try: sender.read_hidden_key("/not/opened")
            except BaseException as error: errors.append(type(error))
        with patch.object(sender.os, "open") as opened:
            thread = threading.Thread(target=reader); thread.start(); thread.join(3)
        self.assertFalse(thread.is_alive()); self.assertEqual(errors, [ValueError]); opened.assert_not_called()

    def test_unavailable_echo_controls_fail_closed(self):
        master, slave = pty.openpty()
        try:
            with patch.object(sender.termios, "tcgetattr", side_effect=termios.error("synthetic")):
                with self.assertRaises(termios.error): sender.read_hidden_key(os.ttyname(slave))
        finally: os.close(master); os.close(slave)

    def test_sigterm_during_dummy_tty_input_restores_echo(self):
        master, slave = pty.openpty(); before = termios.tcgetattr(slave)
        code = "import importlib.util,sys;sys.dont_write_bytecode=True;s=importlib.util.spec_from_file_location('sender',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\ntry:m.read_hidden_key(sys.argv[2])\nexcept KeyboardInterrupt:sys.exit(2)\n"
        process = subprocess.Popen([sys.executable, "-c", code, sender.__file__, os.ttyname(slave)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertTrue(select.select([master], [], [], 3)[0]); prompt = os.read(master, 4096)
            self.assertIn(b"hidden", prompt); self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
            os.write(master, DUMMY[:10]); process.send_signal(signal.SIGTERM)
            output, errors = process.communicate(timeout=3)
            self.assertEqual(process.returncode, 2); self.assertEqual(termios.tcgetattr(slave), before)
            self.assertNotIn(DUMMY[:10], output + errors)
        finally:
            if process.poll() is None: process.kill(); process.wait()
            os.close(master); os.close(slave)

    def test_sigquit_during_dummy_tty_input_restores_echo_without_core(self):
        master, slave = pty.openpty(); before = termios.tcgetattr(slave)
        code = "import importlib.util,sys;sys.dont_write_bytecode=True;s=importlib.util.spec_from_file_location('sender',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\ntry:m.read_hidden_key(sys.argv[2])\nexcept KeyboardInterrupt:sys.exit(2)\n"
        with tempfile.TemporaryDirectory() as directory:
            process = subprocess.Popen([sys.executable, "-c", code, sender.__file__, os.ttyname(slave)], cwd=directory, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.assertTrue(select.select([master], [], [], 3)[0]); self.assertIn(b"hidden", os.read(master, 4096))
                os.write(master, DUMMY[:10]); process.send_signal(signal.SIGQUIT)
                output, errors = process.communicate(timeout=3)
                self.assertEqual(process.returncode, 2); self.assertEqual(termios.tcgetattr(slave), before)
                self.assertNotIn(DUMMY[:10], output + errors); self.assertEqual(list(Path(directory).iterdir()), [])
            finally:
                if process.poll() is None: process.kill(); process.wait()
                os.close(master); os.close(slave)

    def test_repeated_quit_term_during_flush_failure_cannot_interrupt_echo_restoration(self):
        def fail_flush(*_args):
            for number in [signal.SIGQUIT, signal.SIGTERM, signal.SIGQUIT, signal.SIGTERM]: os.kill(os.getpid(), number)
            raise termios.error(errno.EIO, "synthetic flush failure")
        with patch.object(sender.termios, "tcflush", side_effect=fail_flush):
            result, errors = self.tty_exchange(DUMMY + b"\n")
        self.assertEqual(result, []); self.assertEqual(errors, [KeyboardInterrupt])

    def test_repeated_quit_and_transient_eintr_during_restore_are_coalesced(self):
        actual = termios.tcsetattr
        failed = False
        def restore(fd, when, attributes):
            nonlocal failed
            if attributes[3] & termios.ECHO and not failed:
                failed = True
                os.kill(os.getpid(), signal.SIGQUIT); os.kill(os.getpid(), signal.SIGTERM)
                raise termios.error(errno.EINTR, "synthetic restore interruption")
            return actual(fd, when, attributes)
        with patch.object(sender.termios, "tcsetattr", side_effect=restore):
            result, errors = self.tty_exchange(DUMMY + b"\n")
        self.assertEqual(result, []); self.assertEqual(errors, [KeyboardInterrupt])

    def test_cleanup_restores_handlers_and_mask_after_ordinary_input(self):
        old = {n: signal.getsignal(n) for n in sender.CANCEL_SIGNALS}
        mask = signal.pthread_sigmask(signal.SIG_BLOCK, [])
        with sender.cancellation_scope():
            for number in sender.CANCEL_SIGNALS: self.assertNotEqual(signal.getsignal(number), signal.SIG_DFL)
        self.assertEqual({n: signal.getsignal(n) for n in sender.CANCEL_SIGNALS}, old)
        self.assertEqual(signal.pthread_sigmask(signal.SIG_BLOCK, []), mask)

    def test_flush_failure_still_restores_terminal_echo(self):
        with patch.object(sender.termios, "tcflush", side_effect=termios.error("synthetic flush failure")):
            result, errors = self.tty_exchange(DUMMY + b"\n")
        self.assertEqual(result, []); self.assertEqual(errors, [termios.error])


class BoundedProcessTests(unittest.TestCase):
    def test_failure_immediately_after_spawn_cannot_orphan_the_child(self):
        actual = sender.subprocess.Popen
        for failure in ["selector", "signal"]:
            children = []
            def start(*args, **kwargs):
                process = actual(*args, **kwargs); children.append(process)
                if failure == "signal": os.kill(os.getpid(), signal.SIGQUIT)
                return process
            with patch.object(sender.subprocess, "Popen", side_effect=start):
                if failure == "selector":
                    with patch.object(sender.selectors, "DefaultSelector", side_effect=RuntimeError("synthetic allocation")), self.assertRaises(RuntimeError):
                        sender.run_ssh([sys.executable, "-c", "import time;time.sleep(30)"])
                else:
                    with self.assertRaises(KeyboardInterrupt): sender.run_ssh([sys.executable, "-c", "import time;time.sleep(30)"])
            self.assertEqual(len(children), 1); self.assertIsNotNone(children[0].poll())
            self.assertTrue(children[0].stdin.closed); self.assertTrue(children[0].stdout.closed)

    def test_trusted_local_dummy_process_uses_stdin_and_discards_stderr(self):
        code = "import sys;v=sys.stdin.buffer.read();assert len(v)>16;sys.stderr.buffer.write(v);sys.stdout.buffer.write(b'{}')"
        self.assertEqual(sender.run_ssh([sys.executable, "-c", code], bytearray(DUMMY), timeout=3), b"{}")

    def test_timeout_and_output_overflow_kill_only_the_spawned_process(self):
        actual = sender.subprocess.Popen
        for code in ["import time;time.sleep(30)", "import sys,time;sys.stdout.write('x'*5000);sys.stdout.flush();time.sleep(30)"]:
            children = []
            def start(*args, **kwargs):
                process = actual(*args, **kwargs); children.append(process); return process
            with patch.object(sender.subprocess, "Popen", side_effect=start), self.assertRaises(sender.TransferError):
                sender.run_ssh([sys.executable, "-c", code], timeout=3 if "stdout" in code else 0.1)
            self.assertEqual(len(children), 1); self.assertIsNotNone(children[0].poll())

    def test_cancel_kills_child_without_automatic_retry(self):
        actual = sender.subprocess.Popen; children = []
        def start(*args, **kwargs):
            process = actual(*args, **kwargs); children.append(process); return process
        with patch.object(sender.subprocess, "Popen", side_effect=start), patch.object(selectors.DefaultSelector, "select", side_effect=KeyboardInterrupt()), self.assertRaises(KeyboardInterrupt):
            sender.run_ssh([sys.executable, "-c", "import time;time.sleep(30)"], timeout=3)
        self.assertEqual(len(children), 1); self.assertIsNotNone(children[0].poll())


class CoreProtectionTests(unittest.TestCase):
    def test_nonzero_limit_is_lowered_and_verified_not_assumed(self):
        with patch.object(sender.resource, "setrlimit") as set_limit, patch.object(sender.resource, "getrlimit", return_value=(0, 0)), patch.object(sender.ctypes, "CDLL") as library:
            library.return_value.prctl.return_value = 0
            REAL_DISABLE_CORE_DUMPS()
        set_limit.assert_called_once_with(resource.RLIMIT_CORE, (0, 0))
        with patch.object(sender.resource, "setrlimit", side_effect=ValueError("synthetic")), self.assertRaises(sender.TransferError): REAL_DISABLE_CORE_DUMPS()
        with patch.object(sender.resource, "setrlimit"), patch.object(sender.resource, "getrlimit", return_value=(1024, 2048)), self.assertRaises(sender.TransferError): REAL_DISABLE_CORE_DUMPS()

    def test_failure_prevents_network_and_key_prompt(self):
        key, runner = Mock(), Mock()
        with patch.object(sender, "disable_core_dumps", side_effect=sender.TransferError("synthetic unavailable")), self.assertRaises(sender.TransferError): sender.run_transfer(profile(), key, runner)
        key.assert_not_called(); runner.assert_not_called()

    def test_real_child_starts_with_nonzero_core_then_disables_own_and_inherited_limit(self):
        code = """import importlib.util,sys,resource,json,ctypes
soft,hard=resource.getrlimit(resource.RLIMIT_CORE)
if hard==0: sys.exit(77)
resource.setrlimit(resource.RLIMIT_CORE,(1048576 if hard==resource.RLIM_INFINITY else min(hard,1048576),hard))
assert resource.getrlimit(resource.RLIMIT_CORE)[0]>0
s=importlib.util.spec_from_file_location('sender',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.disable_core_dumps()
assert resource.getrlimit(resource.RLIMIT_CORE)==(0,0)
if sys.platform=='linux': assert ctypes.CDLL(None).prctl(3,0,0,0,0)==0
m.ssh_child_core_policy=lambda:None
response=m.run_ssh([sys.executable,'-c','import resource,json;print(json.dumps(resource.getrlimit(resource.RLIMIT_CORE)))'])
assert json.loads(response)==[0,0]
print('guard-ok')
"""
        child = subprocess.run([sys.executable, "-I", "-B", "-c", code, sender.__file__], capture_output=True, timeout=5)
        if child.returncode == 77: self.skipTest("Inherited hard limit was already zero; nonzero-to-zero call contract covered separately")
        self.assertEqual(child.returncode, 0, child.stderr.decode()); self.assertEqual(child.stdout.strip(), b"guard-ok")

    @unittest.skipUnless(sys.platform == "linux", "Linux core_pattern contract")
    def test_linux_piped_or_unknown_collector_blocks_ssh_before_spawn(self):
        for pattern in [b"|/usr/bin/collector %p\n", b"", b"x" * 4097]:
            with patch("builtins.open", return_value=io.BytesIO(pattern)), self.assertRaises(sender.TransferError): REAL_SSH_CHILD_CORE_POLICY()
        with patch("builtins.open", side_effect=PermissionError("synthetic")), self.assertRaises(sender.TransferError): REAL_SSH_CHILD_CORE_POLICY()
        with patch.object(sender, "ssh_child_core_policy", side_effect=sender.TransferError("synthetic unsafe collector")), patch.object(sender.subprocess, "Popen") as start, self.assertRaises(sender.TransferError): sender.run_ssh(["not executed"])
        start.assert_not_called()


if __name__ == "__main__":
    unittest.main()

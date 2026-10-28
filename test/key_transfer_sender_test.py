"""Dummy data only. No SSH, provider, desktop store or actual credential access."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import pty
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
DUMMY = b"synthetic-not-a-real-key-123456789"
WIRE = struct.pack(">I", 11) + b"ssh-ed25519" + struct.pack(">I", 32) + bytes(range(32))


def profile():
    return {"version": 1, "enabled": True, "targetId": sender.TARGET_ID, "host": "203.0.113.10", "port": 22, "user": "lingobar",
            "hostKey": {"type": "ssh-ed25519", "base64": base64.b64encode(WIRE).decode(),
                        "sha256": "SHA256:" + base64.b64encode(hashlib.sha256(WIRE).digest()).decode().rstrip("=")}}


class ProfileTests(unittest.TestCase):
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
            {"version": True}, {"version": 2}, {"enabled": False}, {"enabled": 1}, {"targetId": "other"},
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
        self.assertEqual(set(env), {"PATH", "LC_ALL", "SSH_AUTH_SOCK"})
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
        before = termios.tcgetattr(slave); result = []; errors = []
        def reader():
            try: result.append(sender.read_hidden_key(name))
            except BaseException as error: errors.append(type(error))
        thread = threading.Thread(target=reader, daemon=True); thread.start()
        ready, _, _ = select.select([master], [], [], 3)
        self.assertTrue(ready)
        prompt = os.read(master, 4096)
        self.assertIn(b"hidden", prompt)
        self.assertFalse(termios.tcgetattr(slave)[3] & (termios.ECHO | termios.ECHONL))
        os.write(master, input_bytes)
        thread.join(3); self.assertFalse(thread.is_alive())
        after = termios.tcgetattr(slave)
        self.assertEqual(after, before)
        capture = bytearray(prompt)
        while select.select([master], [], [], 0)[0]: capture.extend(os.read(master, 4096))
        self.assertNotIn(DUMMY, capture)
        os.close(master); os.close(slave)
        return result, errors

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

    def test_flush_failure_still_restores_terminal_echo(self):
        with patch.object(sender.termios, "tcflush", side_effect=termios.error("synthetic flush failure")):
            result, errors = self.tty_exchange(DUMMY + b"\n")
        self.assertEqual(result, []); self.assertEqual(errors, [termios.error])


class BoundedProcessTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()

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
GUARD_PATCHES = []
def setUpModule():
    item=patch.object(sender, "disable_core_dumps", return_value=None)
    item.start(); GUARD_PATCHES.append(item)
def tearDownModule():
    for item in GUARD_PATCHES: item.stop()
DUMMY = b"synthetic-not-a-real-key-123456789"

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

class CoreProtectionTests(unittest.TestCase):
    def test_nonzero_limit_is_lowered_and_verified_not_assumed(self):
        with patch.object(sender.resource, "setrlimit") as set_limit, patch.object(sender.resource, "getrlimit", return_value=(0, 0)), patch.object(sender.ctypes, "CDLL") as library:
            library.return_value.prctl.return_value = 0
            REAL_DISABLE_CORE_DUMPS()
        set_limit.assert_called_once_with(resource.RLIMIT_CORE, (0, 0))
        with patch.object(sender.resource, "setrlimit", side_effect=ValueError("synthetic")), self.assertRaises(sender.TransferError): REAL_DISABLE_CORE_DUMPS()
        with patch.object(sender.resource, "setrlimit"), patch.object(sender.resource, "getrlimit", return_value=(1024, 2048)), self.assertRaises(sender.TransferError): REAL_DISABLE_CORE_DUMPS()

    def test_real_child_starts_with_nonzero_core_then_disables_own_and_inherited_limit(self):
        code = """import importlib.util,sys,resource,json,ctypes,subprocess
soft,hard=resource.getrlimit(resource.RLIMIT_CORE)
if hard==0: sys.exit(77)
resource.setrlimit(resource.RLIMIT_CORE,(1048576 if hard==resource.RLIM_INFINITY else min(hard,1048576),hard))
assert resource.getrlimit(resource.RLIMIT_CORE)[0]>0
s=importlib.util.spec_from_file_location('sender',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.disable_core_dumps()
assert resource.getrlimit(resource.RLIMIT_CORE)==(0,0)
if sys.platform=='linux': assert ctypes.CDLL(None).prctl(3,0,0,0,0)==0
response=subprocess.check_output([sys.executable,'-c','import resource,json;print(json.dumps(resource.getrlimit(resource.RLIMIT_CORE)))'])
assert json.loads(response)==[0,0]
print('guard-ok')
"""
        child = subprocess.run([sys.executable, "-I", "-B", "-c", code, sender.__file__], capture_output=True, timeout=5)
        if child.returncode == 77: self.skipTest("Inherited hard limit was already zero; nonzero-to-zero call contract covered separately")
        self.assertEqual(child.returncode, 0, child.stderr.decode()); self.assertEqual(child.stdout.strip(), b"guard-ok")


if __name__ == "__main__":
    unittest.main()

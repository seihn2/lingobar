#!/usr/bin/env python3
"""Protected terminal helpers. Legacy plaintext SSH transfer is retired.

seal.py uses only these in-process primitives. This module never starts a child
or opens a network connection and its own CLI is permanently blocked.
"""
from contextlib import contextmanager
import ctypes
import errno
from functools import wraps
import json
import os
import resource
import signal
import stat
import sys
import termios

TARGET_ID = "lingobar-deepseek-primary"
MAX_KEY = 128
MAX_REPLY = 4096
CANCEL_SIGNALS = frozenset(getattr(signal, name) for name in
    ("SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP", "SIGQUIT") if hasattr(signal, name))

class TransferError(Exception):
    """Deliberately contains no raw external diagnostics or key material."""

def require(condition):
    if not condition:
        raise TransferError("Secure key transfer unavailable")

def exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)

def disable_core_dumps():
    """Irreversible process-local protection, before any sensitive operation."""
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        require(resource.getrlimit(resource.RLIMIT_CORE) == (0, 0))
        if sys.platform == "linux":
            library = ctypes.CDLL(None, use_errno=True)
            require(library.prctl(4, 0, 0, 0, 0) == 0)  # PR_SET_DUMPABLE
            require(library.prctl(3, 0, 0, 0, 0) == 0)  # PR_GET_DUMPABLE
        else:
            require(sys.platform == "darwin")
    except Exception:
        raise TransferError("Secure key transfer unavailable") from None

def _drain_pending(numbers):
    cancelled = False
    # Standard cancellation signals coalesce. They are blocked while consumed.
    for _ in range(len(numbers) * 2 + 1):
        pending = set(signal.sigpending()) & set(numbers)
        if not pending:
            break
        signal.sigwait(pending)
        cancelled = True
    return cancelled

@contextmanager
def blocked_cancellation():
    require(hasattr(signal, "pthread_sigmask") and hasattr(signal, "sigwait"))
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, CANCEL_SIGNALS)
    cancelled = False
    try:
        yield
    finally:
        cancelled = _drain_pending(CANCEL_SIGNALS - set(previous))
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)
        if cancelled:
            raise KeyboardInterrupt()

@contextmanager
def cancellation_scope():
    """Install handlers before echo-off; never restore defaults during cleanup."""
    require(hasattr(signal, "pthread_sigmask") and hasattr(signal, "sigwait"))
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, CANCEL_SIGNALS)
    handlers = {}
    cancelled = False
    def interrupted(_number, _frame):
        raise KeyboardInterrupt()
    try:
        for number in CANCEL_SIGNALS:
            handlers[number] = signal.signal(number, interrupted)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, CANCEL_SIGNALS)
        try:
            cancelled = _drain_pending(CANCEL_SIGNALS - set(previous))
            for number, old in handlers.items():
                signal.signal(number, old)
            cancelled = _drain_pending(CANCEL_SIGNALS - set(previous)) or cancelled
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)
        if cancelled:
            raise KeyboardInterrupt()

def protected_entry(function):
    @wraps(function)
    def protected(*args, **kwargs):
        disable_core_dumps()
        with cancellation_scope():
            return function(*args, **kwargs)
    return protected

def no_duplicates(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value)
        value[key] = item
    return value

def parse_json(data):
    require(len(data) <= MAX_REPLY)
    try:
        return json.loads(data, object_pairs_hook=no_duplicates)
    except (ValueError, UnicodeError):
        raise TransferError("Secure key transfer unavailable") from None

def read_public_file(filename, maximum):
    filename = os.path.abspath(filename)
    require(os.path.realpath(filename) == filename)
    before = os.lstat(filename)
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
            not before.st_mode & 0o022 and before.st_size <= maximum and
            before.st_uid in (os.getuid(), 0))
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        current = os.fstat(fd)
        require(current.st_dev == before.st_dev and current.st_ino == before.st_ino)
        data = os.read(fd, maximum + 1)
        require(len(data) <= maximum)
        return data
    finally:
        os.close(fd)

def valid_key(value):
    return isinstance(value, (bytes, bytearray)) and 16 <= len(value) <= MAX_KEY and all(33 <= char <= 126 for char in value)

def restore_terminal(fd, before):
    # A transient EINTR must not leave echo disabled. Permanent driver failures
    # still fail explicitly; no success or universal restoration is promised.
    for attempt in range(3):
        try:
            termios.tcsetattr(fd, termios.TCSAFLUSH, before)
            return
        except (InterruptedError, termios.error) as error:
            number = error.errno if isinstance(error, OSError) else error.args[0] if error.args else None
            if number != errno.EINTR or attempt == 2:
                raise

@protected_entry
def read_hidden_key(tty_path="/dev/tty"):
    """Fail closed without a verified character TTY; never fall back to stdin."""
    fd = os.open(tty_path, os.O_RDWR | os.O_NOCTTY)
    before = None
    data = bytearray()
    try:
        try:
            require(os.isatty(fd) and stat.S_ISCHR(os.fstat(fd).st_mode))
            before = termios.tcgetattr(fd)
            after = list(before)
            after[3] &= ~(termios.ECHO | termios.ECHONL)
            termios.tcsetattr(fd, termios.TCSAFLUSH, after)
            require(not termios.tcgetattr(fd)[3] & (termios.ECHO | termios.ECHONL))
            os.write(fd, b"DeepSeek key (hidden; type directly, no clipboard): ")
            while True:
                chunk = os.read(fd, 1)
                require(bool(chunk))
                if chunk in (b"\n", b"\r"):
                    break
                data.extend(chunk)
                require(len(data) <= MAX_KEY)
            require(valid_key(data))
        finally:
            with blocked_cancellation():
                try:
                    if before is not None:
                        # A second cancellation cannot skip echo restoration.
                        try:
                            termios.tcflush(fd, termios.TCIFLUSH)
                        finally:
                            restore_terminal(fd, before)
                        os.write(fd, b"\n")
                finally:
                    os.close(fd)
    except BaseException:
        data[:] = b"\0" * len(data)
        raise
    return data

def main():
    # Retired: sshd can retain stdin plaintext even when this process forbids core.
    # seal.py reuses only the protected TTY helpers; it never starts SSH.
    print('{"version":1,"status":"blocked"}')
    return 2

if __name__ == "__main__":
    sys.exit(main())

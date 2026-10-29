#!/usr/bin/env python3
"""Fixed DeepSeek credential receiver. No export, network, shell or key lookup.

An operator installs this file and a reviewed sibling key-transfer-receiver.json
for the existing service user. The example is disabled. Only an initial private
JSON credential file may be installed; existing files are never overwritten.
Linux O_TMPFILE is mandatory: no named plaintext staging file is created.
"""
import ctypes
from contextlib import contextmanager
import errno
import hashlib
import json
import os
from pathlib import Path
import resource
import signal
import stat
import sys

TARGET_ID = "lingobar-deepseek-primary"
CONFIG_PATH = Path(__file__).with_name("key-transfer-receiver.json")
MAX_INPUT_BYTES = 4096
AT_EMPTY_PATH = 0x1000
AT_SYMLINK_FOLLOW = 0x400
AT_FDCWD = -100
PR_GET_DUMPABLE = 3
PR_SET_DUMPABLE = 4
CANCEL_SIGNALS = frozenset(getattr(signal, name) for name in
                           ("SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"))


class ReceiverError(Exception):
    """Messages are intentionally generic and never contain caller data."""


def _deny():
    raise ReceiverError("Credential receiver unavailable")


def _disable_core_dumps():
    """Restrict this receiver process before accepting even synthetic input.

    RLIMIT_CORE alone does not cover a Linux piped core collector. Dumpability
    must also be disabled after exec/sudo, and both restrictions are verified.
    No caller's shell/system setting is changed; inherited child limits are0.
    """
    if sys.platform != "linux":
        _deny()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if resource.getrlimit(resource.RLIMIT_CORE) != (0, 0):
        _deny()
    library = ctypes.CDLL(None, use_errno=True)
    prctl = library.prctl
    prctl.argtypes = (ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong,
                     ctypes.c_ulong, ctypes.c_ulong)
    prctl.restype = ctypes.c_int
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0
            or prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0):
        _deny()


@contextmanager
def _cleanup_signals():
    """Repeated cancellation cannot interrupt descriptor/buffer cleanup.

    Coalesce newly queued cancellation and raise only after cleanup; never
    resume processing a key after cancellation during buffer cleanup. Signals
    already blocked by the caller remain pending for that caller.
    """
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, CANCEL_SIGNALS)
    try:
        yield
    finally:
        try:
            interrupted = False
            for number in CANCEL_SIGNALS - previous_mask:
                if number in signal.sigpending():
                    signal.sigwait({number})
                    interrupted = True
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        if interrupted:
            _deny()


@contextmanager
def _cancellation_scope():
    if not hasattr(signal, "pthread_sigmask"):
        _deny()
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, CANCEL_SIGNALS)
    handlers = {number: signal.getsignal(number) for number in CANCEL_SIGNALS}
    def cancelled(_number, _frame):
        _deny()
    try:
        for number in CANCEL_SIGNALS:
            signal.signal(number, cancelled)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, CANCEL_SIGNALS)
        try:
            for number in CANCEL_SIGNALS:
                signal.signal(number, signal.SIG_IGN)
            for number, handler in handlers.items():
                signal.signal(number, handler)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def _exact(value, names):
    return isinstance(value, dict) and set(value) == set(names)


def _object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            _deny()
        value[key] = item
    return value


def _json(data):
    return json.loads(data, object_pairs_hook=_object,
                      parse_constant=lambda _value: _deny())


def _canonical(path):
    value = os.fspath(path)
    if (not isinstance(value, str) or not os.path.isabs(value)
            or len(value) > 4096 or "\x00" in value
            or os.path.normpath(value) != value
            or os.path.realpath(value) != value):
        _deny()
    return value


def _read_config(filename):
    name = _canonical(filename)
    before = os.lstat(name)
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
            or before.st_uid not in (0, os.geteuid())
            or before.st_mode & 0o022 or before.st_size > MAX_INPUT_BYTES):
        _deny()
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        current = os.fstat(descriptor)
        if ((current.st_dev, current.st_ino) != (before.st_dev, before.st_ino)
                or not stat.S_ISREG(current.st_mode) or current.st_nlink != 1
                or current.st_uid not in (0, os.geteuid())
                or current.st_mode & 0o022 or current.st_size > MAX_INPUT_BYTES):
            _deny()
        data = os.read(descriptor, MAX_INPUT_BYTES + 1)
        if len(data) > MAX_INPUT_BYTES:
            _deny()
        value = _json(data.decode("utf-8", errors="strict"))
    finally:
        with _cleanup_signals():
            os.close(descriptor)
    if (not _exact(value, ("version", "enabled", "targetId", "credentialsFile", "sessionDirectory"))
            or type(value["version"]) is not int or value["version"] != 2
            or value["enabled"] is not True or value["targetId"] != TARGET_ID
            or not isinstance(value["credentialsFile"], str)
            or not isinstance(value["sessionDirectory"], str)):
        _deny()
    return value


class _Target:
    def __init__(self, directory, descriptor, name):
        self.directory = directory
        self.descriptor = descriptor
        self.name = name

    def close(self):
        with _cleanup_signals():
            if self.descriptor is not None:
                descriptor, self.descriptor = self.descriptor, None
                os.close(descriptor)


def _target_missing(target):
    try:
        os.stat(target.name, dir_fd=target.descriptor, follow_symlinks=False)
    except FileNotFoundError:
        return
    _deny()


def _directory_unchanged(target):
    current, opened = os.lstat(target.directory), os.fstat(target.descriptor)
    if (not stat.S_ISDIR(current.st_mode)
            or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino)
            or opened.st_uid != os.geteuid() or opened.st_mode & 0o077):
        _deny()


def _open_target(config_path, expected_config=None):
    if sys.platform != "linux" or not hasattr(os, "O_TMPFILE"):
        _deny()
    value = _read_config(config_path)
    if expected_config is not None and value != expected_config:
        _deny()
    filename = _canonical(value["credentialsFile"])
    directory, name = os.path.dirname(filename), os.path.basename(filename)
    if not name or name in (".", ".."):
        _deny()
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY
                         | os.O_NOFOLLOW | os.O_CLOEXEC)
    target = _Target(directory, descriptor, name)
    try:
        _directory_unchanged(target)
        _target_missing(target)
        return target
    except BaseException:
        target.close()
        raise


def _anonymous(target):
    descriptor = os.open(".", os.O_RDWR | os.O_TMPFILE | os.O_CLOEXEC,
                         0o600, dir_fd=target.descriptor)
    try:
        os.fchmod(descriptor, 0o600)
        current = os.fstat(descriptor)
        if (not stat.S_ISREG(current.st_mode) or current.st_nlink != 0
                or current.st_uid != os.geteuid()
                or stat.S_IMODE(current.st_mode) != 0o600):
            _deny()
        return descriptor
    except BaseException:
        with _cleanup_signals():
            os.close(descriptor)
        raise


def _link_anonymous(descriptor, directory_fd, name):
    library = ctypes.CDLL(None, use_errno=True)
    linkat = library.linkat
    linkat.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                       ctypes.c_char_p, ctypes.c_int)
    linkat.restype = ctypes.c_int
    destination = os.fsencode(name)
    if linkat(descriptor, b"", directory_fd, destination, AT_EMPTY_PATH) == 0:
        return
    error = ctypes.get_errno()
    # AT_EMPTY_PATH commonly needs CAP_DAC_READ_SEARCH. This documented Linux
    # alternative links only our own anonymous fd, without adding capabilities
    # or using any named temporary plaintext file. Missing procfs fails closed.
    if error not in (errno.EPERM, errno.EACCES, errno.ENOENT):
        raise OSError(error, "Credential install unavailable")
    source = ("/proc/self/fd/" + str(descriptor)).encode("ascii")
    if linkat(AT_FDCWD, source, directory_fd, destination,
              AT_SYMLINK_FOLLOW) != 0:
        raise OSError(ctypes.get_errno(), "Credential install unavailable")


def _result(status):
    return {"version": 1, "status": status, "targetId": TARGET_ID}


def _probe(config_path):
    target = None
    try:
        target = _open_target(config_path)
        descriptor = _anonymous(target)
        with _cleanup_signals():
            os.close(descriptor)
        result = _result("ready")
        result["receiverSha256"] = hashlib.sha256(
            Path(__file__).read_bytes()).hexdigest()
        return result
    except BaseException:
        return _result("blocked")
    finally:
        if target is not None:
            try:
                target.close()
            except OSError:
                pass


def _install_key(config_path, key, expected_config=None):
    target, descriptor, linked, publish_started = None, None, False, False
    try:
        target = _open_target(config_path, expected_config)
    except BaseException:
        return _result("blocked")
    try:
        if (not isinstance(key, (bytes, bytearray)) or not 16 <= len(key) <= 128
                or any(char < 33 or char > 126 for char in key)):
            _deny()
        key = bytes(key).decode("ascii")
        descriptor = _anonymous(target)
        content = bytearray((json.dumps({"apiKey": key}, separators=(",", ":"),
                                       ensure_ascii=True) + "\n").encode("ascii"))
        try:
            offset = 0
            while offset < len(content):
                written = os.write(descriptor, memoryview(content)[offset:])
                if written <= 0:
                    _deny()
                offset += written
            os.fsync(descriptor)
        finally:
            with _cleanup_signals():
                content[:] = b"\x00" * len(content)
        _directory_unchanged(target)
        _target_missing(target)
        # Mark the uncertainty window before entering the publication syscall:
        # a signal can run after linkat commits but before Python sets linked.
        publish_started = True
        try:
            _link_anonymous(descriptor, target.descriptor, target.name)
        except OSError as error:
            if error.errno in (errno.EEXIST, errno.EACCES, errno.EPERM,
                               errno.ENOENT, errno.ENOSPC, errno.EDQUOT,
                               errno.EROFS, errno.EXDEV, errno.EMLINK,
                               errno.ENAMETOOLONG, errno.ENOTDIR,
                               errno.EBADF, errno.EINVAL):
                publish_started = False
            raise
        linked = True
        os.fsync(target.descriptor)
        with _cleanup_signals():
            os.close(descriptor)
            descriptor = None
        target.close()
        return _result("installed")
    except BaseException:
        # After linkat, the intended final file may be installed even when the
        # directory sync/close or response failed. Never claim rollback/refund.
        return _result("outcome_unknown" if linked or publish_started
                       else "not_installed")
    finally:
        with _cleanup_signals():
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            if target is not None:
                try:
                    target.close()
                except OSError:
                    pass


def probe(config_path=CONFIG_PATH):
    try:
        _disable_core_dumps()
        with _cancellation_scope():
            return _probe(config_path)
    except BaseException:
        return _result("blocked")


def receive(*_args, **_kwargs):
    """Retired plaintext API; no input is read even for an enabled profile."""
    return _result("blocked")


def install_key(config_path, key, expected_config=None):
    """Internal receiver boundary; callers must authenticate/decrypt first.

    No plaintext CLI/stdin entrypoint is exposed. Never invokes a child process.
    """
    started = False
    try:
        _disable_core_dumps()
        with _cancellation_scope():
            started = True
            return _install_key(config_path, key, expected_config)
    except BaseException:
        return _result("outcome_unknown" if started else "blocked")


def main():
    # Retired plaintext SSH/stdin protocol. Use session.py with sealed payloads.
    sys.stdout.write(json.dumps(_result("blocked"), separators=(",", ":")) + "\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())

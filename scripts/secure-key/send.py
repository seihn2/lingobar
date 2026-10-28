#!/usr/bin/env python3
"""Explicit manual DeepSeek key transfer. Never decrypts the desktop key store.

Run without arguments after an operator installs the fixed, pinned profile.
No key is accepted from argv, environment, redirected stdin, clipboard or a file.
The SSH server and already-installed receiver remain trusted; the source digest
probe is a consistency check, not cryptographic remote attestation.
"""
import base64
from contextlib import contextmanager
import ctypes
import errno
from functools import wraps
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import resource
import selectors
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import termios
import time


TARGET_ID = "lingobar-deepseek-primary"
REMOTE = "/usr/bin/python3 -I -B /opt/lingobar-key-transfer/receive.py"
SSH = "/usr/bin/ssh"
MAX_KEY = 2048
MAX_REPLY = 4096
TIMEOUT = 30
CANCEL_SIGNALS = frozenset(getattr(signal, name) for name in
                           ("SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP", "SIGQUIT")
                           if hasattr(signal, name))


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


def ssh_child_core_policy():
    """exec can reset dumpable; refuse Linux piped collectors before SSH exec."""
    if sys.platform == "linux":
        try:
            with open("/proc/sys/kernel/core_pattern", "rb") as source:
                pattern = source.read(4097)
            require(bool(pattern) and len(pattern) <= 4096 and
                    not pattern.lstrip().startswith(b"|"))
            binary = os.stat(SSH, follow_symlinks=False)
            require(stat.S_ISREG(binary.st_mode) and
                    not binary.st_mode & (stat.S_ISUID | stat.S_ISGID))
        except Exception:
            raise TransferError("Secure key transfer unavailable") from None
    else:
        require(sys.platform == "darwin")


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


def validate_identity_file(value):
    # Metadata only. Only the existing SSH client may read this private file.
    require(isinstance(value, str) and value and len(value) <= 4096 and
            os.path.isabs(value) and os.path.normpath(value) == value and
            not any(char in value for char in ("~", "%")) and
            not any(ord(char) < 32 or ord(char) == 127 for char in value) and
            os.path.realpath(value) == value)
    current = os.lstat(value)
    require(stat.S_ISREG(current.st_mode) and current.st_nlink == 1 and
            current.st_uid == os.getuid() and
            stat.S_IMODE(current.st_mode) in (0o400, 0o600))
    return value


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


def validate_profile(value):
    require(exact(value, ["version", "enabled", "targetId", "host", "port", "user", "hostKey", "identity_file", "run_as", "sudo_policy"]))
    require(type(value["version"]) is int and value["version"] == 2 and
            value["enabled"] is True and value["targetId"] == TARGET_ID)
    require(type(value["port"]) is int and 1 <= value["port"] <= 65535)
    require(isinstance(value["host"], str) and "%" not in value["host"])
    try:
        address = ipaddress.ip_address(value["host"])
    except ValueError:
        raise TransferError("Secure key transfer unavailable") from None
    require(not (address.is_unspecified or address.is_loopback or address.is_multicast or address.is_link_local))
    require(isinstance(value["user"], str) and re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", value["user"]) and value["user"] != "root")
    validate_identity_file(value["identity_file"])
    require(value["run_as"] in ("direct", "lingobar-test"))
    policy = value["sudo_policy"]
    require(exact(policy, ["permission_verified", "stdin_logging_disabled_verified", "evidence_id"]) and
            type(policy["permission_verified"]) is bool and type(policy["stdin_logging_disabled_verified"]) is bool)
    if value["run_as"] == "lingobar-test":
        require(policy["permission_verified"] is True and policy["stdin_logging_disabled_verified"] is True and
                isinstance(policy["evidence_id"], str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", policy["evidence_id"]))
    else:
        require(policy == {"permission_verified": False, "stdin_logging_disabled_verified": False, "evidence_id": None})
    key = value["hostKey"]
    require(exact(key, ["type", "base64", "sha256"]) and key["type"] == "ssh-ed25519")
    require(isinstance(key["base64"], str) and len(key["base64"]) <= 100 and isinstance(key["sha256"], str))
    try:
        wire = base64.b64decode(key["base64"], validate=True)
    except (ValueError, TypeError):
        raise TransferError("Secure key transfer unavailable") from None
    require(len(wire) == 51 and wire[:4] == struct.pack(">I", 11) and wire[4:15] == b"ssh-ed25519" and wire[15:19] == struct.pack(">I", 32))
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(wire).digest()).decode("ascii").rstrip("=")
    require(key["sha256"] == fingerprint)
    # Normalize only the public network address, never the key.
    return {**value, "host": str(address)}


def load_profile():
    return validate_profile(parse_json(read_public_file(Path(__file__).with_name("key-transfer-sender.json"), 4096)))


def public_known_hosts(profile):
    host = profile["host"] if profile["port"] == 22 else "[%s]:%s" % (profile["host"], profile["port"])
    return "%s %s %s\n" % (host, profile["hostKey"]["type"], profile["hostKey"]["base64"])


def ssh_arguments(profile, known_hosts, mode):
    require(mode in ("probe", "receive"))
    options = ["BatchMode=yes", "StrictHostKeyChecking=yes", "UserKnownHostsFile=" + str(known_hosts),
               "GlobalKnownHostsFile=/dev/null", "UpdateHostKeys=no", "VerifyHostKeyDNS=no", "HostKeyAlgorithms=ssh-ed25519",
               "ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes", "PermitLocalCommand=no", "AddKeysToAgent=no",
               "IdentitiesOnly=yes", "IdentityAgent=none", "PreferredAuthentications=publickey", "PasswordAuthentication=no",
               "KbdInteractiveAuthentication=no", "GSSAPIAuthentication=no", "HostbasedAuthentication=no", "PKCS11Provider=none",
               "SendEnv=-*", "ProxyCommand=none", "ProxyJump=none", "ControlMaster=no", "ControlPath=none", "ControlPersist=no",
               "ConnectTimeout=10", "ConnectionAttempts=1", "ServerAliveInterval=5", "ServerAliveCountMax=2", "LogLevel=QUIET", "RequestTTY=no"]
    result = [SSH, "-F", "/dev/null", "-T"]
    for option in options:
        result.extend(["-o", option])
    command = REMOTE if profile["run_as"] == "direct" else "/usr/bin/sudo -n -u lingobar-test -- " + REMOTE
    result.extend(["-i", validate_identity_file(profile["identity_file"]), "-p", str(profile["port"]), "-l", profile["user"], profile["host"], command + " --" + mode])
    return result


def child_environment():
    return {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}


@protected_entry
def run_ssh(arguments, payload=None, timeout=TIMEOUT):
    """Bounded stdin/stdout, discarded diagnostics, one process with no retry."""
    ssh_child_core_policy()
    process = selector = data = None
    output = bytearray()
    cursor = 0
    try:
        # Hold cancellation until the new process is assigned and covered by
        # finally. A signal immediately after Popen must not orphan SSH.
        with blocked_cancellation():
            process = subprocess.Popen(arguments, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       env=child_environment(), close_fds=True, start_new_session=True)
            data = memoryview(payload if payload is not None else b"")
            selector = selectors.DefaultSelector()
        os.set_blocking(process.stdout.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ)
        if len(data):
            os.set_blocking(process.stdin.fileno(), False)
            selector.register(process.stdin, selectors.EVENT_WRITE)
        else:
            process.stdin.close()
        deadline = time.monotonic() + timeout
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TransferError("Secure key transfer unavailable")
            for item, event in selector.select(min(remaining, 0.25)):
                if item.fileobj is process.stdin:
                    count = os.write(process.stdin.fileno(), data[cursor:cursor + 4096])
                    cursor += count
                    if cursor == len(data):
                        selector.unregister(process.stdin)
                        process.stdin.close()
                elif event & selectors.EVENT_READ:
                    chunk = os.read(process.stdout.fileno(), MAX_REPLY + 1 - len(output))
                    if not chunk:
                        selector.unregister(process.stdout)
                    else:
                        output.extend(chunk)
                        require(len(output) <= MAX_REPLY)
        remaining = deadline - time.monotonic()
        require(remaining > 0 and process.wait(timeout=remaining) == 0)
        return bytes(output)
    except (OSError, subprocess.SubprocessError):
        raise TransferError("Secure key transfer unavailable") from None
    finally:
        with blocked_cancellation():
            try:
                if selector is not None:
                    selector.close()
            finally:
                try:
                    if process is not None:
                        if process.poll() is None:
                            try:
                                os.killpg(process.pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                        process.wait()
                finally:
                    try:
                        if process is not None:
                            process.stdout.close()
                            if not process.stdin.closed:
                                process.stdin.close()
                    finally:
                        if data is not None:
                            data.release()
                        output[:] = b"\0" * len(output)


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


@protected_entry
def run_transfer(profile, key_reader=read_hidden_key, runner=run_ssh, receiver_path=None):
    profile = validate_profile(profile)
    ssh_child_core_policy()
    receiver = receiver_path or Path(__file__).with_name("receive.py")
    receiver_hash = hashlib.sha256(read_public_file(receiver, 65536)).hexdigest()
    key = None
    payload = None
    dispatched = False
    try:
        # This temporary file contains the PUBLIC host key only, never the API key.
        with tempfile.TemporaryDirectory(prefix="lingobar-public-host-pin-") as directory:
            os.chmod(directory, 0o700)
            public_file = os.path.join(directory, "known_hosts")
            fd = os.open(public_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "w", encoding="ascii") as file:
                file.write(public_known_hosts(profile))
            probe = parse_json(runner(ssh_arguments(profile, public_file, "probe")))
            require(exact(probe, ["version", "status", "targetId", "receiverSha256"]) and type(probe["version"]) is int and
                    probe["version"] == 1 and probe["status"] == "ready" and probe["targetId"] == profile["targetId"] and probe["receiverSha256"] == receiver_hash)
            key = key_reader()
            require(valid_key(key))
            payload = bytearray(json.dumps({"version": 1, "provider": "deepseek", "targetId": profile["targetId"],
                                           "apiKey": bytes(key).decode("ascii")}, separators=(",", ":")).encode("ascii") + b"\n")
            dispatched = True
            reply = parse_json(runner(ssh_arguments(profile, public_file, "receive"), payload))
            require(exact(reply, ["version", "status", "targetId"]) and type(reply["version"]) is int and reply["version"] == 1 and
                    reply["targetId"] == profile["targetId"] and reply["status"] in ("installed", "not_installed", "outcome_unknown"))
            return {"version": 1, "status": reply["status"], "targetId": profile["targetId"]}
    except Exception:
        return {"version": 1, "status": "outcome_unknown" if dispatched else "not_installed", "targetId": profile["targetId"]}
    finally:
        with blocked_cancellation():
            if isinstance(key, bytearray):
                key[:] = b"\0" * len(key)
            if isinstance(payload, bytearray):
                payload[:] = b"\0" * len(payload)


def main():
    try:
        disable_core_dumps()
        with cancellation_scope():
            require(len(sys.argv) == 1)
            result = run_transfer(load_profile())
    except KeyboardInterrupt:
        result = {"version": 1, "status": "outcome_unknown"}
    except Exception:
        result = {"version": 1, "status": "blocked"}
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["status"] == "installed" else 2


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Explicit manual DeepSeek key transfer. Never decrypts the desktop key store.

Run without arguments after an operator installs the fixed, pinned profile.
No key is accepted from argv, environment, redirected stdin, clipboard or a file.
The SSH server and already-installed receiver remain trusted; the source digest
probe is a consistency check, not cryptographic remote attestation.
"""
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
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
REMOTE = "/usr/bin/python3 /opt/lingobar-key-transfer/receive.py"
SSH = "/usr/bin/ssh"
MAX_KEY = 2048
MAX_REPLY = 4096
TIMEOUT = 30


class TransferError(Exception):
    """Deliberately contains no raw external diagnostics or key material."""


def require(condition):
    if not condition:
        raise TransferError("Secure key transfer unavailable")


def exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


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
    require(exact(value, ["version", "enabled", "targetId", "host", "port", "user", "hostKey"]))
    require(type(value["version"]) is int and value["version"] == 1 and
            value["enabled"] is True and value["targetId"] == TARGET_ID)
    require(type(value["port"]) is int and 1 <= value["port"] <= 65535)
    require(isinstance(value["host"], str) and "%" not in value["host"])
    try:
        address = ipaddress.ip_address(value["host"])
    except ValueError:
        raise TransferError("Secure key transfer unavailable") from None
    require(not (address.is_unspecified or address.is_loopback or address.is_multicast or address.is_link_local))
    require(isinstance(value["user"], str) and re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", value["user"]) and value["user"] != "root")
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
               "SendEnv=-*", "ProxyCommand=none", "ProxyJump=none", "ControlMaster=no", "ControlPath=none", "ControlPersist=no",
               "ConnectTimeout=10", "ConnectionAttempts=1", "ServerAliveInterval=5", "ServerAliveCountMax=2", "LogLevel=QUIET", "RequestTTY=no"]
    result = [SSH, "-F", "/dev/null", "-T"]
    for option in options:
        result.extend(["-o", option])
    result.extend(["-p", str(profile["port"]), "-l", profile["user"], profile["host"], REMOTE + " --" + mode])
    return result


def child_environment():
    result = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}
    # Reuse an already-authorized agent socket; never add an identity or forward it.
    agent = os.environ.get("SSH_AUTH_SOCK")
    if agent and "\0" not in agent:
        result["SSH_AUTH_SOCK"] = agent
    return result


def run_ssh(arguments, payload=None, timeout=TIMEOUT):
    """Bounded stdin/stdout, discarded diagnostics, one process with no retry."""
    process = subprocess.Popen(arguments, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               env=child_environment(), close_fds=True, start_new_session=True)
    output = bytearray()
    data = memoryview(payload if payload is not None else b"")
    cursor = 0
    selector = selectors.DefaultSelector()
    try:
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
        selector.close()
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait()
        process.stdout.close()
        if not process.stdin.closed:
            process.stdin.close()
        data.release()
        output[:] = b"\0" * len(output)


def valid_key(value):
    return isinstance(value, (bytes, bytearray)) and 16 <= len(value) <= MAX_KEY and all(33 <= char <= 126 for char in value)


def read_hidden_key(tty_path="/dev/tty"):
    """Fail closed without a verified character TTY; never fall back to stdin."""
    fd = os.open(tty_path, os.O_RDWR | os.O_NOCTTY)
    before = None
    handlers = {}
    data = bytearray()
    success = False
    cleanup_ok = False
    try:
        require(os.isatty(fd) and stat.S_ISCHR(os.fstat(fd).st_mode))
        before = termios.tcgetattr(fd)
        after = list(before)
        after[3] &= ~(termios.ECHO | termios.ECHONL)
        termios.tcsetattr(fd, termios.TCSAFLUSH, after)
        require(not termios.tcgetattr(fd)[3] & (termios.ECHO | termios.ECHONL))
        def interrupted(_signum, _frame):
            raise KeyboardInterrupt()
        for name in ("SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP"):
            number = getattr(signal, name, None)
            if number is not None:
                try:
                    handlers[number] = signal.signal(number, interrupted)
                except ValueError:  # Unit-test threads cannot install handlers.
                    pass
        os.write(fd, b"DeepSeek key (hidden; type directly, no clipboard): ")
        while True:
            chunk = os.read(fd, 1)
            require(bool(chunk))
            if chunk in (b"\n", b"\r"):
                break
            data.extend(chunk)
            require(len(data) <= MAX_KEY)
        require(valid_key(data))
        success = True
        return data
    finally:
        try:
            if before is not None:
                # Remove unread secret tail before restoring echo or returning to a shell.
                try:
                    termios.tcflush(fd, termios.TCIFLUSH)
                finally:
                    # Even a flush failure must not skip restoration of terminal echo.
                    termios.tcsetattr(fd, termios.TCSAFLUSH, before)
                os.write(fd, b"\n")
            cleanup_ok = True
        finally:
            for number, old in handlers.items():
                signal.signal(number, old)
            os.close(fd)
            if not (success and cleanup_ok):
                data[:] = b"\0" * len(data)


def run_transfer(profile, key_reader=read_hidden_key, runner=run_ssh, receiver_path=None):
    profile = validate_profile(profile)
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
        if isinstance(key, bytearray):
            key[:] = b"\0" * len(key)
        if isinstance(payload, bytearray):
            payload[:] = b"\0" * len(payload)


def main():
    handlers = {}
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    try:
        for name in ("SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP"):
            number = getattr(signal, name, None)
            if number is not None:
                handlers[number] = signal.signal(number, interrupted)
        require(len(sys.argv) == 1)
        result = run_transfer(load_profile())
    except KeyboardInterrupt:
        result = {"version": 1, "status": "outcome_unknown"}
    except Exception:
        result = {"version": 1, "status": "blocked"}
    finally:
        for number, old in handlers.items():
            signal.signal(number, old)
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["status"] == "installed" else 2


if __name__ == "__main__":
    sys.exit(main())

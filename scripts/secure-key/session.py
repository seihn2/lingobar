#!/usr/bin/env python3
"""One-shot local encrypted receiver; only ciphertext crosses the Azure channel.

The foreground service owns an ephemeral private key only in its protected memory.
No new TCP port, SSH connection, background launcher, secret export or automatic
restart is provided. An operator starts it under the already-authorized service
identity. Abruptly killed sessions leave a lock and require explicit inspection.
"""
import importlib.util
import json
import os
from pathlib import Path
import select
import socket
import stat
import struct
import sys
import time

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "key-transfer-receiver.json"
MAX_CIPHERTEXT = 2048
MAX_RESULT = 512
LIFETIME = 300
DELIVERY_DEADLINE = 10.0
FILES = (".lock", "transfer.sock", "challenge.json", "result.json")


def _load(name):
    spec = importlib.util.spec_from_file_location("lingobar_session_" + name,
                                                HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


receiver = _load("receive")


def _result(status):
    return {"version": 1, "status": status, "targetId": receiver.TARGET_ID}


def _encode(value):
    return (json.dumps(value, separators=(",", ":"), sort_keys=True,
                       ensure_ascii=True) + "\n").encode("ascii")


def _deny():
    raise receiver.ReceiverError("Encrypted credential session unavailable")


class _Directory:
    def __init__(self, value):
        self.path = receiver._canonical(value)
        self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY |
                          os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            self.check()
            # AF_UNIX paths are bounded. Resolve through our already-opened dir
            # so replacing a parent path cannot redirect the local connection.
            self.socket_path = "/proc/self/fd/%d/transfer.sock" % self.fd
            if len(os.fsencode(self.socket_path)) >= 108:
                _deny()
        except BaseException:
            os.close(self.fd)
            self.fd = None
            raise

    def check(self):
        current, opened = os.lstat(self.path), os.fstat(self.fd)
        if (not stat.S_ISDIR(current.st_mode) or
                (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino) or
                opened.st_uid != os.geteuid() or stat.S_IMODE(opened.st_mode) != 0o700):
            _deny()

    def exists(self, name):
        try:
            os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            return True
        except FileNotFoundError:
            return False

    def close(self):
        if self.fd is not None:
            descriptor, self.fd = self.fd, None
            os.close(descriptor)


def _configuration(config_path):
    config = receiver._read_config(config_path)
    if (type(config.get("version")) is not int or config["version"] != 2 or
            not isinstance(config.get("sessionDirectory"), str)):
        _deny()
    state = receiver._canonical(config["sessionDirectory"])
    target = receiver._canonical(config["credentialsFile"])
    # Public control metadata and the final private credential never share a
    # directory, including future reserved/public-temporary filenames.
    if os.path.dirname(target) == state:
        _deny()
    return config


def _metadata(directory, name):
    return os.stat(name, dir_fd=directory.fd, follow_symlinks=False)


def _remove_owned(directory, name, identity):
    try:
        current = _metadata(directory, name)
        if (current.st_dev, current.st_ino) == identity:
            os.unlink(name, dir_fd=directory.fd)
    except FileNotFoundError:
        pass


def _write_public(directory, name, value):
    """Publish complete nonsecret metadata, without replacing any existing file."""
    data = _encode(value)
    if len(data) > 4096:
        _deny()
    temporary = ".public-" + os.urandom(16).hex()
    fd = None
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                     os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory.fd)
        os.fchmod(fd, 0o600)
        offset = 0
        while offset < len(data):
            count = os.write(fd, data[offset:])
            if count <= 0:
                _deny()
            offset += count
        os.fsync(fd)
        directory.check()
        os.link(temporary, name, src_dir_fd=directory.fd,
                dst_dir_fd=directory.fd, follow_symlinks=False)
        current = os.fstat(fd)
        identity = (current.st_dev, current.st_ino)
        os.unlink(temporary, dir_fd=directory.fd)
        os.fsync(directory.fd)
        return identity
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temporary, dir_fd=directory.fd)
        except FileNotFoundError:
            pass
        # If directory-fsync fails after publication, leave the public final
        # file for inspection. Never erase an uncertain completed result.


def _read_message(connection, deadline, maximum):
    data = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _deny()
        readable, _, _ = select.select([connection], [], [], remaining)
        if not readable:
            _deny()
        part = connection.recv(min(1024, maximum + 1 - len(data)))
        if not part:
            break
        data.extend(part)
        if len(data) > maximum:
            _deny()
    if not data:
        _deny()
    return receiver._json(bytes(data).decode("ascii", errors="strict"))


def _same_uid(connection):
    if not hasattr(socket, "SO_PEERCRED"):
        _deny()
    value = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED,
                                  struct.calcsize("3i"))
    _pid, uid, _gid = struct.unpack("3i", value)
    return uid == os.geteuid()


def _serve(config_path, lifetime):
    directory = listener = connection = private = key = None
    owned = {}
    result = _result("blocked")
    started = install_started = False
    try:
        if type(lifetime) not in (int, float) or not 0 < lifetime <= LIFETIME:
            _deny()
        config = _configuration(config_path)
        directory = _Directory(config["sessionDirectory"])
        if any(directory.exists(name) for name in FILES):
            _deny()
        with receiver._cleanup_signals():
            fd = os.open(".lock", os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                         os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory.fd)
            try:
                current = os.fstat(fd)
                owned[".lock"] = (current.st_dev, current.st_ino)
                if current.st_nlink != 1 or current.st_uid != os.geteuid():
                    _deny()
                os.fchmod(fd, 0o600)
                os.fsync(fd)
                os.fsync(directory.fd)
            finally:
                os.close(fd)
        # Verify the eventual target and anonymous-creation facility before
        # allocating a key or publishing a challenge. No plaintext is read.
        target = receiver._open_target(config_path)
        try:
            anonymous = receiver._anonymous(target)
            os.close(anonymous)
        finally:
            target.close()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        with receiver._cleanup_signals():
            previous_umask = os.umask(0o077)
            try:
                listener.bind(directory.socket_path)
            finally:
                os.umask(previous_umask)
            current = _metadata(directory, "transfer.sock")
            owned["transfer.sock"] = (current.st_dev, current.st_ino)
            if not stat.S_ISSOCK(current.st_mode) or current.st_mode & 0o077:
                _deny()
        listener.listen(1)
        crypto = _load("envelope_crypto")
        deadline = time.monotonic() + lifetime
        private, challenge = crypto.create_challenge(receiver.TARGET_ID, int(time.time()))
        if time.monotonic() >= deadline:
            _deny()
        with receiver._cleanup_signals():
            owned["challenge.json"] = _write_public(directory, "challenge.json", challenge)
            started = True
        result = _result("expired")
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            ready, _, _ = select.select([listener], [], [], remaining)
            if not ready:
                break
            connection, _address = listener.accept()
            if not _same_uid(connection):
                connection.close()
                connection = None
                continue
            # Exactly one same-user submission is accepted. Even malformed,
            # oversized, incomplete or tampered submissions consume the key.
            listener.close()
            listener = None
            result = _result("not_installed")
            message = _read_message(connection,
                                    min(deadline, time.monotonic() + DELIVERY_DEADLINE),
                                    MAX_CIPHERTEXT)
            if message == {"version": 1, "action": "cancel"} and type(message["version"]) is int:
                result = _result("cancelled")
            else:
                if time.monotonic() >= deadline:
                    _deny()
                key = crypto.unseal(private, challenge, message, int(time.time()))
                # No re-entry: the key is consumed before the publication call.
                private = None
                directory.check()
                if _configuration(config_path) != config:
                    _deny()
                install_started = True
                result = receiver.install_key(config_path, key, expected_config=config)
                if (not receiver._exact(result, ("version", "status", "targetId")) or
                        type(result["version"]) is not int or result["version"] != 1 or
                        result["targetId"] != receiver.TARGET_ID or result["status"] not in
                        ("installed", "not_installed", "outcome_unknown", "blocked")):
                    result = _result("outcome_unknown")
                if result["status"] == "blocked":
                    result = _result("not_installed")
            break
    except BaseException:
        result = _result("outcome_unknown" if install_started else
                         "not_installed" if started else "blocked")
    finally:
        private = None
        if isinstance(key, bytearray):
            key[:] = b"\x00" * len(key)
        # Defeat repeated cancellation while closing descriptors and removing
        # this process's own public artifacts. Unknown stale files stay intact.
        with receiver._cleanup_signals():
            if listener is not None:
                listener.close()
            if directory is not None:
                if started:
                    try:
                        _write_public(directory, "result.json", result)
                    except BaseException:
                        if install_started:
                            result = _result("outcome_unknown")
                if connection is not None:
                    try:
                        connection.settimeout(1.0)
                        connection.sendall(_encode(result))
                    except OSError:
                        pass
                    connection.close()
                for name, identity in owned.items():
                    try:
                        _remove_owned(directory, name, identity)
                    except OSError:
                        pass
                try:
                    os.fsync(directory.fd)
                except OSError:
                    pass
                directory.close()
    return result


def serve(config_path=CONFIG_PATH, lifetime=LIFETIME):
    protected = False
    try:
        receiver._disable_core_dumps()
        protected = True
        with receiver._cancellation_scope():
            return _serve(config_path, lifetime)
    except BaseException:
        return _result("outcome_unknown" if protected else "blocked")


def _read_ciphertext(input_fd):
    current = os.fstat(input_fd)
    if (os.isatty(input_fd) or not (stat.S_ISFIFO(current.st_mode) or
                                  stat.S_ISSOCK(current.st_mode))):
        _deny()
    deadline, data = time.monotonic() + DELIVERY_DEADLINE, bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _deny()
        ready, _, _ = select.select([input_fd], [], [], remaining)
        if not ready:
            _deny()
        part = os.read(input_fd, min(1024, MAX_CIPHERTEXT + 1 - len(data)))
        if not part:
            break
        data.extend(part)
        if len(data) > MAX_CIPHERTEXT:
            _deny()
    value = receiver._json(bytes(data).decode("ascii", errors="strict"))
    if (not receiver._exact(value, ("version", "sessionId", "ciphertext")) or
            type(value["version"]) is not int or value["version"] != 1 or
            not isinstance(value["sessionId"], str) or len(value["sessionId"]) != 32 or
            not isinstance(value["ciphertext"], str) or len(value["ciphertext"]) != 684):
        _deny()
    return _encode(value)


def _client(config_path, data):
    directory = connection = None
    dispatched = False
    try:
        config = _configuration(config_path)
        directory = _Directory(config["sessionDirectory"])
        current = _metadata(directory, "transfer.sock")
        if (not stat.S_ISSOCK(current.st_mode) or current.st_uid != os.geteuid() or
                current.st_mode & 0o077):
            _deny()
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(DELIVERY_DEADLINE)
        connection.connect(directory.socket_path)
        if not _same_uid(connection):
            _deny()
        dispatched = True
        connection.sendall(data)
        connection.shutdown(socket.SHUT_WR)
        value = _read_message(connection, time.monotonic() + DELIVERY_DEADLINE, MAX_RESULT)
        if (not receiver._exact(value, ("version", "status", "targetId")) or
                type(value["version"]) is not int or value["version"] != 1 or
                value["targetId"] != receiver.TARGET_ID or value["status"] not in
                ("installed", "not_installed", "outcome_unknown", "cancelled", "expired")):
            _deny()
        return value
    except BaseException:
        return _result("outcome_unknown" if dispatched else "blocked")
    finally:
        with receiver._cleanup_signals():
            if connection is not None:
                connection.close()
            if directory is not None:
                directory.close()


def deliver(config_path=CONFIG_PATH, input_fd=0):
    client_started = False
    try:
        receiver._disable_core_dumps()
        with receiver._cancellation_scope():
            _configuration(config_path)
            data = _read_ciphertext(input_fd)
            client_started = True
            return _client(config_path, data)
    except BaseException:
        # Cancellation during cleanup may follow a committed receiver write.
        return _result("outcome_unknown" if client_started else "blocked")


def cancel(config_path=CONFIG_PATH):
    client_started = False
    try:
        receiver._disable_core_dumps()
        with receiver._cancellation_scope():
            client_started = True
            return _client(config_path, _encode({"version": 1, "action": "cancel"}))
    except BaseException:
        return _result("outcome_unknown" if client_started else "blocked")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("--serve", "--deliver", "--cancel"):
        result = _result("blocked")
    else:
        result = {"--serve": serve, "--deliver": deliver, "--cancel": cancel}[sys.argv[1]]()
    try:
        sys.stdout.write(_encode(result).decode("ascii"))
        sys.stdout.flush()
    except OSError:
        return 1
    return 0 if result["status"] in ("installed", "cancelled") else 2 if result["status"] == "blocked" else 1


if __name__ == "__main__":
    sys.exit(main())

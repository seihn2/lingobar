#!/usr/bin/env python3
"""Seal one explicitly entered DeepSeek key for a pinned one-shot receiver.

Only public challenge/profile files are read. The program never connects to a
network, starts a child process, reads a desktop store, or writes plaintext.
Its stdout is ciphertext for a separately authorized Azure-channel delivery.
The challenge digest must come from an independently trusted Azure read; a hash
computed from the same untrusted download does not authenticate a public key.
"""
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time


def _sibling(name):
    # These are fixed, reviewed bundle files, never caller-supplied module names.
    path = Path(__file__).with_name(name + ".py")
    spec = importlib.util.spec_from_file_location("lingobar_envelope_" + name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sender = _sibling("send")
CONFIG_PATH = Path(__file__).with_name("key-transfer-envelope.json")
MAX_OUTPUT_BYTES = 2048
MAX_ENVELOPE_KEY = 128


def validate_profile(value):
    sender.require(sender.exact(value, ["version", "enabled", "challengeFile", "challengeSha256"]))
    sender.require(type(value["version"]) is int and value["version"] == 1 and value["enabled"] is True)
    filename = value["challengeFile"]
    sender.require(isinstance(filename, str) and 0 < len(filename) <= 4096 and
                   os.path.isabs(filename) and os.path.normpath(filename) == filename and
                   os.path.realpath(filename) == filename and
                   not any(ord(char) < 32 or ord(char) == 127 for char in filename))
    digest = value["challengeSha256"]
    sender.require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest) is not None)
    return value


def load_profile():
    return validate_profile(sender.parse_json(sender.read_public_file(CONFIG_PATH, 4096)))


@sender.protected_entry
def run_seal(profile, key_reader=None, clock=None, crypto=None):
    """Return only a ciphertext envelope; refuse before prompting on bad pins.

    Cancellation and errors never cause a retry. Python and OS memory copies
    cannot be promised forensic zeroization; the process core guard is applied
    before key entry, and its mutable input buffer is cleared on every path.
    ``crypto`` and the readers are test injection points, not CLI options.
    """
    profile = validate_profile(profile)
    clock = clock or (lambda: int(time.time()))
    key_reader = key_reader or sender.read_hidden_key
    # Disabled profiles fail before importing a crypto dependency or opening a
    # challenge; default package verification can therefore be fully offline.
    crypto = crypto or _sibling("envelope_crypto")
    challenge = sender.parse_json(sender.read_public_file(profile["challengeFile"], 4096))
    sender.require(hmac.compare_digest(crypto.challenge_hash(challenge), profile["challengeSha256"]))
    crypto.validate_challenge(challenge, clock())
    key = None
    try:
        key = key_reader()
        sender.require(sender.valid_key(key) and len(key) <= MAX_ENVELOPE_KEY)
        # Time spent typing does not extend the receiver's fixed expiry.
        crypto.validate_challenge(challenge, clock())
        result = crypto.seal(challenge, key, clock())
        encoded = json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
        sender.require(len(encoded) <= MAX_OUTPUT_BYTES)
        return result
    finally:
        with sender.blocked_cancellation():
            if isinstance(key, bytearray):
                key[:] = b"\x00" * len(key)


def main():
    result = {"version": 1, "status": "blocked"}
    code = 2
    try:
        sender.disable_core_dumps()
        with sender.cancellation_scope():
            sender.require(len(sys.argv) == 1)
            result = run_seal(load_profile())
            code = 0
    except KeyboardInterrupt:
        result = {"version": 1, "status": "cancelled"}
    except BaseException:
        # No raw exception, challenge, plaintext or provider diagnostics.
        result = {"version": 1, "status": "blocked"}
    try:
        sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n")
        sys.stdout.flush()
    except (OSError, KeyboardInterrupt):
        return 2
    return code


if __name__ == "__main__":
    sys.exit(main())

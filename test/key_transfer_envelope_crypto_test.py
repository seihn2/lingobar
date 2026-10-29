"""Ephemeral dummy keys only; no network, credential store or user files."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/secure-key/envelope_crypto.py"
SPEC = importlib.util.spec_from_file_location("key_envelope_crypto_under_test", SCRIPT)
envelope = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(envelope)
NOW = 1793280000
SECRET = b"synthetic-dummy-only-not-a-real-key"


class CryptoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.private, cls.challenge = envelope.create_challenge(envelope.TARGET_ID, NOW)
        cls.other_private, cls.other_challenge = envelope.create_challenge(envelope.TARGET_ID, NOW)

    def rejected(self, operation):
        with self.assertRaises(envelope.EnvelopeError) as caught:
            operation()
        self.assertEqual(str(caught.exception), "Encrypted credential envelope unavailable")
        self.assertNotIn(SECRET.decode(), str(caught.exception))

    def raw(self, value, raw=None):
        data = raw if raw is not None else json.dumps(value, separators=(",", ":")).encode("ascii")
        ciphertext = self.private.public_key().encrypt(data, envelope._padding())
        return {"version": 1, "sessionId": self.challenge["sessionId"],
                "ciphertext": base64.b64encode(ciphertext).decode("ascii")}

    def content(self):
        return {"version": 1, "purpose": envelope.PURPOSE, "targetId": envelope.TARGET_ID,
                "sessionId": self.challenge["sessionId"],
                "expiresAt": self.challenge["expiresAt"], "apiKey": SECRET.decode()}

    def test_roundtrip_is_randomized_and_contains_no_plaintext(self):
        first = envelope.seal(self.challenge, SECRET, NOW)
        second = envelope.seal(self.challenge, bytearray(SECRET), NOW)
        self.assertNotEqual(first["ciphertext"], second["ciphertext"])
        self.assertEqual(envelope.unseal(self.private, self.challenge, first, NOW), bytearray(SECRET))
        self.assertIsInstance(envelope.unseal(self.private, self.challenge, second, NOW), bytearray)
        self.assertNotIn(SECRET.decode(), json.dumps(first))
        self.assertEqual(len(base64.b64decode(first["ciphertext"])), 512)
        self.assertEqual(set(first), {"version", "sessionId", "ciphertext"})

    def test_canonical_public_challenge_hash_and_no_private_material(self):
        data = envelope.challenge_bytes(self.challenge)
        self.assertTrue(data.endswith(b"\n"))
        self.assertEqual(hashlib.sha256(data).hexdigest(), envelope.challenge_hash(self.challenge))
        reversed_fields = dict(reversed(list(self.challenge.items())))
        self.assertEqual(data, envelope.challenge_bytes(reversed_fields))
        self.assertNotIn(b"PRIVATE", data)
        self.assertNotIn(SECRET, data)
        validated = envelope.validate_challenge(self.challenge, NOW)
        self.assertEqual(validated, self.challenge)
        self.assertIsNot(validated, self.challenge)

    def test_full_bound_fits_and_long_input_is_not_truncated(self):
        key = b"x" * 128
        value = envelope.seal(self.challenge, key, NOW)
        self.assertEqual(envelope.unseal(self.private, self.challenge, value, NOW), key)
        for key in (b"x" * 129, b"x" * 15, "x" * 32, b"x" * 16 + b"\n",
                    b" " * 32, b"\x7f" * 32, b"\xff" * 32, memoryview(SECRET)):
            with self.subTest(key_type=type(key).__name__, length=len(key)):
                self.rejected(lambda: envelope.seal(self.challenge, key, NOW))

    def test_expired_future_and_invalid_time_fail_closed(self):
        value = envelope.seal(self.challenge, SECRET, NOW)
        for now in (NOW - 1, NOW + 300, NOW + 301, True, 1.5, "now", -1):
            with self.subTest(now=now):
                self.rejected(lambda: envelope.validate_challenge(self.challenge, now))
                self.rejected(lambda: envelope.seal(self.challenge, SECRET, now))
                self.rejected(lambda: envelope.unseal(self.private, self.challenge, value, now))
        self.assertEqual(envelope.unseal(self.private, self.challenge, value, NOW + 299), SECRET)

    def test_create_challenge_fixed_target_ttl_and_integer_epoch(self):
        for target, now, ttl in (("other", NOW, 300), (envelope.TARGET_ID, NOW, 301),
                                  (envelope.TARGET_ID, NOW, True),
                                  (envelope.TARGET_ID, True, 300),
                                  (envelope.TARGET_ID, -1, 300),
                                  (envelope.TARGET_ID, 9007199254740991, 300)):
            self.rejected(lambda: envelope.create_challenge(target, now, ttl))
        self.assertNotEqual(self.challenge["sessionId"], self.other_challenge["sessionId"])
        self.assertNotEqual(self.challenge["publicKey"], self.other_challenge["publicKey"])

    def test_challenge_exact_shape_types_and_binding(self):
        mutations = [("version", True), ("version", 2), ("protocol", "RSA1_5"),
                     ("purpose", "other"), ("targetId", "other"), ("sessionId", "0" * 31),
                     ("sessionId", "A" * 32), ("createdAt", True), ("createdAt", NOW + 1),
                     ("expiresAt", NOW + 301), ("publicKey", "not-base64"),
                     ("publicKey", self.challenge["publicKey"] + "\n")]
        for field, value in mutations:
            altered = {**self.challenge, field: value}
            with self.subTest(field=field, value_type=type(value).__name__):
                self.rejected(lambda: envelope.validate_challenge(altered, NOW))
        for value in ({**self.challenge, "unknown": None}, {"version": 1}, [], None):
            self.rejected(lambda: envelope.validate_challenge(value, NOW))

    def test_reject_non_rsa_wrong_size_exponent_and_non_spki(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ed25519, rsa
        keys = [ed25519.Ed25519PrivateKey.generate().public_key(),
                rsa.generate_private_key(public_exponent=65537, key_size=2048).public_key(),
                rsa.generate_private_key(public_exponent=3, key_size=4096).public_key()]
        for key in keys:
            public = key.public_bytes(serialization.Encoding.DER,
                                      serialization.PublicFormat.SubjectPublicKeyInfo)
            changed = {**self.challenge, "publicKey": base64.b64encode(public).decode("ascii")}
            self.rejected(lambda: envelope.validate_challenge(changed, NOW))
        public = self.private.public_key().public_bytes(serialization.Encoding.DER,
                                                       serialization.PublicFormat.PKCS1)
        changed = {**self.challenge, "publicKey": base64.b64encode(public).decode("ascii")}
        self.rejected(lambda: envelope.validate_challenge(changed, NOW))

    def test_tamper_and_cross_key_cross_session_rejected(self):
        value = envelope.seal(self.challenge, SECRET, NOW)
        cipher = bytearray(base64.b64decode(value["ciphertext"]))
        cipher[len(cipher) // 2] ^= 1
        altered = {**value, "ciphertext": base64.b64encode(cipher).decode("ascii")}
        self.rejected(lambda: envelope.unseal(self.private, self.challenge, altered, NOW))
        self.rejected(lambda: envelope.unseal(self.other_private, self.challenge, value, NOW))
        self.rejected(lambda: envelope.unseal(self.other_private, self.other_challenge, value, NOW))
        changed = {**self.challenge, "sessionId": "0" * 32}
        rebound = {**value, "sessionId": "0" * 32}
        self.rejected(lambda: envelope.unseal(self.private, changed, rebound, NOW))

    def test_ciphertext_exact_shape_and_canonical_base64(self):
        value = envelope.seal(self.challenge, SECRET, NOW)
        for changed in ({**value, "version": True}, {**value, "unknown": None},
                        {**value, "sessionId": []}, {**value, "ciphertext": "A" * 2000},
                        {**value, "ciphertext": value["ciphertext"] + "\n"},
                        {**value, "ciphertext": base64.b64encode(b"x" * 511).decode()},
                        {**value, "ciphertext": {}}, {"version": 1}, [], None):
            self.rejected(lambda: envelope.unseal(self.private, self.challenge, changed, NOW))

    def test_decrypted_metadata_exact_shape_and_all_context_fields(self):
        mutations = [("version", True), ("purpose", "other"), ("targetId", "other"),
                     ("sessionId", "0" * 32), ("expiresAt", NOW + 299),
                     ("expiresAt", True), ("apiKey", {"nested": "x"}),
                     ("apiKey", "x" * 129), ("apiKey", "x" * 16 + "\n")]
        for field, item in mutations:
            changed = {**self.content(), field: item}
            value = self.raw(changed)
            self.rejected(lambda: envelope.unseal(self.private, self.challenge, value, NOW))
        for changed in ({**self.content(), "unknown": "x"}, {"version": 1}, [], None):
            value = self.raw(changed)
            self.rejected(lambda: envelope.unseal(self.private, self.challenge, value, NOW))

    def test_duplicate_keys_nonjson_nested_and_oversize_rejected(self):
        content = json.dumps(self.content(), separators=(",", ":"))
        duplicate = content[:-1] + ',"version":1}'
        for raw in (duplicate.encode(), b"not json", b"[[]]", b'{"apiKey":NaN}',
                    b"[" * 100 + b"0" + b"]" * 100):
            value = self.raw(None, raw)
            self.rejected(lambda: envelope.unseal(self.private, self.challenge, value, NOW))
        for data in (b"x" * 447, b"", bytearray(b"{}")):
            self.rejected(lambda: envelope._content(data))

    def test_dependency_version_exact_and_module_import_lazy(self):
        import cryptography
        with mock.patch.object(cryptography, "__version__", "49.0.0"):
            self.rejected(lambda: envelope.create_challenge(envelope.TARGET_ID, NOW))
            self.rejected(lambda: envelope.seal(self.challenge, SECRET, NOW))
        bootstrap = '''import builtins,runpy,sys
old=builtins.__import__
def importing(name,*a,**k):
 if name=="cryptography" or name.startswith("cryptography."): raise ImportError("unavailable")
 return old(name,*a,**k)
builtins.__import__=importing
data=runpy.run_path(sys.argv[1])
try: data["create_challenge"](data["TARGET_ID"],1793280000)
except data["EnvelopeError"]: sys.exit(0)
sys.exit(1)
'''
        result = subprocess.run([sys.executable, "-I", "-B", "-c", bootstrap, str(SCRIPT)],
                                capture_output=True, timeout=5, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()

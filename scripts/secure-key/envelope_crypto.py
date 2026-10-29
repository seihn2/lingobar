"""Single-message RSAES-OAEP envelope; no files, transport, keys or logging.

Uses the RFC8017 RSAES-OAEP scheme through the existing audited PyCA API;
there is no locally implemented cipher or hybrid key agreement. Callers must
establish their own process core/dump protection before generating/decrypting,
authenticate the public challenge independently, and consume sessions once.
This module does not authenticate senders and is deliberately stateless.
"""
import base64
import hashlib
import json
import re
import secrets

TARGET_ID = "lingobar-deepseek-primary"
PROTOCOL = "RSA-OAEP-SHA256-4096"
PURPOSE = "lingobar-deepseek-provision"
DEPENDENCY_VERSION = "50.0.0"
TTL = 300
MAX_KEY = 128
MAX_PLAINTEXT = 446  # 4096/8 - 2*SHA256.digest_size - 2; RFC8017 section7.1.
MAX_CHALLENGE_BYTES = 2048
MAX_ENVELOPE_BYTES = 1024
_CHALLENGE_KEYS = frozenset(("version", "protocol", "purpose", "targetId",
                             "sessionId", "createdAt", "expiresAt", "publicKey"))
_ENVELOPE_KEYS = frozenset(("version", "sessionId", "ciphertext"))
_CONTENT_KEYS = frozenset(("version", "purpose", "targetId", "sessionId",
                          "expiresAt", "apiKey"))


class EnvelopeError(Exception):
    """Never includes caller data, key material or raw crypto diagnostics."""


def _deny():
    raise EnvelopeError("Encrypted credential envelope unavailable")


def _require(value):
    if not value:
        _deny()


def _crypto():
    # Lazy imports keep the disabled entrypoint available without this package.
    try:
        import cryptography
        _require(cryptography.__version__ == DEPENDENCY_VERSION)
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding, rsa
        return hashes, serialization, padding, rsa
    except Exception:
        raise EnvelopeError("Encrypted credential envelope unavailable") from None


def _integer(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def _session(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{32}", value) is not None


def _encoded(value, maximum):
    # This only serializes validated shallow application shapes, never an
    # arbitrary nested caller value or an object-provided encoder.
    try:
        data = (json.dumps(value, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=True, allow_nan=False) + "\n").encode("ascii")
        _require(len(data) <= maximum)
        return data
    except Exception:
        raise EnvelopeError("Encrypted credential envelope unavailable") from None


def _base64(value, maximum):
    try:
        _require(isinstance(value, str) and 0 < len(value) <= maximum)
        data = base64.b64decode(value, validate=True)
        _require(base64.b64encode(data).decode("ascii") == value)
        return data
    except Exception:
        raise EnvelopeError("Encrypted credential envelope unavailable") from None


def _public_key(value):
    _, serialization, _, rsa = _crypto()
    try:
        data = _base64(value, 1024)
        key = serialization.load_der_public_key(data)
        _require(isinstance(key, rsa.RSAPublicKey) and key.key_size == 4096
                 and key.public_numbers().e == 65537)
        canonical = key.public_bytes(serialization.Encoding.DER,
                                     serialization.PublicFormat.SubjectPublicKeyInfo)
        _require(canonical == data)
        return key
    except Exception:
        raise EnvelopeError("Encrypted credential envelope unavailable") from None


def _challenge(value):
    _require(type(value) is dict and set(value) == _CHALLENGE_KEYS)
    _require(type(value["version"]) is int and value["version"] == 1
             and value["protocol"] == PROTOCOL and value["purpose"] == PURPOSE
             and value["targetId"] == TARGET_ID and _session(value["sessionId"])
             and _integer(value["createdAt"]) and _integer(value["expiresAt"])
             and value["expiresAt"] - value["createdAt"] == TTL)
    key = _public_key(value["publicKey"])
    _encoded(value, MAX_CHALLENGE_BYTES)
    return key


def validate_challenge(value, now):
    """Validate the fixed target, RSA parameters and exact300-second lifetime.

    Time is supplied by the owner; it must also enforce a monotonic deadline.
    Returned content is a new shallow dict with immutable scalar fields.
    """
    _challenge(value)
    _require(_integer(now) and value["createdAt"] <= now < value["expiresAt"])
    return dict(value)


def challenge_bytes(value):
    """Canonical public challenge bytes, including one trailing newline."""
    _challenge(value)
    return _encoded(value, MAX_CHALLENGE_BYTES)


def challenge_hash(value):
    return hashlib.sha256(challenge_bytes(value)).hexdigest()


def create_challenge(target_id, now, ttl=TTL):
    """Generate an ephemeral key object; never serializes its private part."""
    _require(target_id == TARGET_ID and _integer(now) and type(ttl) is int
             and ttl == TTL and _integer(now + TTL))
    _, serialization, _, rsa = _crypto()
    try:
        private = rsa.generate_private_key(public_exponent=65537, key_size=4096)
        public = private.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        challenge = {"version": 1, "protocol": PROTOCOL, "purpose": PURPOSE,
                     "targetId": TARGET_ID, "sessionId": secrets.token_hex(16),
                     "createdAt": now, "expiresAt": now + TTL,
                     "publicKey": base64.b64encode(public).decode("ascii")}
        validate_challenge(challenge, now)
        return private, challenge
    except Exception:
        raise EnvelopeError("Encrypted credential envelope unavailable") from None


def _key(value):
    _require(type(value) in (bytes, bytearray) and 16 <= len(value) <= MAX_KEY
             and all(33 <= number <= 126 for number in value))


def _padding():
    hashes, _, padding, _ = _crypto()
    return padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()),
                        algorithm=hashes.SHA256(), label=None)


def seal(challenge, key, now):
    """Encrypt a bounded key plus immutable purpose/target/session/expiry."""
    value = validate_challenge(challenge, now)
    _key(key)
    try:
        content = {"version": 1, "purpose": PURPOSE, "targetId": TARGET_ID,
                   "sessionId": value["sessionId"], "expiresAt": value["expiresAt"],
                   "apiKey": bytes(key).decode("ascii")}
        plaintext = _encoded(content, MAX_PLAINTEXT)
        ciphertext = _public_key(value["publicKey"]).encrypt(plaintext, _padding())
        _require(len(ciphertext) == 512)
        envelope = {"version": 1, "sessionId": value["sessionId"],
                    "ciphertext": base64.b64encode(ciphertext).decode("ascii")}
        _encoded(envelope, MAX_ENVELOPE_BYTES)
        return envelope
    except Exception:
        raise EnvelopeError("Encrypted credential envelope unavailable") from None


def _no_duplicates(pairs):
    value = {}
    for key, item in pairs:
        _require(key not in value)
        value[key] = item
    return value


def _content(data):
    try:
        _require(type(data) is bytes and 0 < len(data) <= MAX_PLAINTEXT)
        value = json.loads(data.decode("ascii", errors="strict"),
                           object_pairs_hook=_no_duplicates,
                           parse_constant=lambda _value: _deny())
        # Exact shallow fields exclude arrays/nesting and all extra fields.
        _require(type(value) is dict and set(value) == _CONTENT_KEYS)
        _require(type(value["version"]) is int and value["version"] == 1
                 and value["purpose"] == PURPOSE and value["targetId"] == TARGET_ID
                 and _session(value["sessionId"]) and _integer(value["expiresAt"])
                 and isinstance(value["apiKey"], str))
        key = value["apiKey"].encode("ascii", errors="strict")
        _key(key)
        return value, key
    except Exception:
        raise EnvelopeError("Encrypted credential envelope unavailable") from None


def unseal(private_key, challenge, envelope, now):
    """Return plaintext only in the protected owner process, never a child.

    The owner must burn the session before calling, including on errors; this
    function cannot itself enforce replay state or identify an authorized sender.
    """
    value = validate_challenge(challenge, now)
    _, serialization, _, rsa = _crypto()
    _require(type(envelope) is dict and set(envelope) == _ENVELOPE_KEYS
             and type(envelope["version"]) is int and envelope["version"] == 1
             and envelope["sessionId"] == value["sessionId"])
    try:
        _encoded(envelope, MAX_ENVELOPE_BYTES)
        _require(isinstance(private_key, rsa.RSAPrivateKey) and private_key.key_size == 4096)
        public = private_key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        _require(base64.b64encode(public).decode("ascii") == value["publicKey"])
        ciphertext = _base64(envelope["ciphertext"], 684)
        _require(len(ciphertext) == 512)
        content, key = _content(private_key.decrypt(ciphertext, _padding()))
        _require(content["sessionId"] == value["sessionId"]
                 and content["expiresAt"] == value["expiresAt"])
        return bytearray(key)
    except Exception:
        raise EnvelopeError("Encrypted credential envelope unavailable") from None

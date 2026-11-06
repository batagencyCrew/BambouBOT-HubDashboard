"""Password hashing, session tokens, and at-rest encryption for stored secrets."""

import base64
import hashlib
import hmac

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken

_hasher = PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=2)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored: str, password: str) -> bool:
    try:
        return _hasher.verify(stored, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def needs_rehash(stored: str) -> bool:
    try:
        return _hasher.check_needs_rehash(stored)
    except InvalidHashError:
        return True


class SecretBox:
    """Fernet encryption with a key derived from the hub secret key.

    Values are bound to a site id so a ciphertext copied between sites fails to
    open; this is defence in depth against operator/import mistakes.
    """

    def __init__(self, secret_key: bytes):
        derived = hashlib.sha256(b"hub-secretbox-v1:" + secret_key).digest()
        self._fernet = Fernet(base64.urlsafe_b64encode(derived))

    def seal(self, value: str, scope: str) -> str:
        if not value:
            return ""
        return self._fernet.encrypt(_bind(value.encode(), scope)).decode()

    def open(self, token: str, scope: str) -> str:
        if not token:
            return ""
        try:
            return _unbind(self._fernet.decrypt(token.encode()), scope).decode()
        except (InvalidToken, ValueError):
            raise ValueError("Stored secret cannot be decrypted with this HUB_SECRET_KEY") from None

    def fingerprint(self, value: str) -> str:
        """Stable non-reversible label so the UI can show which key is stored."""
        return hmac.new(b"fingerprint", value.encode(), hashlib.sha256).hexdigest()[:12]


def _bind(value: bytes, scope: str) -> bytes:
    tag = hashlib.sha256(b"scope:" + scope.encode()).digest()[:16]
    return tag + value


def _unbind(payload: bytes, scope: str) -> bytes:
    tag = hashlib.sha256(b"scope:" + scope.encode()).digest()[:16]
    if len(payload) < 16 or not hmac.compare_digest(payload[:16], tag):
        raise ValueError("Secret scope mismatch")
    return payload[16:]


def new_token(prefix: str = "") -> str:
    import secrets
    return prefix + secrets.token_urlsafe(32)

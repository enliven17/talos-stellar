from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


def _derive_key(password: str, salt: bytes, iterations: int = 200000) -> bytes:
    pw = password.encode("utf-8")
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=iterations,
    )
    return kdf.derive(pw)


def encrypt_with_password(plaintext: str, password: str) -> str:
    """Encrypt plaintext and return a base64 blob prefixed by ENC::"""
    salt = os.urandom(16)
    key = _derive_key(password, salt)
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
    ct = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
    blob = salt + nonce + ct
    return "ENC::" + base64.b64encode(blob).decode("utf-8")


def decrypt_with_password(blob_text: str, password: str) -> bytes:
    """Decrypt a blob produced by encrypt_with_password. Raises on failure.

    Returns the **byte-for-byte** plaintext (does NOT decode to string), so
    callers handling JSON or text payloads can `.decode("utf-8")` explicitly
    while binary payloads stay binary. Mirrors the
    `web/src/lib/backup-crypto.ts` `decryptWithPassword` API which returns
    a `Buffer`.

    Failure modes are translated into ``ValueError`` so callers have one
    exception type to handle:
        * "Not an encrypted blob" — missing ENC:: prefix.
        * "Invalid encrypted blob" — b64 too short to contain
          salt(16) + nonce(12) + tag(16).
        * "auth failed: ..." — GCM tag mismatch (wrong password,
          truncated blob, or tampered artifact).

    Wire format (matches Node ``aes-256-gcm`` with explicit ``setAuthTag``):
        salt(16) | nonce(12) | ciphertext(N) | gcm_tag(16)

    On the Python side ``AESGCM.decrypt`` accepts the concatenation of
    ciphertext+tag as a single ``data`` argument — the last 16 bytes are
    extracted as the authentication tag internally, so we pass them in
    that shape.
    """
    if not blob_text.startswith("ENC::"):
        raise ValueError("Not an encrypted blob")
    b = base64.b64decode(blob_text[len("ENC::"):])
    if len(b) < 16 + 12 + 16:
        raise ValueError("Invalid encrypted blob")
    salt = b[:16]
    nonce = b[16:28]
    ct_with_tag = b[28:]
    key = _derive_key(password, salt)
    aesgcm = AESGCM(key)
    try:
        return aesgcm.decrypt(nonce, ct_with_tag, None)
    except Exception as exc:  # cryptography.exceptions.InvalidTag is the
        # canonical class, but we don't want to depend on its full import
        # path staying stable.
        raise ValueError(f"auth failed: {exc}")


__all__ = ["encrypt_with_password", "decrypt_with_password"]

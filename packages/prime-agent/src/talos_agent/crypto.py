from __future__ import annotations

import base64
import os
from typing import Tuple

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


def decrypt_with_password(blob_text: str, password: str) -> str:
    """Decrypt a blob produced by encrypt_with_password. Raises on failure."""
    if not blob_text.startswith("ENC::"):
        raise ValueError("Not an encrypted blob")
    b = base64.b64decode(blob_text[len("ENC::"):])
    if len(b) < 16 + 12 + 16:
        raise ValueError("Invalid encrypted blob")
    salt = b[:16]
    nonce = b[16:28]
    ct = b[28:]
    key = _derive_key(password, salt)
    aesgcm = AESGCM(key)
    pt = aesgcm.decrypt(nonce, ct, None)
    return pt.decode("utf-8")


__all__ = ["encrypt_with_password", "decrypt_with_password"]

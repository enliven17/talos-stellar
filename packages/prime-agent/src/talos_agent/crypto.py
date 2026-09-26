from __future__ import annotations

import base64
import os
import struct
import time
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

# Constants for versioned envelope format
# Format: VERSION(1) | SALT(16) | NONCE(12) | CIPHERTEXT(N) | TAG(16)
# We use version 1 for the new envelope structure.
ENVELOPE_VERSION = 1
ENVELOPE_VERSION_SIZE = 1
SALT_SIZE = 16
NONCE_SIZE = 12
TAG_SIZE = 16
MIN_ENCRYPTED_SIZE = ENVELOPE_VERSION_SIZE + SALT_SIZE + NONCE_SIZE + TAG_SIZE
PREFIX = "ENC::"


def _derive_key(password: str, salt: bytes, iterations: int = 200000) -> bytes:
    pw = password.encode("utf-8")
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=iterations,
    )
    return kdf.derive(pw)


def encrypt_with_password(
    plaintext: str,
    password: str,
    version: int = ENVELOPE_VERSION,
) -> str:
    """Encrypt plaintext and return a base64 blob prefixed by ENC::

    The output format is versioned to allow future key rotation and algorithm
    upgrades without breaking existing data. The envelope structure is:
        version(1) | salt(16) | nonce(12) | ciphertext(N) | tag(16)

    Args:
        plaintext: The string to encrypt.
        password: The password to derive the encryption key.
        version: The envelope version to use (default 1).

    Returns:
        A base64-encoded string prefixed with "ENC::".
    """
    if version != ENVELOPE_VERSION:
        raise ValueError(f"Unsupported envelope version: {version}")

    salt = os.urandom(SALT_SIZE)
    key = _derive_key(password, salt)
    aesgcm = AESGCM(key)
    nonce = os.urandom(NONCE_SIZE)
    ct = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)

    # Construct the envelope: version + salt + nonce + ciphertext + tag
    # Note: AESGCM.encrypt returns ciphertext + tag concatenated.
    blob = struct.pack("!B", version) + salt + nonce + ct
    return PREFIX + base64.b64encode(blob).decode("utf-8")


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
          version(1) + salt(16) + nonce(12) + tag(16).
        * "Unsupported envelope version" — version byte not recognized.
        * "auth failed: ..." — GCM tag mismatch (wrong password,
          truncated blob, or tampered artifact).

    Wire format (matches Node ``aes-256-gcm`` with explicit ``setAuthTag``):
        version(1) | salt(16) | nonce(12) | ciphertext(N) | gcm_tag(16)

    On the Python side ``AESGCM.decrypt`` accepts the concatenation of
    ciphertext+tag as a single ``data`` argument — the last 16 bytes are
    extracted as the authentication tag internally, so we pass them in
    that shape.
    """
    if not blob_text.startswith(PREFIX):
        raise ValueError("Not an encrypted blob")

    try:
        b = base64.b64decode(blob_text[len(PREFIX):])
    except Exception:
        raise ValueError("Invalid encrypted blob")

    if len(b) < MIN_ENCRYPTED_SIZE:
        raise ValueError("Invalid encrypted blob")

    # Parse version
    version = struct.unpack("!B", b[0:1])[0]
    if version != ENVELOPE_VERSION:
        raise ValueError(f"Unsupported envelope version: {version}")

    # Parse salt and nonce
    salt = b[1:1 + SALT_SIZE]
    nonce = b[1 + SALT_SIZE : 1 + SALT_SIZE + NONCE_SIZE]
    ct_with_tag = b[1 + SALT_SIZE + NONCE_SIZE :]

    key = _derive_key(password, salt)
    aesgcm = AESGCM(key)

    try:
        return aesgcm.decrypt(nonce, ct_with_tag, None)
    except Exception as exc:
        # cryptography.exceptions.InvalidTag is the canonical class, but we
        # don't want to depend on its full import path staying stable.
        raise ValueError(f"auth failed: {exc}")


__all__ = ["encrypt_with_password", "decrypt_with_password"]
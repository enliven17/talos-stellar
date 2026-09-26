"""Checkpoint storage adapters and coordinator with verified publication.

Ensures that checkpoint payloads are encrypted, written to a storage backend,
retrieved and verified, and only then is the latest pointer advanced.
"""

from __future__ import annotations

import abc
import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Final

from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

from talos_agent.config import APP_DIR
from talos_agent.crypto import decrypt_with_password, encrypt_with_password

logger = logging.getLogger(__name__)

# Standard bounds and defaults
DEFAULT_MAX_SIZE_BYTES: Final[int] = 5 * 1024 * 1024  # 5 MB
DEFAULT_MAX_RETRIES: Final[int] = 3
DEFAULT_TIMEOUT_SECONDS: Final[float] = 10.0
DEFAULT_RETENTION_COUNT: Final[int] = 10

# Circuit breaker state key
CIRCUIT_BREAKER_STATE_KEY: Final[str] = "circuit_breaker_state.enc"


class StorageError(Exception):
    """Base class for all storage adapter and checkpointing exceptions."""

    pass


class StorageValidationError(StorageError):
    """Raised when validation (e.g., size bounds, keys, config) fails."""

    pass


class StorageVerificationError(StorageError):
    """Raised when read-back verification fails or detects corruption/stale data."""

    pass


class StorageProviderError(StorageError):
    """Raised when the underlying storage provider encounters a failure."""

    pass


class BaseStorageAdapter(abc.ABC):
    """Abstract base class for all storage adapters."""

    @abc.abstractmethod
    async def write(self, key: str, data: str) -> None:
        """Write opaque string data to the specified key.

        Args:
            key: The unique identifier/file name for the record.
            data: The ciphertext payload.

        Raises:
            StorageValidationError: If validation fails.
            StorageProviderError: If the provider fails to write.
        """
        pass

    @abc.abstractmethod
    async def read(self, key: str) -> str:
        """Read opaque string data from the specified key.

        Args:
            key: The unique identifier/file name for the record.

        Returns:
            The stored ciphertext payload.

        Raises:
            StorageValidationError: If validation fails.
            StorageProviderError: If the key is missing or the provider fails.
        """
        pass

    @abc.abstractmethod
    async def delete(self, key: str) -> None:
        """Delete the record at the specified key.

        Args:
            key: The unique identifier/file name to delete.

        Raises:
            StorageValidationError: If validation fails.
            StorageProviderError: If deletion fails.
        """
        pass

    @abc.abstractmethod
    async def list_keys(self) -> list[str]:
        """List all keys stored in the adapter.

        Returns:
            A list of all keys.

        Raises:
            StorageProviderError: If the listing operation fails.
        """
        pass


class LocalStorageAdapter(BaseStorageAdapter):
    """A concrete storage adapter that stores checkpoints as files in a local directory."""

    def __init__(self, base_dir: Path | str | None = None) -> None:
        """Initialize the LocalStorageAdapter.

        Args:
            base_dir: Directory where checkpoints are stored. Defaults to APP_DIR/checkpoints.
        """
        if base_dir is None:
            self.base_dir = APP_DIR / "checkpoints"
        else:
            self.base_dir = Path(base_dir)

        # Explicit directory authorization/write checking
        try:
            self.base_dir.mkdir(parents=True, exist_ok=True)
            # Test write/delete to verify authorization and I/O capability
            test_file = self.base_dir / ".write_probe"
            test_file.write_text("probe", encoding="utf-8")
            test_file.unlink()
        except Exception as e:
            raise StorageProviderError(
                f"Failed to initialize or authorize local storage at {self.base_dir}: {e}"
            ) from e

    def _resolve_and_verify_path(self, key: str) -> Path:
        """Resolve the path for the key and protect against directory traversal."""
        if not key:
            raise StorageValidationError("Storage key cannot be empty")

        # Basic character whitelist validation to avoid path separators
        if "/" in key or "\\" in key or ".." in key:
            raise StorageValidationError(
                f"Invalid key format: '{key}'. Path traversal components are forbidden."
            )

        resolved_path = (self.base_dir / key).resolve()
        resolved_base = self.base_dir.resolve()

        if (
            resolved_base not in resolved_path.parents
            and resolved_path != resolved_base
        ):
            raise StorageValidationError(
                f"Directory traversal detected: key '{key}' resolved outside base directory '{resolved_base}'"
            )
        return resolved_path

    async def write(self, key: str, data: str) -> None:
        path = self._resolve_and_verify_path(key)
        try:
            # Run in executor to prevent blocking the async loop
            await asyncio.to_thread(path.write_text, data, encoding="utf-8")
        except Exception as e:
            raise StorageProviderError(
                f"Local storage write failed for key '{key}': {e}"
            ) from e

    async def read(self, key: str) -> str:
        path = self._resolve_and_verify_path(key)
        if not path.exists():
            raise StorageProviderError(f"Key '{key}' not found in local storage")
        try:
            return await asyncio.to_thread(path.read_text, encoding="utf-8")
        except Exception as e:
            raise StorageProviderError(
                f"Local storage read failed for key '{key}': {e}"
            ) from e

    async def delete(self, key: str) -> None:
        path = self._resolve_and_verify_path(key)
        if not path.exists():
            return
        try:
            await asyncio.to_thread(path.unlink)
        except Exception as e:
            raise StorageProviderError(
                f"Local storage delete failed for key '{key}': {e}"
            ) from e

    async def list_keys(self) -> list[str]:
        try:
            # Exclude directories and probe files
            def list_dir():
                return [
                    f.name
                    for f in self.base_dir.iterdir()
                    if f.is_file() and not f.name.startswith(".")
                ]

            return await asyncio.to_thread(list_dir)
        except Exception as e:
            raise StorageProviderError(
                f"Local storage directory listing failed: {e}"
            ) from e


class MemoryStorageAdapter(BaseStorageAdapter):
    """In-memory storage adapter, heavily used for mocking and test simulations."""

    def __init__(self) -> None:
        self.store_dict: dict[str, str] = {}
        # Simulation hooks for testing
        self.write_hook_failure: Exception | None = None
        self.read_hook_failure: Exception | None = None
        self.delete_hook_failure: Exception | None = None
        self.list_hook_failure: Exception | None = None
        self.read_stale_data: str | None = None

    async def write(self, key: str, data: str) -> None:
        if self.write_hook_failure:
            raise self.write_hook_failure
        if not key:
            raise StorageValidationError("Key cannot be empty")
        self.store_dict[key] = data

    async def read(self, key: str) -> str:
        if self.read_hook_failure:
            raise self.read_hook_failure
        if self.read_stale_data is not None:
            return self.read_stale_data
        if key not in self.store_dict:
            raise StorageProviderError(f"Key '{key}' not found in memory store")
        return self.store_dict[key]

    async def delete(self, key: str) -> None:
        if self.delete_hook_failure:
            raise self.delete_hook_failure
        if key in self.store_dict:
            del self.store_dict[key]

    async def list_keys(self) -> list[str]:
        if self.list_hook_failure:
            raise self.list_hook_failure
        return list(self.store_dict.keys())


class VerifiedCheckpointStorage:
    """Coordinator that handles validation, encryption, retries, verification, and retention."""

    def __init__(
        self,
        adapter: BaseStorageAdapter,
        encryption_password: str,
        *,
        max_size_bytes: int = DEFAULT_MAX_SIZE_BYTES,
        max_retries: int = DEFAULT_MAX_RETRIES,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        retention_count: int = DEFAULT_RETENTION_COUNT,
    ) -> None:
        """Initialize the VerifiedCheckpointStorage.

        Args:
            adapter: Concrete implementation of BaseStorageAdapter.
            encryption_password: Secret password used for AESGCM encryption.
            max_size_bytes: Maximum size of the plaintext payload (default 5MB).
            max_retries: Maximum tenacity retry attempts on transient failures.
            timeout_seconds: Timeout for each I/O call.
            retention_count: Keep only the newest N checkpoints.
        """
        if not encryption_password or not encryption_password.strip():
            raise StorageValidationError("Encryption password cannot be empty or blank")

        self.adapter = adapter
        self.encryption_password = encryption_password
        self.max_size_bytes = max_size_bytes
        self.max_retries = max_retries
        self.timeout_seconds = timeout_seconds
        self.retention_count = retention_count

    def _retry_policy(self) -> AsyncRetrying:
        """Get the tenacity retry policy for transient provider failures."""
        return AsyncRetrying(
            stop=stop_after_attempt(self.max_retries),
            wait=wait_exponential_jitter(initial=0.2, max=self.timeout_seconds / 2.0),
            retry=retry_if_exception_type((StorageProviderError, asyncio.TimeoutError)),
            reraise=True,
        )

    async def save_checkpoint(self, checkpoint_id: str, data: str) -> str:
        """Encrypt, write, read-back, verify, and advance pointer for a checkpoint.

        Args:
            checkpoint_id: Unique label, e.g. "checkpoint_2026-07-25_1". Should match format.
            data: Plaintext data payload (opaque string).

        Returns:
            The generated storage key where the checkpoint is stored.

        Raises:
            StorageValidationError: On size limit or key validation failure.
            StorageVerificationError: If read-back verification fails.
            StorageProviderError: If the storage backend fails after retries.
        """
        # 1. Validation
        if not checkpoint_id:
            raise StorageValidationError("checkpoint_id must not be empty")

        # Explicit size bounds checking
        data_bytes = data.encode("utf-8")
        if len(data_bytes) > self.max_size_bytes:
            raise StorageValidationError(
                f"Payload size ({len(data_bytes)} bytes) exceeds max limit ({self.max_size_bytes} bytes)"
            )

        # 2. Encrypt plaintext payload
        try:
            ciphertext = encrypt_with_password(data, self.encryption_password)
        except Exception as e:
            raise StorageValidationError(f"Failed to encrypt payload: {e}") from e

        key = f"{checkpoint_id}.enc"

        # 3. Write payload (with retries and timeouts)
        async def do_write() -> None:
            await asyncio.wait_for(
                self.adapter.write(key, ciphertext),
                timeout=self.timeout_seconds,
            )

        try:
            async for attempt in self._retry_policy():
                with attempt:
                    await do_write()
        except Exception as e:
            raise StorageProviderError(
                f"Failed to write checkpoint key '{key}' after retries: {e}"
            ) from e

        # 4. Read-back verification
        try:
            async for attempt in self._retry_policy():
                with attempt:
                    read_back = await asyncio.wait_for(
                        self.adapter.read(key),
                        timeout=self.timeout_seconds,
                    )
        except Exception as e:
            raise StorageProviderError(
                f"Failed to read back checkpoint key '{key}' for verification: {e}"
            ) from e

        if read_back != ciphertext:
            raise StorageVerificationError(
                f"Read-back verification failed for key '{key}'. Data mismatch detected."
            )

        # 5. Retention cleanup
        await self._cleanup_old_checkpoints()

        return key

    async def _cleanup_old_checkpoints(self) -> None:
        """Remove old checkpoints to maintain retention count."""
        try:
            keys = await self.adapter.list_keys()
            # Filter for checkpoint keys (ending in .enc)
            checkpoint_keys = [k for k in keys if k.endswith(".enc")]
            
            if len(checkpoint_keys) > self.retention_count:
                # Sort by key name (assumes sortable timestamp format) and delete oldest
                checkpoint_keys.sort()
                keys_to_delete = checkpoint_keys[: len(checkpoint_keys) - self.retention_count]
                
                for old_key in keys_to_delete:
                    try:
                        await self.adapter.delete(old_key)
                    except Exception as e:
                        logger.warning(
                            f"Failed to delete old checkpoint {old_key}: {e}"
                        )
        except Exception as e:
            logger.warning(f"Failed to perform checkpoint retention cleanup: {e}")

    async def load_checkpoint(self, checkpoint_id: str) -> str:
        """Retrieve and decrypt a specific checkpoint.

        Args:
            checkpoint_id: The unique label of the checkpoint to retrieve.

        Returns:
            The decrypted plaintext data.

        Raises:
            StorageValidationError: If validation fails.
            StorageProviderError: If the key is missing or provider fails.
            StorageVerificationError: If decryption fails or data is corrupted.
        """
        if not checkpoint_id:
            raise StorageValidationError("checkpoint_id must not be empty")

        key = f"{checkpoint_id}.enc"
        
        try:
            ciphertext = await asyncio.wait_for(
                self.adapter.read(key),
                timeout=self.timeout_seconds,
            )
        except StorageProviderError:
            raise
        except Exception as e:
            raise StorageProviderError(
                f"Failed to read checkpoint key '{key}': {e}"
            ) from e

        try:
            plaintext = decrypt_with_password(ciphertext, self.encryption_password)
        except Exception as e:
            raise StorageVerificationError(
                f"Failed to decrypt checkpoint key '{key}': {e}"
            ) from e

        return plaintext

    async def save_circuit_breaker_state(self, state: dict[str, Any]) -> None:
        """Persist circuit-breaker state across restarts.

        Args:
            state: The circuit breaker state dictionary to persist.

        Raises:
            StorageValidationError: If state is invalid or too large.
            StorageProviderError: If storage fails.
        """
        if not isinstance(state, dict):
            raise StorageValidationError("Circuit breaker state must be a dictionary")

        try:
            data = json.dumps(state)
        except Exception as e:
            raise StorageValidationError(f"Failed to serialize circuit breaker state: {e}") from e

        # Reuse existing encryption and storage mechanism
        await self.save_checkpoint("circuit_breaker", data)

    async def load_circuit_breaker_state(self) -> dict[str, Any]:
        """Load persisted circuit-breaker state.

        Returns:
            The decrypted circuit breaker state dictionary, or empty dict if not found.

        Raises:
            StorageVerificationError: If decryption fails or data is corrupted.
        """
        try:
            data = await self.load_checkpoint("circuit_breaker")
            return json.loads(data)
        except StorageProviderError:
            # State not found is not an error, return default empty state
            return {}
        except StorageVerificationError:
            raise
        except Exception as e:
            raise StorageVerificationError(
                f"Failed to load circuit breaker state: {e}"
            ) from e

    async def delete_circuit_breaker_state(self) -> None:
        """Delete persisted circuit-breaker state."""
        try:
            await self.adapter.delete(CIRCUIT_BREAKER_STATE_KEY)
        except StorageProviderError:
            # If it doesn't exist, that's fine
            pass

    async def clear_all(self) -> None:
        """Clear all stored checkpoints and circuit breaker state."""
        keys = await self.adapter.list_keys()
        for key in keys:
            try:
                await self.adapter.delete(key)
            except Exception as e:
                logger.warning(f"Failed to delete key {key} during clear: {e}")
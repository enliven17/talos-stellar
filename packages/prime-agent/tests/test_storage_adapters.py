from pathlib import Path
import pytest
from unittest.mock import patch

from talos_agent.adapters.storage import (
    LocalStorageAdapter,
    MemoryStorageAdapter,
    VerifiedCheckpointStorage,
    StorageValidationError,
    StorageVerificationError,
    StorageProviderError,
)

# Use a secure password for the tests
TEST_PASSWORD = "test-secret-password-12345"


@pytest.fixture
def temp_base_dir(tmp_path) -> Path:
    return tmp_path / "checkpoints_test"


@pytest.mark.asyncio
async def test_local_storage_adapter_lifecycle(temp_base_dir):
    # 1. Initialization and directory creation
    adapter = LocalStorageAdapter(base_dir=temp_base_dir)
    assert temp_base_dir.exists()

    # 2. Write and read
    key = "checkpoint_1.enc"
    test_data = "encrypted_ciphertext_data"
    await adapter.write(key, test_data)

    read_data = await adapter.read(key)
    assert read_data == test_data

    # 3. List keys
    keys = await adapter.list_keys()
    assert key in keys

    # 4. Delete
    await adapter.delete(key)
    keys_after_delete = await adapter.list_keys()
    assert key not in keys_after_delete

    # 5. Missing key handling
    with pytest.raises(StorageProviderError, match="not found"):
        await adapter.read("non_existent.enc")


@pytest.mark.asyncio
async def test_local_storage_adapter_traversal_guards(temp_base_dir):
    adapter = LocalStorageAdapter(base_dir=temp_base_dir)

    # Path traversal with relative parent segments
    with pytest.raises(StorageValidationError, match="Invalid key format"):
        await adapter.write("../outside.enc", "data")

    # Path traversal with nested slashes or backslashes
    with pytest.raises(StorageValidationError, match="Invalid key format"):
        await adapter.write("subfolder/file.enc", "data")

    with pytest.raises(StorageValidationError, match="Invalid key format"):
        await adapter.write("subfolder\\file.enc", "data")

    # Empty key check
    with pytest.raises(StorageValidationError, match="cannot be empty"):
        await adapter.write("", "data")


@pytest.mark.asyncio
async def test_verified_checkpoint_storage_success_path(temp_base_dir):
    adapter = LocalStorageAdapter(base_dir=temp_base_dir)
    storage = VerifiedCheckpointStorage(
        adapter=adapter,
        encryption_password=TEST_PASSWORD,
        retention_count=3,
    )

    # Save checkpoint 1
    chk_id_1 = "checkpoint_2026-07-25_001"
    chk_data_1 = '{"state": "first_checkpoint_state", "balance": 100}'
    key1 = await storage.save_checkpoint(chk_id_1, chk_data_1)
    assert key1 == f"{chk_id_1}.enc"

    # Verify latest pointer is updated
    pointer_val = await adapter.read("latest.ptr")
    assert pointer_val == key1

    # Verify we can retrieve latest
    latest_key, decrypted_data = await storage.get_latest_checkpoint()
    assert latest_key == key1
    assert decrypted_data == chk_data_1

    # Save checkpoint 2
    chk_id_2 = "checkpoint_2026-07-25_002"
    chk_data_2 = '{"state": "second_checkpoint_state", "balance": 150}'
    key2 = await storage.save_checkpoint(chk_id_2, chk_data_2)
    assert key2 == f"{chk_id_2}.enc"

    pointer_val = await adapter.read("latest.ptr")
    assert pointer_val == key2

    latest_key, decrypted_data = await storage.get_latest_checkpoint()
    assert latest_key == key2
    assert decrypted_data == chk_data_2


@pytest.mark.asyncio
async def test_verified_checkpoint_storage_size_bounds():
    adapter = MemoryStorageAdapter()
    # Bound to small size
    storage = VerifiedCheckpointStorage(
        adapter=adapter,
        encryption_password=TEST_PASSWORD,
        max_size_bytes=10,
    )

    # 10 bytes or fewer is fine
    await storage.save_checkpoint("chk_1", "12345")

    # Exceeds 10 bytes
    with pytest.raises(StorageValidationError, match="exceeds max limit"):
        await storage.save_checkpoint("chk_2", "12345678901")


@pytest.mark.asyncio
async def test_verified_checkpoint_storage_interrupted_upload():
    adapter = MemoryStorageAdapter()
    storage = VerifiedCheckpointStorage(
        adapter=adapter,
        encryption_password=TEST_PASSWORD,
        max_retries=2,
    )

    # Induce persistent write failure
    adapter.write_hook_failure = StorageProviderError("Network connection interrupted")

    with pytest.raises(StorageProviderError, match="Failed to write"):
        await storage.save_checkpoint("chk_1", "some_data")

    # Ensure no pointer was advanced or set
    assert "latest.ptr" not in adapter.store_dict


@pytest.mark.asyncio
async def test_verified_checkpoint_storage_stale_reads():
    adapter = MemoryStorageAdapter()
    storage = VerifiedCheckpointStorage(
        adapter=adapter,
        encryption_password=TEST_PASSWORD,
        max_retries=1,
    )

    # Read back returns stale data (different from what was just written)
    adapter.read_stale_data = "ENC::stale_ciphertext_mismatch"

    with pytest.raises(
        StorageVerificationError,
        match="retrieved ciphertext does not match written ciphertext",
    ):
        await storage.save_checkpoint("chk_1", "some_data")

    # Pointer should NOT be advanced
    assert "latest.ptr" not in adapter.store_dict


@pytest.mark.asyncio
async def test_verified_checkpoint_storage_corruption():
    adapter = MemoryStorageAdapter()
    storage = VerifiedCheckpointStorage(
        adapter=adapter,
        encryption_password=TEST_PASSWORD,
        max_retries=1,
    )

    # Save a valid checkpoint first to get encrypted form, but we'll return modified base64 content
    # We simulate read returning a slightly corrupted version that passes the exact match check,
    # but fails decryption MAC or structure verification.
    # Note: verify checks ciphertext equality first, so to test decryption failure we must mock
    # the read-back to pass the string matching check (e.g. read_stale_data matches ciphertext)
    # but fail decryption. Let's make read-back return matching text but mock the decrypt_with_password to fail.
    with patch("talos_agent.adapters.storage.decrypt_with_password") as mock_decrypt:
        mock_decrypt.side_effect = ValueError("AESGCM decryption failed")

        with pytest.raises(StorageVerificationError, match="decryption failed"):
            await storage.save_checkpoint("chk_1", "some_data")

        # Pointer should NOT be advanced
        assert "latest.ptr" not in adapter.store_dict


@pytest.mark.asyncio
async def test_verified_checkpoint_storage_provider_failure_with_retry():
    adapter = MemoryStorageAdapter()
    storage = VerifiedCheckpointStorage(
        adapter=adapter,
        encryption_password=TEST_PASSWORD,
        max_retries=3,
    )

    # Simulate a transient failure on write: fail the first two attempts, succeed on the third
    fail_count = 0

    async def transient_write(key, data):
        nonlocal fail_count
        if fail_count < 2:
            fail_count += 1
            raise StorageProviderError("Transient database lock error")
        adapter.store_dict[key] = data

    adapter.write = transient_write

    # Save should eventually succeed
    key = await storage.save_checkpoint("chk_1", "some_important_data")
    assert key == "chk_1.enc"
    assert fail_count == 2
    assert await adapter.read("latest.ptr") == "chk_1.enc"


@pytest.mark.asyncio
async def test_verified_checkpoint_storage_retention_enforcement():
    adapter = MemoryStorageAdapter()
    storage = VerifiedCheckpointStorage(
        adapter=adapter,
        encryption_password=TEST_PASSWORD,
        retention_count=3,
    )

    # Write 5 checkpoints
    for i in range(1, 6):
        await storage.save_checkpoint(f"checkpoint_{i}", f"data_{i}")

    # Memory store keys
    keys = await adapter.list_keys()

    # The latest pointer should be active
    assert "latest.ptr" in keys
    latest_val = await adapter.read("latest.ptr")
    assert latest_val == "checkpoint_5.enc"

    # Only retention_count (3) checkpoints + latest.ptr should exist in the store
    checkpoint_enc_keys = [k for k in keys if k.endswith(".enc")]
    assert len(checkpoint_enc_keys) == 3

    # Checkpoints 1 and 2 should have been deleted (oldest)
    assert "checkpoint_1.enc" not in checkpoint_enc_keys
    assert "checkpoint_2.enc" not in checkpoint_enc_keys

    # Checkpoints 3, 4, 5 should remain
    assert "checkpoint_3.enc" in checkpoint_enc_keys
    assert "checkpoint_4.enc" in checkpoint_enc_keys
    assert "checkpoint_5.enc" in checkpoint_enc_keys


@pytest.mark.asyncio
async def test_get_latest_checkpoint_not_found():
    adapter = MemoryStorageAdapter()
    storage = VerifiedCheckpointStorage(
        adapter=adapter, encryption_password=TEST_PASSWORD
    )

    # With no checkpoint saved, get_latest_checkpoint returns None
    result = await storage.get_latest_checkpoint()
    assert result is None


@pytest.mark.asyncio
async def test_get_latest_checkpoint_corruption():
    adapter = MemoryStorageAdapter()
    storage = VerifiedCheckpointStorage(
        adapter=adapter, encryption_password=TEST_PASSWORD
    )

    # Save a valid checkpoint
    await storage.save_checkpoint("chk_1", "my_data")

    # Manually corrupt the checkpoint ciphertext in the backend
    adapter.store_dict["chk_1.enc"] = "ENC::invalid_or_corrupted_blob_data"

    # get_latest_checkpoint should raise verification error due to decryption failure
    with pytest.raises(
        StorageVerificationError, match="Failed to decrypt latest checkpoint"
    ):
        await storage.get_latest_checkpoint()

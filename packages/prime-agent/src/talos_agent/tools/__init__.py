import asyncio
import logging
import time
from collections import namedtuple

logger = logging.getLogger(__name__)

DEFAULT_TOOL_TIMEOUT_SECONDS = 30.0
MAX_TOOL_TIMEOUT_SECONDS = 300.0

ToolTimeoutResult = namedtuple('ToolTimeoutResult', ['timeout', 'elapsed', 'timed_out'])


def _validate_timeout(timeout):
    """Validate timeout parameter for tool execution.
    
    Ensures timeout is a valid numeric value within acceptable bounds.
    Raises ValueError for invalid inputs.
    """
    if isinstance(timeout, bool):
        raise ValueError("timeout must be a number, not a boolean")
    if not isinstance(timeout, (int, float)):
        raise ValueError(f"timeout must be a number, got {type(timeout).__name__}")
    if not (0 < timeout <= MAX_TOOL_TIMEOUT_SECONDS):
        raise ValueError(f"timeout must be between 0 and {MAX_TOOL_TIMEOUT_SECONDS}, got {timeout}")


async def execute_with_timeout(coro, timeout=DEFAULT_TOOL_TIMEOUT_SECONDS):
    """Execute a coroutine with a specified timeout.
    
    Args:
        coro: The coroutine to execute.
        timeout: Timeout in seconds. Must be a positive number <= MAX_TOOL_TIMEOUT_SECONDS.
        
    Returns:
        The result of the coroutine, or ToolTimeoutResult if timed out.
        
    Raises:
        ValueError: If timeout is invalid.
        asyncio.CancelledError: If the task is cancelled.
        Exception: If the coroutine raises an exception.
    """
    _validate_timeout(timeout)
    
    start = time.monotonic()
    try:
        res = await asyncio.wait_for(coro, timeout)
    except asyncio.TimeoutError:
        elapsed = time.monotonic() - start
        logger.warning("tool execution timed out after %.3fs", elapsed)
        return ToolTimeoutResult(timeout=timeout, elapsed=elapsed, timed_out=True)
    except asyncio.CancelledError:
        logger.debug("tool execution cancelled")
        raise
    except Exception:
        logger.debug("tool execution error")
        raise
    else:
        logger.debug("tool execution succeeded")
        return res
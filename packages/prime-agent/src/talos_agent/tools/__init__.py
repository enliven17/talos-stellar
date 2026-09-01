import asyncio
import logging
import time
from collections import namedtuple

logger = logging.getLogger(__name__)

DEFAULT_TOOL_TIMEOUT_SECONDS = 30.0
MAX_TOOL_TIMEOUT_SECONDS = 300.0

ToolTimeoutResult = namedtuple('ToolTimeoutResult', ['timeout', 'elapsed', 'timed_out'])


async def execute_with_timeout(coro, timeout=DEFAULT_TOOL_TIMEOUT_SECONDS):
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise ValueError("timeout must be a number")
    if not (0 < timeout <= MAX_TOOL_TIMEOUT_SECONDS):
        raise ValueError("timeout out of range")
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

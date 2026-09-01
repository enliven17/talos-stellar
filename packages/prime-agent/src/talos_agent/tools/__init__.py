import asyncio, os, time, logging
logger = logging.getLogger(__name__)

async def execute_with_timeout(coro, timeout=30.0):
    if not (0 < timeout <= 300.0):
        raise ValueError
    start = time.monotonic()
    try:
        res = await asyncio.wait_for(coro, timeout)
    except asyncio.TimeoutError:
        logger.debug("timeout %.3f", time.monotonic() - start)
        return None
    except asyncio.CancelledError:
        logger.debug("cancelled %.3f", time.monotonic() - start)
        raise
    except Exception:
        logger.debug("error %.3f", time.monotonic() - start)
        raise
    else:
        logger.debug("success %.3f", time.monotonic() - start)
        return res
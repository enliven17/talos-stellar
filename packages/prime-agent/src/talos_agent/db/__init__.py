"""talos_agent.db — database package.

Re-exports the flat LocalDB for backwards compatibility and exposes the
higher-level DbFacade for new callers.
"""

from talos_agent.db.facade import DbFacade
from talos_agent.db.facade import RedactedStateExport

__all__ = ["DbFacade", "RedactedStateExport"]

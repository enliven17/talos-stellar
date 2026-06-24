def ensure_session(self):
        """Checks if the session is alive and attempts auto-recovery."""
        if self.session is None or not self.is_connected():
            if self.retry_count >= self.MAX_RETRIES:
                logger.error("Max browser restart attempts reached. Agent marked as DEGRADED.")
                return False
            
            logger.warning(f"Browser disconnected. Attempting reconnection ({self.retry_count + 1}/{self.MAX_RETRIES})...")
            self.start()
            self.retry_count += 1
        else:
            # Reset retry count if connection is healthy
            self.retry_count = 0
        return True

    def is_connected(self):
        """Placeholder for actual socket/browser health check."""
        return True
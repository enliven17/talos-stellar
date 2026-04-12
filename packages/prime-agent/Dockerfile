# ─── Talos Prime Agent — Railway Docker Image ─────────────────────────────────
# Python + Node.js + Chromium for headless browser automation via Stagehand.
# Sets BROWSER_HEADLESS=true by default for server environments.

FROM python:3.11-slim

# ── System dependencies ────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    gnupg2 \
    ca-certificates \
    # Chromium + dependencies
    chromium \
    fonts-freefont-ttf \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 (required for Stagehand SEA server) ────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── uv (fast Python package manager) ──────────────────────────────────────────
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# ── Playwright Chromium (keyboard fallback) ────────────────────────────────────
# Tell Playwright to use the system Chromium installed above
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage"

WORKDIR /app

# ── Install Python dependencies (layer-cached) ────────────────────────────────
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# ── Copy source ────────────────────────────────────────────────────────────────
COPY src/ ./src/

# ── Runtime environment ────────────────────────────────────────────────────────
ENV PYTHONUNBUFFERED=1
# Headless is required in Railway (no display server)
ENV BROWSER_HEADLESS=true
# Stagehand: local mode with headless Chromium
ENV STAGEHAND_HEADLESS=true

# ── Healthcheck — verify agent can import cleanly ─────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD uv run python -c "from talos_agent.config import Settings; Settings()" || exit 1

CMD ["uv", "run", "talos-agent", "start"]

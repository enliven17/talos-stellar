FROM mcr.microsoft.com/devcontainers/base:ubuntu-22.04

ARG NODE_VERSION=20
ARG PYTHON_VERSION=3.11
ARG STELLAR_CLI_VERSION=21.4.0

ENV DEBIAN_FRONTEND=noninteractive
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:/usr/local/bin:$PATH

# System packages: build tools, Python 3.11 (deadsnakes), and utilities.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      software-properties-common \
      ca-certificates \
      curl \
      git \
      build-essential \
      pkg-config \
      libssl-dev \
      unzip \
 && add-apt-repository -y ppa:deadsnakes/ppa \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      python3.11 \
      python3.11-venv \
      python3.11-dev \
 && rm -rf /var/lib/apt/lists/* \
 && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
 && ln -sf /usr/bin/python3.11 /usr/local/bin/python \
 && python3.11 -m ensurepip --upgrade || true

# Node.js 20 via the official Debian package repository (apt, no piped scripts).
RUN mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_${NODE_VERSION}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@9 \
 && pnpm --version

# Rust stable with wasm32 target, installed via rustup binary downloaded to a
# file, checksum-verified against a pinned SHA-256, and only then executed.
RUN set -eux; \
    RUSTUP_INIT_URL=https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init; \
    RUSTUP_INIT_SHA256=4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10; \
    curl -fsSL "$RUSTUP_INIT_URL" -o /tmp/rustup-init; \
    echo "${RUSTUP_INIT_SHA256}  /tmp/rustup-init" | sha256sum -c -; \
    chmod +x /tmp/rustup-init; \
    /tmp/rustup-init -y --profile minimal --default-toolchain stable --no-modify-path; \
    rm -f /tmp/rustup-init; \
    rustup target add wasm32-unknown-unknown; \
    rustup component add rustfmt clippy; \
    chmod -R a+w ${RUSTUP_HOME} ${CARGO_HOME}

# stellar-cli installed from crates.io with cargo (no remote script execution).
RUN cargo install --locked stellar-cli --version ${STELLAR_CLI_VERSION}

WORKDIR /workspaces

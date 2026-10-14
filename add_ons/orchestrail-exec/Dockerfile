# orchestrail-exec - sandboxed bash/filesystem tool server
#
# Ubuntu base so agents have a real shell with python3 + node + pip + npm, and
# can `pip install` / `npm install` at runtime (cached via the mounted volumes).
# The server itself is dependency-free (node: builtins only), so there is no npm
# install step for the server and no third-party supply chain inside the
# privileged exec container.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Core runtimes + iptables for the egress lockdown in the entrypoint.
# nodejs from NodeSource for a current LTS (Ubuntu's default node is old).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg \
        python3 python3-pip python3-venv \
        build-essential \
        iptables sudo \
        git zip \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY server.mjs /srv/server.mjs
COPY entrypoint.sh /srv/entrypoint.sh
RUN chmod +x /srv/entrypoint.sh

# Workbench (per-run scratch) and dependency caches are bind/volume mounted.
RUN mkdir -p /workbench /cache/pip /cache/npm
ENV WORKBENCH_ROOT=/workbench \
    EXEC_PORT=8766 \
    PIP_CACHE_DIR=/cache/pip \
    npm_config_cache=/cache/npm

EXPOSE 8766

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s \
  CMD curl -fsS http://localhost:8766/health || exit 1

# entrypoint applies iptables egress rules (needs NET_ADMIN) then drops into node.
ENTRYPOINT ["/srv/entrypoint.sh"]

# orchestrail-exec - sandboxed bash/filesystem tool server
#
# A general-purpose workstation for the agent team: the same kinds of tools an
# operator reaches for (data analysis, documents, conversions, multiple
# languages), so agents can finish real work before escalating to a human or
# a frontier model.
#
# The server itself is dependency-free (node: builtins only). Everything else
# here is tooling for the agents' bash tool. The egress lockdown in the
# entrypoint is unchanged: no LAN, public internet allowed for installs.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# -- System tooling, document/media converters, extra languages ---------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg \
        iptables sudo \
        git zip unzip xz-utils bzip2 file tree less \
        jq sqlite3 ripgrep shellcheck bc \
        build-essential pkg-config cmake \
        python3 python3-dev python3-venv \
        poppler-utils qpdf ghostscript imagemagick ffmpeg pandoc \
        libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
        fonts-dejavu fonts-liberation fonts-noto-core \
        default-jdk-headless \
        golang-go \
        rustc cargo \
    && rm -rf /var/lib/apt/lists/*

# -- Node 20 LTS + global JS/TS tooling ---------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-fund --no-audit typescript tsx eslint prettier \
    && npm cache clean --force

# -- Python: a real virtualenv so `pip install` works at runtime --------------
# Ubuntu 24.04 marks the system interpreter externally-managed (PEP 668), which
# made every agent pip install fail. The venv is first on PATH, so python3 /
# pip / pytest all resolve to it.
ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH
COPY sandbox-requirements.txt /tmp/sandbox-requirements.txt
RUN python3 -m venv /opt/venv \
    && pip install --no-cache-dir --upgrade pip setuptools wheel \
    && pip install --no-cache-dir -r /tmp/sandbox-requirements.txt \
    && rm /tmp/sandbox-requirements.txt

# ImageMagick ships with PDF/PS reads disabled; agents legitimately convert
# PDFs to images, and the container is the security boundary.
RUN for f in /etc/ImageMagick-6/policy.xml /etc/ImageMagick-7/policy.xml; do \
        [ -f "$f" ] && sed -i 's/rights="none" pattern="\(PDF\|PS\|EPS\|XPS\)"/rights="read|write" pattern="\1"/' "$f" || true; \
    done

WORKDIR /srv
COPY server.mjs /srv/server.mjs
COPY entrypoint.sh /srv/entrypoint.sh
RUN chmod +x /srv/entrypoint.sh

# Workbench (per-run scratch) and dependency caches are bind/volume mounted.
RUN mkdir -p /workbench /cache/pip /cache/npm
ENV WORKBENCH_ROOT=/workbench \
    EXEC_PORT=8766 \
    PIP_CACHE_DIR=/cache/pip \
    npm_config_cache=/cache/npm \
    GOPATH=/cache/go \
    CARGO_HOME=/cache/cargo \
    MPLBACKEND=Agg

EXPOSE 8766

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s \
  CMD curl -fsS http://localhost:8766/health || exit 1

# entrypoint applies iptables egress rules (needs NET_ADMIN) then drops into node.
ENTRYPOINT ["/srv/entrypoint.sh"]

#!/usr/bin/env bash
# build.sh -- Build the code-exec-tools wrapper image, pull Piston, and
#             bundle both into a single tar for offline/air-gapped deployment.
#
# Usage:
#   ./build.sh
#
# The output is code-exec-tools-bundle.tar in this directory.
# Transfer it to the target host and load with:
#   docker load -i code-exec-tools-bundle.tar
#   docker compose up -d

set -euo pipefail

WRAPPER_IMAGE="code-exec-tools"
PISTON_IMAGE="ghcr.io/engineer-man/piston"
TAR_NAME="code-exec-tools-bundle.tar"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Preflight
echo "==> Checking required files in ${SCRIPT_DIR}..."
MISSING=0
for f in Dockerfile docker-compose.yml code_exec_tool_server.py install_packages.sh; do
    if [[ ! -f "${SCRIPT_DIR}/${f}" ]]; then
        echo "  MISSING: ${f}"
        MISSING=1
    else
        echo "  OK: ${f}"
    fi
done
[[ "${MISSING}" -ne 0 ]] && { echo ""; echo "ERROR: Missing files. Aborting."; exit 1; }

# 2. Build the wrapper image
echo ""
echo "==> Building ${WRAPPER_IMAGE}:latest..."
docker build \
    --platform linux/amd64 \
    --tag "${WRAPPER_IMAGE}:latest" \
    "${SCRIPT_DIR}"

# 3. Pull Piston
echo ""
echo "==> Pulling ${PISTON_IMAGE}..."
docker pull --platform linux/amd64 "${PISTON_IMAGE}"

# 4. Save both images to one tar
echo ""
echo "==> Saving images to ${SCRIPT_DIR}/${TAR_NAME}..."
docker save \
    "${WRAPPER_IMAGE}:latest" \
    "${PISTON_IMAGE}" \
    -o "${SCRIPT_DIR}/${TAR_NAME}"

TAR_SIZE=$(du -sh "${SCRIPT_DIR}/${TAR_NAME}" | cut -f1)
echo "    Size: ${TAR_SIZE}"

cat <<EOF

Build complete!

To deploy on an air-gapped or remote host:

  [Step 1]  Copy files to the target host:
              scp ${SCRIPT_DIR}/${TAR_NAME} user@host:/your/deploy/dir/
              scp ${SCRIPT_DIR}/docker-compose.yml user@host:/your/deploy/dir/
              scp ${SCRIPT_DIR}/install_packages.sh user@host:/your/deploy/dir/

  [Step 2]  On the target host, load images:
              docker load -i /your/deploy/dir/${TAR_NAME}

  [Step 3]  Start containers:
              cd /your/deploy/dir && docker compose up -d

  [Step 4]  Install language runtimes (first time only -- takes a few minutes):
              bash /your/deploy/dir/install_packages.sh

  Tool server available at: http://localhost:8765
EOF

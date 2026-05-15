#!/usr/bin/env bash
# install_packages.sh - Install language runtimes into a running Piston instance.
#
# Run this ONCE on TrueNAS after first deploy.
# Runtimes are stored in the persistent volume and survive container restarts.
# Re-run any time you want to add a language.
#
# Usage:
#   sudo bash install_packages.sh
#
# Against a remote Piston (requires port 2000 exposed on the host):
#   PISTON_URL=http://192.168.1.100:2000 bash install_packages.sh
set -euo pipefail

PISTON_URL="${PISTON_URL:-http://localhost:2000}"

# Language name -> version to install.
# Names must match Piston's package registry exactly.
# Run this to see all available packages:
#   curl -s http://localhost:2000/api/v2/packages | python3 -c "
#     import json,sys; pkgs=json.load(sys.stdin)
#     print('\n'.join(sorted(set(p['language'] for p in pkgs))))"
declare -A PACKAGES=(
    [bash]=5.2.0
    [gcc]=10.2.0        # C and C++
    [go]=1.16.2
    [java]=15.0.2
    [lua]=5.4.4
    [perl]=5.36.0
    [php]=8.2.3
    [python]=3.9.4
    [ruby]=3.0.1
    [rust]=1.68.2
    [swift]=5.3.3
    [typescript]=5.0.3  # includes Node.js/TypeScript
    [node]=20.11.1      # plain JavaScript
    [rscript]=4.1.1     # R
    [deno]=1.32.3
    [kotlin]=1.8.20
    [dart]=3.0.1
    [haskell]=9.0.1
    [julia]=1.8.5
    [zig]=0.10.1
)

# Wait for Piston to be ready
echo "==> Waiting for Piston at ${PISTON_URL}..."
for i in $(seq 1 30); do
    if curl -sf "${PISTON_URL}/api/v2/runtimes" >/dev/null 2>&1; then
        echo "    Piston is ready."
        break
    fi
    [[ $i -eq 30 ]] && { echo "ERROR: Piston not responding after 60s."; exit 1; }
    echo "    Waiting... (${i}/30)"
    sleep 2
done

# Install each package
echo ""
echo "==> Installing language runtimes..."
for lang in "${!PACKAGES[@]}"; do
    ver="${PACKAGES[$lang]}"
    printf "  %-16s %s ... " "$lang" "$ver"
    RESP=$(curl -sf -X POST "${PISTON_URL}/api/v2/packages" \
        -H "Content-Type: application/json" \
        -d "{\"language\":\"${lang}\",\"version\":\"${ver}\"}" 2>&1) || RESP=""
    if echo "${RESP}" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if 'language' in d else 1)" 2>/dev/null; then
        echo "OK"
    else
        echo "SKIP (already installed or unavailable)"
    fi
done

# Print installed runtimes
echo ""
echo "==> Installed runtimes:"
curl -sf "${PISTON_URL}/api/v2/runtimes" | python3 -c "
import json, sys
rts = json.load(sys.stdin)
for r in sorted(rts, key=lambda x: x['language']):
    aliases = ', '.join(r.get('aliases', []))
    alias_str = '  [' + aliases + ']' if aliases else ''
    print('  {:<16} {}{}'.format(r['language'], r['version'], alias_str))
"
echo ""
echo "Done. Runtimes are persisted in the Docker volume and will survive restarts."
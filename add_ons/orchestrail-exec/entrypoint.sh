#!/usr/bin/env bash
# orchestrail-exec entrypoint
#
# Applies an egress lockdown (drop RFC-1918, keep the internet for pip/npm) and
# then starts the dependency-free node server. Requires cap NET_ADMIN; if that
# capability is absent the iptables calls fail -- by default we HARD FAIL so a
# misconfigured container does not silently run agent code with full LAN reach.
# Set EXEC_ALLOW_LAN=1 to intentionally skip the lockdown (e.g. air-gapped host
# where the Docker network is already `internal: true`).

set -euo pipefail

apply_egress_lockdown() {
  # Allow loopback and already-established/related return traffic.
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  # Allow DNS (needed to resolve pypi.org / registry.npmjs.org).
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
  # Drop all private ranges: the agent must never reach the LAN / other services.
  iptables -A OUTPUT -d 10.0.0.0/8     -j DROP
  iptables -A OUTPUT -d 172.16.0.0/12  -j DROP
  iptables -A OUTPUT -d 192.168.0.0/16 -j DROP
  iptables -A OUTPUT -d 169.254.0.0/16 -j DROP
  iptables -A OUTPUT -d 127.0.0.0/8 ! -o lo -j DROP
  # Everything else (public internet) is allowed so runtime installs work.
}

if [ "${EXEC_ALLOW_LAN:-0}" = "1" ]; then
  echo "[entrypoint] EXEC_ALLOW_LAN=1 set -- skipping iptables egress lockdown"
else
  if apply_egress_lockdown; then
    echo "[entrypoint] egress lockdown applied (RFC-1918 dropped, internet allowed)"
  else
    echo "[entrypoint] FATAL: failed to apply iptables rules (need cap_add: NET_ADMIN)." >&2
    echo "[entrypoint] Refusing to run agent code with unrestricted LAN egress." >&2
    echo "[entrypoint] Fix: add 'cap_add: [NET_ADMIN]' to the service, or set EXEC_ALLOW_LAN=1 on an already-isolated network." >&2
    exit 1
  fi
fi

exec node /srv/server.mjs

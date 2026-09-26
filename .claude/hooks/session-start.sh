#!/bin/bash
#
# SessionStart hook for Claude Code on the web.
#
# Gets a fresh remote session to the point where `pnpm test`, `pnpm lint` and
# `docker compose build` all work without anyone having to set them up by hand.
#
set -euo pipefail

# Local sessions already have a working checkout and whatever Docker the developer
# chose to run; this is only for the ephemeral remote containers.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# --- Dependencies -----------------------------------------------------------
# The lockfile is committed, so a frozen install is both faster and honest: if it
# cannot be satisfied, that is a real problem worth failing on.
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

# --- Docker -----------------------------------------------------------------
# The image build is part of CI and worth being able to reproduce locally. Docker is
# installed in these containers but no daemon is running, so start one.
#
# The registry mirror is not optional here. This environment's network policy allows
# Docker Hub's API (registry-1.docker.io, auth.docker.io) but blocks the CDN its blobs
# come from, production.cloudfront.docker.com, so an unmirrored pull authenticates and
# then dies with a 403. mirror.gcr.io serves the same images and is reachable.
#
# Docker never being available is inconvenient, not fatal — tests and linters do not
# need it — so this never fails the session.
start_docker_daemon() {
  command -v dockerd >/dev/null 2>&1 || { echo "dockerd not installed; skipping"; return 0; }
  if docker info >/dev/null 2>&1; then
    echo "docker: daemon already running"
    return 0
  fi

  echo "docker: starting daemon with mirror https://mirror.gcr.io"
  nohup dockerd --registry-mirror=https://mirror.gcr.io >/tmp/dockerd.log 2>&1 &

  for _ in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      echo "docker: daemon ready"
      return 0
    fi
    sleep 1
  done

  echo "docker: daemon did not come up within 30s; see /tmp/dockerd.log" >&2
  return 0
}

start_docker_daemon || true

# Builds that reach the network need these: containers cannot use the host's proxy
# unless they share its network, and this sandbox intercepts TLS, so Node has to be
# told about the interception CA. See /root/.ccr/README.md.
if [ -f /root/.ccr/ca-bundle.crt ]; then
  echo "export CCR_CA_BUNDLE=/root/.ccr/ca-bundle.crt" >> "${CLAUDE_ENV_FILE:-/dev/null}"
fi

echo "session-start: ready"

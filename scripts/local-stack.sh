#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

case "${1:-up}" in
  up)
    docker compose up -d postgres mock-stellar web
    echo ""
    echo "Local stack is starting."
    echo "- Web: http://localhost:3000"
    echo "- Health: http://localhost:3000/api/health"
    echo "- Mock Stellar: http://localhost:4010/health"
    echo ""
    echo "Use 'docker compose --profile agent up -d prime-agent' to add the agent profile."
    ;;
  down)
    docker compose down --remove-orphans
    ;;
  logs)
    docker compose logs -f --tail=200
    ;;
  reset)
    docker compose down -v --remove-orphans
    docker compose up -d postgres mock-stellar web
    ;;
  reset-data)
    # Truncate (and optionally re-seed) local test data without recreating the
    # stack volumes. Delegates to the package script, which owns every safety
    # check and refuses anything that is not a loopback database.
    shift
    # Command substitution instead of a pipe: pipefail + an early-exiting reader
    # could kill the producer and be misread as "not running".
    if [[ -z "$(docker compose ps -q postgres 2>/dev/null)" ]]; then
      echo "local-stack: the postgres service is not running." >&2
      echo "Start it first with: pnpm stack:up" >&2
      echo "Use 'pnpm stack:reset' only if you want to destroy and recreate the stack volumes." >&2
      exit 1
    fi
    cmd=(pnpm --dir web run db:reset-test-data)
    if [[ $# -gt 0 ]]; then
      cmd+=(-- "$@")
    fi
    DATABASE_URL="${TALOS_RESET_DATABASE_URL:-${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/talos}}" "${cmd[@]}"
    ;;
  *)
    echo "Usage: $0 {up|down|logs|reset|reset-data}" >&2
    exit 1
    ;;
esac

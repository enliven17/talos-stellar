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
  *)
    echo "Usage: $0 {up|down|logs|reset}" >&2
    exit 1
    ;;
esac

#!/usr/bin/env bash
# start.sh — Start all OB1 local services
# Copy .env.example to .env and edit before running.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env not found. Copy .env.example to .env and configure it first." >&2
  exit 1
fi

# Load env
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

LOG_DIR="${SCRIPT_DIR}/logs"
mkdir -p "$LOG_DIR"

DENO_PERMS="--allow-net --allow-env --allow-read"

start_service() {
  local name="$1"
  local entry="$2"
  local port="$3"
  local log="${LOG_DIR}/${name}.log"

  echo "Starting ${name} on :${port} ..."
  PORT="$port" deno run $DENO_PERMS "$entry" >> "$log" 2>&1 &
  echo $! > "${LOG_DIR}/${name}.pid"
  echo "  PID $(cat "${LOG_DIR}/${name}.pid") → ${log}"
}

start_service "core"               "${SCRIPT_DIR}/server/index.ts"                           "${CORE_PORT:-3000}"
start_service "household-knowledge" "${SCRIPT_DIR}/extensions/household-knowledge/index.ts"  "${HOUSEHOLD_PORT:-3001}"
start_service "home-maintenance"   "${SCRIPT_DIR}/extensions/home-maintenance/index.ts"      "${HOME_MAINTENANCE_PORT:-3002}"
start_service "family-calendar"    "${SCRIPT_DIR}/extensions/family-calendar/index.ts"       "${FAMILY_CALENDAR_PORT:-3003}"
start_service "meal-planning"      "${SCRIPT_DIR}/extensions/meal-planning/index.ts"         "${MEAL_PLANNING_PORT:-3004}"
start_service "professional-crm"   "${SCRIPT_DIR}/extensions/professional-crm/index.ts"      "${PROFESSIONAL_CRM_PORT:-3005}"
start_service "job-hunt"           "${SCRIPT_DIR}/extensions/job-hunt/index.ts"              "${JOB_HUNT_PORT:-3006}"

echo ""
echo "All services started. PIDs stored in ${LOG_DIR}/*.pid"
echo "Logs: ${LOG_DIR}/"

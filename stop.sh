#!/usr/bin/env bash
# stop.sh — Stop all OB1 local services
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${SCRIPT_DIR}/logs"

SERVICES=(
  core
  household-knowledge
  home-maintenance
  family-calendar
  meal-planning
  professional-crm
  job-hunt
)

for name in "${SERVICES[@]}"; do
  pid_file="${LOG_DIR}/${name}.pid"
  if [[ -f "$pid_file" ]]; then
    pid=$(cat "$pid_file")
    if kill -0 "$pid" 2>/dev/null; then
      echo "Stopping ${name} (PID ${pid}) ..."
      kill "$pid"
    else
      echo "${name} (PID ${pid}) not running."
    fi
    rm -f "$pid_file"
  else
    echo "${name}: no PID file found."
  fi
done

echo "Done."

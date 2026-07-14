#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

if [ -z "${BOT_TOKEN:-}" ]; then
  echo "BOT_TOKEN не задан. Добавьте его в .env или Environment Variables."
  exit 1
fi

curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook"
echo ""
echo "Webhook удалён. Теперь можно запускать локальный polling через start-local.command."

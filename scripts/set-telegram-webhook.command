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

DOMAIN="${1:-${MINI_APP_URL:-}}"
if [ -z "$DOMAIN" ]; then
  echo "Укажите домен: scripts/set-telegram-webhook.command https://your-vercel-domain.vercel.app"
  exit 1
fi

WEBHOOK_URL="${DOMAIN%/}/api/telegram/webhook"

if [ -n "${TELEGRAM_WEBHOOK_SECRET:-}" ]; then
  curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" -d "url=$WEBHOOK_URL" -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
else
  curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" -d "url=$WEBHOOK_URL"
fi

echo ""
echo "Webhook установлен: $WEBHOOK_URL"

#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
fi

echo "Настройка Telegram-бота WB Финбот"
echo
echo "Вставь BOT_TOKEN из BotFather. Ввод будет скрыт."
read -rs "bot_token?BOT_TOKEN: "
echo

if [ -z "$bot_token" ]; then
  echo "Токен пустой. Ничего не изменено."
  exit 1
fi

tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

found_token=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    BOT_TOKEN=*)
      printf 'BOT_TOKEN="%s"\n' "$bot_token" >> "$tmp_file"
      found_token=1
      ;;
    *)
      printf '%s\n' "$line" >> "$tmp_file"
      ;;
  esac
done < .env

if [ "$found_token" -eq 0 ]; then
  printf 'BOT_TOKEN="%s"\n' "$bot_token" >> "$tmp_file"
fi

mv "$tmp_file" .env
trap - EXIT

echo
echo "Готово. BOT_TOKEN записан в .env."
echo "Теперь запусти scripts/start-local.command и напиши /start своему боту в Telegram."
echo
read "reply?Нажми Enter, чтобы закрыть окно."

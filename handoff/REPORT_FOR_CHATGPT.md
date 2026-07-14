# WB Финбот MVP — handoff после production-аудита

Дата: 2026-07-14

## Обновление расчётов по реальному отчёту WB

По детализированному Excel-отчёту `772198476` подтверждены и исправлены три причины
расхождения: возвраты считались положительными продажами, общие удержания с `nmId=0`
терялись, а строки без количества могли ошибочно увеличивать число продаж. Новый smoke-test
сверяет продажи `950 646,72`, перечисление за товар `832 550,66`, расходы WB `293 337,02`
и итог к оплате `539 213,64` рубля.

В отчёт добавлены себестоимость продаж, операционные расходы, выбираемый режим налога,
прибыль до налога, чистая прибыль, маржинальность и ROI. Настройка налога хранится на том же
Telegram account, что WB-токен и отчёты. Миграция `20260714010000_tax_settings` только добавляет
поле `taxMode` с безопасным значением `none` и не удаляет существующие данные.

## Итоговый статус

Код исправлен и локально проверен, но **не объявляется готовым к production**. Новые изменения не деплоились, PostgreSQL migration не применялась к Neon, а реальный Telegram Mini App сценарий с живым `initData`, BotFather menu button и WB-токеном не был доступен в этой сессии.

## Подтверждённые причины

### Mini App `Failed to fetch`

Причина подтверждена на живом deployment `https://wb-finbot-mvp.vercel.app`:

- `GET /api/health` вернул `200`.
- `GET /api/account` без `X-Telegram-Init-Data` вернул `401`.
- `OPTIONS /api/account` вернул `204` и разрешил `X-Telegram-Init-Data`.
- production `index.html` ссылался на `/assets/index-D2yF3aA1.js`.
- этот реально отданный asset содержал строку `http://localhost:3000`.

Следовательно, Mini App отправлял API-запросы в localhost устройства вместо Vercel. Запрос не доходил до backend и frontend показывал системный `Failed to fetch`; это не было состоянием «WB-токен не подключён».

Текущий Vercel log query за последние 24 часа вернул `No logs found`, поэтому реальные `telegramUserId`, `accountId` и статус WB upstream во время старого инцидента из логов восстановить нельзя.

### Второй отчёт подряд

Причина повторных запросов подтверждена кодом и изолированным WB stub:

- прежний `GET /api/reports` всегда вызывал `syncWbReportList()` при валидном токене;
- прежние `getReportRowsByPeriod()` и `getReportRowsById()` могли сделать до десяти detailed-запросов за один invocation;
- успешный finance import ожидал `updateProductCards()`, поэтому ошибка Content API могла сломать открытие отчёта.

Точный production upstream HTTP status второго инцидента не доказан: Vercel не сохранил доступных warning/error логов. Новый safety smoke воспроизвёл указанный путь с `429` и показал сохранение уже загруженных данных вместо общей ошибки.

## Что исправлено

- Production frontend принудительно использует относительные `/api/...`; `.env.example` оставляет `VITE_API_BASE_URL=` пустым.
- `vite.config.ts` падает с понятной ошибкой, если production process environment содержит `localhost` или `127.0.0.1` в `VITE_API_BASE_URL`.
- Локальный Vite proxy по-прежнему использует `VITE_API_BASE_URL` или `http://localhost:3000` только в development.
- Telegram script перенесён в `<head>` перед Vite module script.
- `/api/health` возвращает `version` и `builtAt`; Settings показывает версию frontend.
- Frontend сначала проверяет `/api/health`, затем `/api/account`, различает network, Telegram auth, WB not connected, invalid token, rate limit и server error. Системный текст `Failed to fetch` пользователю не показывается.
- Finance `/ping` — единственная обязательная проверка токена. Content `/ping` стал optional warning; detailed reports не вызываются при сохранении токена.
- Content enrichment отделён от finance import в `POST /api/reports/:id/enrich-products`; ошибка Content сохраняется как `failed_optional` и не удаляет finance report.
- Добавлены `WbAccount.reportsSyncedAt`, `WbAccount.reportsSyncError`, report sync/content metadata и `WbSyncState` для DB-backed lock/cooldown.
- `GET /api/reports` использует базу в течение 65 секунд. `429` с уже сохранёнными отчётами возвращает сохранённый список и cooldown notice.
- Detailed endpoint делает один запрос до 100 000 строк. При полной странице отчёт получает `partial`, `lastRrdId` и честное MVP-сообщение; автоматического второго detailed-запроса нет.
- `POST /api/reports/:id/refresh` уважает detail cooldown и возвращает сохранённый report с сообщением вместо новой WB sync.
- Обработчик ошибок маппит Zod `400`, Telegram auth `401`, ownership `404`, WB `401/402/403/429/502/503`; неизвестный production error получает безопасный текст и `requestId`.
- В backend request log есть request ID, route, Telegram/account ID, HTTP status, duration и result code. WB token и initData не логируются.
- Bot и Mini App используют общий `getOrCreateTelegramAccount()` и ID `telegram-${telegramUserId}`. Local smoke подтвердил два разных account и запрет доступа к чужим report/product/expense.
- Добавлен безопасный одноразовый `scripts/migrate-demo-account.ts`: dry-run по умолчанию, явный target Telegram ID, `--apply --confirm`, без полного токена и без автоматического переноса demo data.
- Добавлен camelCase fixture и normalizer smoke; snake_case coverage сохранено.

## Rate-limit защита

Для `accountId + endpointType` создаётся запись `WbSyncState`:

- endpoint types: `sales-reports-list`, `sales-reports-detailed`, `content-cards`;
- `lockedAt` предотвращает второй одновременный запрос и снимает зависший lock по TTL;
- `cooldownUntil` и `lastSuccessAt` дают 65-секундное окно;
- `lastErrorCode`/`retryAfterSeconds` сохраняют состояние `429`;
- `reportsSyncedAt` защищает повторное открытие Mini App;
- уже сохранённые rows не удаляются на `429`.

## Finance-only и Content

Для MVP обязательны `Финансы` + `Только чтение`. Content optional. Finance-only token сохраняется с предупреждением:

`Финансы подключены, но нет доступа к карточкам товаров. Названия и изображения могут не загрузиться.`

При недоступности Content finance summary остаётся доступен с `vendorCode` и `nmId`. Повторить enrichment можно обновлением после cooldown. Analytics в инструкциях больше не требуется.

## Отчёты больше 100 000 строк

Первая версия MVP получает строго одну detailed page. Если page достигла 100 000 строк, report отмечается `partial`, сохраняется `lastRrdId`, а UI получает честное сообщение о лимите MVP. Никакого `sleep(60 секунд)` и никакой ложной полной загрузки нет. Incremental continuation для следующих страниц намеренно оставлен отдельной будущей задачей.

## Production environment

Нужно установить:

- `BOT_TOKEN`
- PostgreSQL `DATABASE_URL`
- стабильный `ENCRYPTION_SECRET` минимум 32 символа
- `NODE_ENV=production`
- `MINI_APP_URL` и `PUBLIC_API_URL` актуального единого Vercel domain
- `TELEGRAM_WEBHOOK_SECRET` минимум 16 символов
- `USE_DEMO_DATA=false`
- WB Finance/Content base URLs при необходимости override

Не устанавливать `VITE_API_BASE_URL` в Vercel. Для local development можно оставить его только в `.env.local`.

## Оставшиеся ограничения и required acceptance

- Нужен deploy нового frontend/backend и `pnpm db:migrate:deploy` для PostgreSQL migration `20260711090000_sync_protection`.
- Нужно проверить BotFather menu button, `MINI_APP_URL`, `PUBLIC_API_URL`, webhook и отсутствие Telegram cache старого frontend.
- Нужен реальный двусторонний test: token через bot → Mini App Settings; token через Mini App → `/status`; повторное открытие Mini App.
- Нужен реальный screen recording: token в bot, Mini App видит token, первый/второй report, повторное открытие первого report из базы.
- Нужно вручную проверить WB account, для которого list/details fallback работает by period; при period fallback current code сохраняет все строки первой страницы, разбитые по `reportId`.
- Exact production second-report upstream status не восстановлен, так как Vercel logs были пусты.

Смотрите полный фактический вывод команд и stub-scenarios в `handoff/TEST_RESULTS.md`.

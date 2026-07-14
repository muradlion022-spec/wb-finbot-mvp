# WB Финбот MVP — handoff после production-аудита

Дата: 2026-07-14

## Обновление расчётов по реальному отчёту WB

По детализированному Excel-отчёту `772198476` подтверждены и исправлены три причины
расхождения: возвраты считались положительными продажами, общие удержания с `nmId=0`
терялись, а строки без количества могли ошибочно увеличивать число продаж. Новый smoke-test
сверяет продажи `950 646,72`, перечисление за товар `832 550,66`, комиссию WB
`118 096,06`, сервисные расходы WB `293 337,02` и итог к оплате `539 213,64` рубля.
Комиссия считается как разница между продажами и перечислением за товар; расходы WB
содержат логистику, хранение, приёмку, штрафы и прочие удержания.

В отчёт добавлены себестоимость продаж, операционные расходы, выбираемый режим налога,
прибыль до налога, чистая прибыль, маржинальность и ROI. Настройка налога хранится на том же
Telegram account, что WB-токен и отчёты. Миграция `20260714010000_tax_settings` только добавляет
поле `taxMode` с безопасным значением `none` и не удаляет существующие данные.

## Итоговый статус

**DEPLOYED — READY FOR MANUAL ACCEPTANCE.** Актуальная версия развёрнута в существующий Vercel
project `wb-finbot-mvp` на `https://wb-finbot-mvp.vercel.app`. Production health сообщает
версию `485d65f1c23f`; Prisma подключился к существующей Neon PostgreSQL и подтвердил, что
все четыре migration применены. Telegram webhook указывает на текущий production domain,
очередь обновлений пуста, последней ошибки нет.

Через валидную серверно подписанную Telegram initData подтверждены общий account
`telegram-<telegramUserId>`, сохранённый WB token со статусом `valid` и 26 отчётов.
Отчёт `772198476` возвращает сверенные суммы, а следующий отчёт `777875626` успешно
открылся и повторно прочитался из сохранённого состояния. GitHub `main` синхронизирован
обычным fast-forward commit `485d65f`, а его автоматический Vercel deployment стал
`READY` и сохранил основной домен. Не выполнена только визуальная приёмка пользователем
внутри Telegram.

## Подтверждённые причины

### Mini App `Failed to fetch`

Историческая причина была подтверждена на старом deployment
`https://wb-finbot-mvp.vercel.app`:

- `GET /api/health` вернул `200`.
- `GET /api/account` без `X-Telegram-Init-Data` вернул `401`.
- `OPTIONS /api/account` вернул `204` и разрешил `X-Telegram-Init-Data`.
- production `index.html` ссылался на `/assets/index-D2yF3aA1.js`.
- этот реально отданный asset содержал строку `http://localhost:3000`.

Следовательно, Mini App отправлял API-запросы в localhost устройства вместо Vercel. Запрос не доходил до backend и frontend показывал системный `Failed to fetch`; это не было состоянием «WB-токен не подключён».

В актуальном deployment frontend asset `/assets/index-r-whGoQl.js` больше не содержит
`localhost`, `127.0.0.1` или системный текст `Failed to fetch`. `/api/health` возвращает
`200`, production account без initData возвращает ожидаемый `401`, а запрос с валидной
Telegram initData работает с тем же account, что и bot.

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

- Нужна визуальная проверка в Telegram: `/status`, открытие Mini App, отчёты
  `772198476` и `777875626`, повторное открытие уже загруженного отчёта.
- Оставшиеся ещё не загруженные отчёты следует открывать по одному: первый запрос
  загружает и сохраняет данные в Neon, повторный использует базу. Массовая загрузка
  создаст риск официального WB rate limit.
- Для отчёта `772198476` COGS и налог сейчас равны нулю, ROI отсутствует не из-за ошибки:
  все 28 товаров пока без себестоимости, а account использует `taxMode=none`.
- BotFather menu button нельзя подтвердить через API Telegram; его URL нужно один раз
  визуально проверить в существующем боте. Webhook и отправляемые bot-кнопки используют
  текущий production domain.

Смотрите полный фактический вывод команд и stub-scenarios в `handoff/TEST_RESULTS.md`.

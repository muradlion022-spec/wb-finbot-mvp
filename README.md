# WB Финбот MVP

Локальный MVP Telegram-бота и Telegram Mini App для разбора финансового отчета Wildberries. Проект подготовлен к бесплатному деплою через GitHub + Vercel Hobby + Neon Free PostgreSQL.

## Что работает

- Mini App на Vite/React.
- API на Hono.
- Локально Telegram-бот может работать через polling.
- В production Telegram-бот работает через webhook: `/api/telegram/webhook`.
- Данные production хранятся в Neon PostgreSQL.
- Локальный режим сохраняет SQLite через `prisma/schema.sqlite.prisma`.
- WB API-токен хранится зашифрованно и не логируется.
- Mini App в production обращается к backend только по относительным `/api/...` адресам.
- Список отчётов и detail-sync защищены DB-backed cooldown и блокировкой на аккаунт.

## Локальный запуск

Откройте файл:

```bash
scripts/start-local.command
```

Он установит зависимости, применит SQLite-схему и запустит Mini App, API и Telegram polling, если в `.env` есть `BOT_TOKEN`.

Локально webhook не нужен. Если раньше был включён webhook, удалите его:

```bash
scripts/delete-telegram-webhook.command
```

## Telegram-команды

- `/start` — старт и основная клавиатура.
- `/app` — кнопка открытия Mini App.
- `/status` — статус бота, WB API и ссылки Mini App.

## WB API-токен

В WB при создании токена выберите `Для интеграции вручную`, `Персональный` или `Сервисный` токен.

Обязательно: категория `Финансы`, уровень `Только чтение`.

Опционально: категория `Контент`, уровень `Только чтение`. Без Content финансовые отчёты работают, но названия, бренды и изображения товаров могут не загрузиться.

Категория Analytics для текущего MVP не требуется. При сохранении токена сервис не вызывает financial detailed endpoints и не загружает отчёты.

## Env-переменные Vercel

```env
BOT_TOKEN=
DATABASE_URL=postgresql://USER:PASSWORD@HOST.neon.tech/DB?sslmode=require
ENCRYPTION_SECRET=replace-with-32-random-bytes-before-real-use
NODE_ENV=production
MINI_APP_URL=https://your-vercel-domain.vercel.app
PUBLIC_API_URL=https://your-vercel-domain.vercel.app
TELEGRAM_WEBHOOK_SECRET=replace-with-random-webhook-secret
USE_DEMO_DATA=false
WB_API_BASE_URL=https://statistics-api.wildberries.ru
WB_FINANCE_API_BASE_URL=https://finance-api.wildberries.ru
WB_CONTENT_API_BASE_URL=https://content-api.wildberries.ru
WB_REPORT_LOOKBACK_DAYS=90
VITE_API_BASE_URL=
```

`ENCRYPTION_SECRET` должен быть постоянным. Если поменять его после сохранения WB-токенов, старые токены не расшифруются.

Не задавайте `VITE_API_BASE_URL` в Vercel. В production frontend всегда использует относительные `/api/...` запросы. Для локального Vite proxy можно задать `VITE_API_BASE_URL=http://localhost:3000` в локальном `.env.local`; production build с `localhost` или `127.0.0.1` завершится ошибкой.

## Деплой GitHub + Neon + Vercel

1. Создайте новый GitHub repository.
2. Загрузите проект из папки `/Users/levonstepanian/Desktop/Codex/WB Финбот MVP`.
3. Проверьте, что `.env`, `node_modules`, `prisma/dev.db` и `dist` не попали в GitHub.
4. Создайте Neon Free PostgreSQL database.
5. В Neon откройте Connection details и скопируйте `DATABASE_URL` формата `postgresql://...?...sslmode=require`.
6. Импортируйте GitHub repository в Vercel.
7. В Vercel добавьте Environment Variables из списка выше.
8. Первый раз можно указать временно `MINI_APP_URL=https://your-project.vercel.app` и `PUBLIC_API_URL=https://your-project.vercel.app`.
9. Задеплойте проект.
10. После деплоя скопируйте финальный Vercel domain.
11. В Vercel обновите `MINI_APP_URL=https://<vercel-domain>` и `PUBLIC_API_URL=https://<vercel-domain>`.
12. В Vercel redeploy.
13. Запустите миграции Prisma: `pnpm db:migrate:deploy`.
14. Установите Telegram webhook: `scripts/set-telegram-webhook.command https://<vercel-domain>`.
15. В BotFather добавьте Menu Button на `https://<vercel-domain>`.
16. Проверьте `/start`, `/app`, `/status`.

## Архитектура Vercel

- `dist/web` — статический Mini App после Vite build.
- `api/[[...route]].ts` — Vercel serverless function, которая передает все `/api/*` запросы в Hono app.
- `src/server/routes.ts` — API routes + Telegram webhook endpoint.
- `src/server/bot.ts` — общая логика бота. Локально запускается polling, production обрабатывает updates через webhook.
- `src/server/sync.ts` — DB-backed lock и 65-секундный cooldown по `accountId + endpointType`.
- `prisma/schema.prisma` — PostgreSQL для Neon production.
- `prisma/schema.sqlite.prisma` — SQLite для локального режима.

## Безопасность

- Не вставляйте `BOT_TOKEN` в код.
- Не вставляйте WB API-токены в код.
- Не публикуйте `.env` в GitHub.
- WB API-токен пользователя хранится зашифрованно.
- `TELEGRAM_WEBHOOK_SECRET` проверяется через заголовок `X-Telegram-Bot-Api-Secret-Token`, если переменная задана.
- Backend отвечает безопасным `requestId`; его можно сопоставить с server log. WB token, Telegram initData и секреты в логах не выводятся.

## Синхронизация WB

- `GET /api/reports` читает базу, если список синхронизировался меньше 65 секунд назад.
- При `429` уже сохранённые отчёты остаются доступны с сообщением о cooldown.
- Для одного аккаунта одновременно может работать только один sync каждого типа: список отчётов, financial detail или Content cards.
- Financial detailed запрос делает только одну страницу до 100 000 строк за invocation. Если строк больше, отчёт получает статус `partial`; MVP честно показывает первую страницу и не делает второй запрос автоматически.
- Content enrichment запускается отдельно после finance summary. Ошибка Content не удаляет и не скрывает финансовый отчёт; повторить можно обычным обновлением отчёта после cooldown.

## Version и диагностика

`GET /api/health` возвращает `version` и `builtAt`. В Settings Mini App отображается версия frontend. После deploy сравните эти значения с текущим Vercel deployment, чтобы исключить старый Telegram cache или разные frontend/backend deployment.

## Одноразовый перенос demo-данных

Старый `local-demo-account` не переносится автоматически. Для явного переноса в один конкретный Telegram account сначала выполните dry-run:

```bash
node --import tsx scripts/migrate-demo-account.ts --telegram-user-id <Telegram ID>
```

Скрипт покажет наличие токена только по последним четырём символам и количество отчётов, товаров, себестоимостей и расходов. Для реального переноса нужно явное подтверждение:

```bash
node --import tsx scripts/migrate-demo-account.ts --telegram-user-id <Telegram ID> --apply --confirm telegram-<Telegram ID>
```

Если у целевого account уже есть данные, скрипт остановится и ничего не объединит.

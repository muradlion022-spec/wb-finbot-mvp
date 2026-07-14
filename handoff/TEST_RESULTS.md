# Test Results — 2026-07-14

## Production verification — 2026-07-14

Existing Vercel project `wb-finbot-mvp` was updated without creating a second project,
database or bot. The GitHub-triggered deployment `dpl_8CEjwuEea5Hi3UDWESp6fu4FsXX3`
is `READY`, and the existing alias `https://wb-finbot-mvp.vercel.app` reports version
`485d65f1c23f`.

| Check | Actual result |
| --- | --- |
| `GET /api/health` | HTTP 200, `ok=true`, version `485d65f1c23f` |
| `GET /api/account` without initData | HTTP 401, Telegram authorization required |
| `OPTIONS /api/account` | HTTP 204; allows `Content-Type,X-Telegram-Init-Data,X-WB-Finbot-Session,X-Request-Id` |
| Production JS asset | No `localhost`, `127.0.0.1` or `Failed to fetch` |
| Database migration | Existing Neon PostgreSQL connected; four migrations found; none pending |
| Telegram webhook | Current production URL; zero pending updates; no last error |
| Signed Telegram initData | Existing `telegram-<telegramUserId>` account, token status `valid` |
| Report list | 26 reports for the authenticated account |
| Report `772198476` | HTTP 200, `ready`, 13,554 imported rows, 28 products |
| Report `777875626` | HTTP 200, `ready`, 12 products; repeat open used saved state |

Production summary for report `772198476`:

| Metric | Actual production value |
| --- | ---: |
| Sales | 950,646.72 RUB |
| Goods payout | 832,550.66 RUB |
| WB commission | 118,096.06 RUB |
| WB service expenses | 293,337.02 RUB |
| Final WB payment | 539,213.64 RUB |
| Product cost | 0 RUB |
| Operating expenses | 0 RUB |
| Tax | 0 RUB |
| Net profit | 539,213.64 RUB |
| Margin | 56.7% |
| ROI | unavailable because product cost is 0 |

The zero tax/COGS values match persisted settings: `taxMode=none` and all 28 report
products currently have no cost. No token, initData or Telegram user ID was printed.

GitHub publication completed through official GitHub CLI OAuth. Remote `main` advanced
from `bc99e9a2389ca2543e1d2ef42e27c8fde0808900` to
`485d65f1c23f0870d351d14846e8a220c2b661d5` by a normal fast-forward push. Eight differing
files were published; the other 49 tracked files were byte-identical. No force push or
repository history rewrite was used. The automatic Vercel deployment became `READY`,
and the authenticated Telegram/WB report checks were repeated on version `485d65f1c23f`.

## Finance reconciliation update — 2026-07-14

The real WB workbook `Еженедельный детализированный отчет №772198476_275536 - 1.xlsx`
was inspected without copying it into the repository. The new normalizer and calculation
smoke fixture reproduce the official WB totals for report `772198476`:

| Metric | Expected and actual |
| --- | ---: |
| Sales after returns | 950,646.72 RUB |
| Goods payout after returns | 832,550.66 RUB |
| WB commission / sales-to-goods-payout difference | 118,096.06 RUB |
| Logistics | 263,373.05 RUB |
| Storage | 4,663.97 RUB |
| Other deductions | 25,220.00 RUB |
| Fines | 80.00 RUB |
| WB service expenses total | 293,337.02 RUB |
| Final WB payment | 539,213.64 RUB |

The fixture also verifies COGS, operating expenses, configurable tax, profit before tax,
net profit, margin and ROI. Return rows are negative, non-sale WB expense rows do not add
sold units, and account-level rows with `nmId=0` remain in report totals.
The production account accepted all 13,554 workbook rows through the authenticated
`POST /api/reports/import` endpoint; no WB token or Telegram initData was printed.

Commands re-run successfully on 2026-07-14:

- `pnpm install --frozen-lockfile`
- `pnpm run lint`
- `pnpm run build`
- `node --import tsx scripts/smoke-telegram-auth.ts`
- `SMOKE_MODE=production node --import tsx scripts/smoke-telegram-auth.ts`
- `node --import tsx scripts/smoke-normalizer.ts`
- `node --import tsx scripts/smoke-wb-sync-safety.ts`
- production localhost guard failed as expected with non-zero status
- `rg -n "localhost|127\\.0\\.0\\.1" dist/web` returned no matches

Команды выполнены в `/Users/levonstepanian/Desktop/Codex/WB Финбот MVP` с Node runtime Codex и без настоящих WB-токенов. Smoke-тесты используют Git-ignored SQLite базы и локальный WB stub.

## Required commands

### `pnpm install --frozen-lockfile`

```text
Already up to date
Done in 398ms using pnpm v11.7.0

   ╭──────────────────────────────────────────╮
   │                                          │
   │   Update available! 11.7.0 → 11.11.0.    │
   │   Changelog: https://pnpm.io/v/11.11.0   │
   │     To update, run: pnpm add -g pnpm     │
   │                                          │
   ╰──────────────────────────────────────────╯
```

### `pnpm run lint`

```text
$ tsc --noEmit
```

### `pnpm run build`

```text
$ prisma generate && tsc --noEmit && vite build
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma

✔ Generated Prisma Client (v6.19.3) to ./node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_typescript@5.9.3__typescript@5.9.3/node_modules/@prisma/client in 85ms

Start by importing your Prisma Client (See: https://pris.ly/d/importing-client)

Tip: Want to turn off tips and other hints? https://pris.ly/tip-4-nohints

vite v6.4.3 building for production...
transforming...
✓ 1579 modules transformed.
rendering chunks...
computing gzip size...
dist/web/index.html                   0.47 kB │ gzip:  0.31 kB
dist/web/assets/index-C80qjUTT.css    7.76 kB │ gzip:  2.30 kB
dist/web/assets/index-usGOvM7s.js   179.29 kB │ gzip: 56.52 kB
✓ built in 1.18s
```

### `node --import tsx scripts/smoke-telegram-auth.ts`

```text
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.sqlite.prisma

✔ Generated Prisma Client (v6.19.3) to ./node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_typescript@5.9.3__typescript@5.9.3/node_modules/@prisma/client in 85ms

Start by importing your Prisma Client (See: https://pris.ly/d/importing-client)

Tip: Need your code to do more? Check out Prisma Studio! https://pris.ly/tip-5-studio

Environment variables loaded from .env
Prisma schema loaded from prisma/schema.sqlite.prisma
Datasource "db": SQLite database "wb-finbot-telegram-auth-smoke.db" at "file:./wb-finbot-telegram-auth-smoke.db"

The database is already in sync with the Prisma schema.

[api-request] {
  requestId: 'f29439cd-de76-4a84-8e07-3b408ab11797',
  route: '/api/account',
  accountId: 'telegram-987654321',
  telegramUserId: '987654321',
  status: 200,
  durationMs: 517,
  resultCode: 'ok'
}
[api-request] {
  requestId: '5692b75d-7b70-40af-b038-2fe6b70d13d1',
  route: '/api/reports/import',
  accountId: 'telegram-987654321',
  telegramUserId: '987654321',
  status: 200,
  durationMs: 42,
  resultCode: 'ok'
}
[api-request] {
  requestId: '8cf9c441-2d94-4dd0-97ff-efa35096bb82',
  route: '/api/reports/cmrg6mp9g0003vrxzlwdvx610/summary',
  accountId: 'telegram-987654322',
  telegramUserId: '987654322',
  status: 404,
  durationMs: 4,
  resultCode: 'report_not_found'
}
[api-request] {
  requestId: 'e6cbfdcf-2694-45d3-a8d9-2b2163c64dd0',
  route: '/api/products/cmrg6mp9i0005vrxzr9nkck85/cost',
  accountId: 'telegram-987654322',
  telegramUserId: '987654322',
  status: 404,
  durationMs: 2,
  resultCode: 'product_not_found'
}
[api-request] {
  requestId: 'c27e9320-83fa-4170-b239-8f5ab6efc648',
  route: '/api/expenses',
  accountId: 'telegram-987654321',
  telegramUserId: '987654321',
  status: 200,
  durationMs: 3,
  resultCode: 'ok'
}
[api-request] {
  requestId: '861a1c49-b247-40ab-ab1a-e00355703135',
  route: '/api/expenses/cmrg6sxom000cvryppg9gl3xh',
  accountId: 'telegram-987654322',
  telegramUserId: '987654322',
  status: 404,
  durationMs: 1,
  resultCode: 'expense_not_found'
}
[api-request] {
  requestId: '13e95d63-8f80-4ec8-b0e7-919aa1ab42d7',
  route: '/api/expenses/cmrg6sxom000cvryppg9gl3xh',
  accountId: 'telegram-987654321',
  telegramUserId: '987654321',
  status: 200,
  durationMs: 2,
  resultCode: 'ok'
}
local valid initData: telegram account resolved; foreign report/product/expense rejected
```

### `SMOKE_MODE=production node --import tsx scripts/smoke-telegram-auth.ts`

```text
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.sqlite.prisma

✔ Generated Prisma Client (v6.19.3) to ./node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_typescript@5.9.3__typescript@5.9.3/node_modules/@prisma/client in 91ms

Start by importing your Prisma Client (See: https://pris.ly/d/importing-client)

Tip: Need your code to do more? Check out Prisma Studio! https://pris.ly/tip-5-studio

[api-request] {
  requestId: 'dd04c27c-73ee-4dbd-afea-a1491b18773b',
  route: '/api/account',
  accountId: undefined,
  telegramUserId: undefined,
  status: 401,
  durationMs: 363,
  resultCode: 'telegram_auth_required'
}
production no-initData: 401
[api-error] {
  requestId: 'eeedad6e-f772-4bbf-bf75-a33f6a5bc17b',
  route: '/api/__smoke/unknown',
  accountId: undefined,
  telegramUserId: undefined,
  error: 'Error: production smoke internal marker\n' +
    '    at <anonymous> (/Users/levonstepanian/Desktop/Codex/WB Финбот MVP/src/server/routes.ts:335:11)\n' +
    '    at dispatch (file:///Users/levonstepanian/Desktop/Codex/WB%20%D0%A4%D0%B8%D0%BD%D0%B1%D0%BE%D1%82%20MVP/node_modules/.pnpm/hono@4.12.27/node_modules/hono/dist/compose.js:22:23)\n' +
    '    at file:///Users/levonstepanian/Desktop/Codex/WB%20%D0%A4%D0%B8%D0%BD%D0%B1%D0%BE%D1%82%20MVP/node_modules/.pnpm/hono@4.12.27/node_modules/hono/dist/compose.js:22:46\n' +
    '    at cors2 (file:///Users/levonstepanian/Desktop/Codex/WB%20%D0%A4%D0%B8%D0%BD%D0%B1%D0%BE%D1%82%20MVP/node_modules/.pnpm/hono@4.12.27/node_modules/hono/dist/middleware/cors/index.js:76:11)\n' +
    '    at async dispatch (file:///Users/levonstepanian/Desktop/Codex/WB%20%D0%A4%D0%B8%D0%BD%D0%B1%D0%BE%D1%82%20MVP/node_modules/.pnpm/hono@4.12.27/node_modules/hono/dist/compose.js:22:17)\n' +
    '    at async <anonymous> (/Users/levonstepanian/Desktop/Codex/WB Финбот MVP/src/server/routes.ts:116:5)\n' +
    '    at async dispatch (file:///Users/levonstepanian/Desktop/Codex/WB%20%D0%A4%D0%B8%D0%BD%D0%B1%D0%BE%D1%82%20MVP/node_modules/.pnpm/hono@4.12.27/node_modules/hono/dist/compose.js:22:17)\n' +
    '    at async file:///Users/levonstepanian/Desktop/Codex/WB%20%D0%A4%D0%B8%D0%BD%D0%B1%D0%BE%D1%82%20MVP/node_modules/.pnpm/hono@4.12.27/node_modules/hono/dist/hono-base.js:306:25\n' +
    '    at async <anonymous> (/Users/levonstepanian/Desktop/Codex/WB Финбот MVP/scripts/smoke-telegram-auth.ts:47:19)'
}
[api-request] {
  requestId: 'eeedad6e-f772-4bbf-bf75-a33f6a5bc17b',
  route: '/api/__smoke/unknown',
  accountId: undefined,
  telegramUserId: undefined,
  status: 500,
  durationMs: 9,
  resultCode: 'internal_error'
}
production unknown error: safe 500 with requestId
```

The smoke test asserted that the HTTP JSON response was exactly `Внутренняя ошибка сервиса. Попробуйте ещё раз.` and did not contain `production smoke internal marker`; the marker above appears only in the server-side test log.

## Additional checks

### `node --import tsx scripts/smoke-normalizer.ts`

```text
normalizer: camelCase and snake_case fixtures preserve finance values
```

### Production localhost guard

Command:

```bash
VITE_API_BASE_URL="http://localhost:3000" pnpm run build
```

Actual output and expected non-zero exit:

```text
$ prisma generate && tsc --noEmit && vite build
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma

✔ Generated Prisma Client (v6.19.3) to ./node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_typescript@5.9.3__typescript@5.9.3/node_modules/@prisma/client in 81ms

Start by importing your Prisma Client (See: https://pris.ly/d/importing-client)

Tip: Interested in query caching in just a few lines of code? Try Accelerate today! https://pris.ly/tip-3-accelerate

failed to load config from /Users/levonstepanian/Desktop/Codex/WB Финбот MVP/vite.config.ts
error during build:
Error: VITE_API_BASE_URL must be empty in a production build. The Mini App uses relative /api routes; localhost is only allowed through the local Vite proxy.
[ELIFECYCLE] Command failed with exit code 1.
```

### Production bundle audit

Command:

```bash
rg -n "localhost|127\\.0\\.0\\.1" dist/web || true
```

Actual output:

```text

```

The empty output confirms that the final production bundle does not contain either loopback hostname.

### `node --import tsx scripts/smoke-wb-sync-safety.ts`

```text
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.sqlite.prisma

✔ Generated Prisma Client (v6.19.3) to ./node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_typescript@5.9.3__typescript@5.9.3/node_modules/@prisma/client in 83ms

Start by importing your Prisma Client (See: https://pris.ly/d/importing-client)

Tip: Want to turn off tips and other hints? https://pris.ly/tip-4-nohints

Environment variables loaded from .env
Prisma schema loaded from prisma/schema.sqlite.prisma
Datasource "db": SQLite database "wb-finbot-sync-safety.db" at "file:./wb-finbot-sync-safety.db"

The database is already in sync with the Prisma schema.

[wb-api] {
  scope: 'content',
  tokenLength: 29,
  tokenLast4: '7890',
  status: 403,
  error: 'content rights missing'
}
finance-only token: saved with Content warning
report list cooldown: second open used database cache without WB request
[wb-api] {
  scope: 'content',
  tokenLength: 29,
  tokenLast4: '7890',
  status: 503,
  error: 'content unavailable'
}
[content-enrichment] {
  accountId: 'telegram-710001',
  reportId: 'cmrg73hsd0004vrgsgrr496lc',
  errorCode: 'wb_server_error',
  retryAfterSeconds: 0
}
content failure: finance summary remains available with vendorCode and nmId
[wb-api] {
  scope: 'finance',
  tokenLength: 29,
  tokenLast4: '7890',
  status: 429,
  error: 'rate limited'
}
WB 429: saved report list remained available with cooldown
large report: one detailed WB request, partial status and last rrdId saved for MVP limit
[api-request] {
  requestId: '72f5790e-f189-44d0-8c44-2cd65a861181',
  route: '/api/account',
  accountId: 'telegram-710001',
  telegramUserId: '710001',
  status: 200,
  durationMs: 5,
  resultCode: 'ok'
}
[api-request] {
  requestId: '2c286c2b-81c5-4838-9cfe-ef66d84cb360',
  route: '/api/account',
  accountId: 'telegram-710002',
  telegramUserId: '710002',
  status: 200,
  durationMs: 3,
  resultCode: 'ok'
}
[api-request] {
  requestId: '6517fa93-fb4c-42fe-9eb8-cbafab544a5c',
  route: '/api/expenses',
  accountId: 'telegram-710001',
  telegramUserId: '710001',
  status: 400,
  durationMs: 2,
  resultCode: 'invalid_request'
}
[api-error] {
  requestId: '2ca6fbd8-f965-47d0-aa98-08cab6152fa4',
  route: '/api/reports/import',
  accountId: 'telegram-710001',
  telegramUserId: '710001',
  error: 'Error: Не найдено строк отчета с nmId или артикулом.\n' +
    '    at importReport (/Users/levonstepanian/Desktop/Codex/WB Финбот MVP/src/server/reports.ts:160:33)\n' +
    '    at async <anonymous> (/Users/levonstepanian/Desktop/Codex/WB Финбот MVP/src/server/routes.ts:186:18)\n' +
    '    at async dispatch (file:///Users/levonstepanian/Desktop/Codex/WB%20%D0%A4%D0%B8%D0%BD%D0%B1%D0%BE%D1%82%20MVP/node_modules/.pnpm/hono@4.12.27/node_modules/hono/dist/compose.js:22:17)\n' +
    '    at async cors2 (file:///Users/levonstepanian/Desktop/Codex/WB%20%D0%A4%D0%B8%D0%BD%D0%B1%D0%BE%D1%82%20MVP/node_modules/.pnpm/hono@4.12.27/node_modules/hono/dist/middleware/cors/index.js:76:5)\n' +
    '    at async dispatch (file:///Users/levonstepanian/Desktop/Codex/WB%20%D0%A4%D0%B8%D0%BD%D0%B1%D0%BE%D1%82%20MVP/node_modules/.pnpm/hono@4.12.27/node_modules/hono/dist/compose.js:22:17)\n' +
    '    at async <anonymous> (/Users/levonstepanian/Desktop/Codex/WB Финбот MVP/src/server/routes.ts:116:5)\n' +
    '    at async dispatch (file:///Users/levonstepanian/Desktop/Codex/WB%20%D0%A4%D0%B8%D0%BD%D0%B1%D0%BE%D1%82%20MVP/node_modules/.pnpm/hono@4.12.27/node_modules/hono/dist/compose.js:22:17)\n' +
    '    at async file:///Users/levonstepanian/Desktop/Codex/WB%20%D0%A4%D0%B8%D0%BD%D0%B1%D0%BE%D1%82%20MVP/node_modules/.pnpm/hono@4.12.27/node_modules/hono/dist/hono-base.js:306:25\n' +
    '    at async <anonymous> (/Users/levonstepanian/Desktop/Codex/WB Финбот MVP/scripts/smoke-wb-sync-safety.ts:181:20)'
}
[api-request] {
  requestId: '2ca6fbd8-f965-47d0-aa98-08cab6152fa4',
  route: '/api/reports/import',
  accountId: 'telegram-710001',
  telegramUserId: '710001',
  status: 500,
  durationMs: 6,
  resultCode: 'internal_error'
}
account isolation, Zod 400 and safe unknown error: verified
```

This one isolated stub run covers: Finance-only token storage, optional Content failure, `GET /api/reports` cache hit, saved data on `429`, one detailed page only for a 100,000-row response, two-account isolation, Zod `400`, and safe `500` output.

### Historical production evidence before the corrected deployment

```text
GET https://wb-finbot-mvp.vercel.app/api/health -> HTTP 200
{"ok":true,"name":"WB Финбот MVP"}

GET https://wb-finbot-mvp.vercel.app/api/account without X-Telegram-Init-Data -> HTTP 401
{"error":"Telegram authorization required."}

OPTIONS /api/account with X-Telegram-Init-Data -> HTTP 204
access-control-allow-headers: Content-Type,X-Telegram-Init-Data

GET https://wb-finbot-mvp.vercel.app/ -> /assets/index-D2yF3aA1.js
Production asset contained: http://localhost:3000

Vercel logs command for the last 24 hours -> No logs found for muradlion022-7664s-projects/wb-finbot-mvp
```

The old bundle observation was the factual cause of the reproduced Mini App
`Failed to fetch`. It is retained here as incident evidence. The corrected deployment
and authenticated checks are recorded in `Production verification — 2026-07-14` above.

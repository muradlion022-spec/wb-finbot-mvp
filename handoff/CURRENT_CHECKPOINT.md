# Current checkpoint - 2026-07-14

## Safe state

- Local working folder: `/Users/levonstepanian/Desktop/Codex/WB Финбот MVP`
- Deployed source commit: `5f166b9` (`docs: save finance deployment checkpoint`)
- Product code commit: `ce19079` (`fix: reconcile WB commission and service expenses`)
- Previous rollback tag: `pre-finance-fix-2026-07-14`
- Existing Vercel project: `wb-finbot-mvp`
- Existing production domain: `https://wb-finbot-mvp.vercel.app`
- Production deployment: `dpl_H83pngTKr1ZjXD6yTXVW3Y8H8J9p`
- Production version from `/api/health`: `5f166b9a650d`
- GitHub repository: `https://github.com/muradlion022-spec/wb-finbot-mvp`
- GitHub `main` is still at `bc99e9a2389ca2543e1d2ef42e27c8fde0808900` because the
  current GitHub integration has read-only permissions and local HTTPS credentials are absent.
- No force push, database reset, token replacement or production deletion was performed.

## Completed

- The official WB workbook for report `772198476` was reconciled.
- Production accepted 13,554 authenticated report rows.
- Confirmed totals: sales `950646.72`, goods payout `832550.66`, WB commission
  `118096.06`, WB service expenses `293337.02`, final payment `539213.64` RUB.
- Commission and service expenses are separated in backend calculations, bot output
  and Mini App metrics.
- TypeScript, production build, Telegram auth smoke, normalizer smoke and WB sync
  safety smoke passed.
- Production bundle guard rejects a localhost API URL.
- Vercel connected to the existing Neon PostgreSQL database; Prisma found four
  migrations and reported no pending migrations.
- Production `/api/health` returns `200`; `/api/account` without Telegram initData
  returns the expected `401`; CORS allows `X-Telegram-Init-Data`.
- The current production asset contains no `localhost`, `127.0.0.1` or user-facing
  `Failed to fetch` string.
- Telegram webhook points to the current production domain, has zero pending updates
  and reports no last error.
- Signed Telegram initData resolves the existing account as `telegram-<telegramUserId>`;
  its WB token status is `valid`, and 26 reports are visible from the same account.
- Report `772198476` is `ready` in production with the confirmed totals above.
- Report `777875626` opened successfully; reopening it used the saved database state
  instead of repeating the initial WB load.

## Resume from here

1. Restore authenticated GitHub write access, then copy the current source into the
   existing repository history and push a normal fast-forward commit. Do not force push.
2. Verify that the GitHub commit contains the same product files as local commit
   `ce19079`; a GitHub-triggered Vercel deployment must pass health checks before it
   replaces the current deployment.
3. In Telegram, visually open `/status`, report `772198476` and report `777875626`.
4. Enter product costs and choose a tax mode if non-zero COGS, tax, net profit and ROI
   are required. The current account has `taxMode=none` and all 28 products in report
   `772198476` are missing cost, so tax is `0` and ROI is intentionally unavailable.

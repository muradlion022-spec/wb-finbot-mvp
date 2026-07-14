import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { calculateReportSummary, getReportProductDetail, normalizeTaxMode } from "./calculations.js";
import { config } from "./config.js";
import { bootstrapDemo } from "./demo.js";
import { prisma } from "./db.js";
import {
  enrichReportProducts,
  ensureReportLoaded,
  importReport,
  listReports,
  ReportNotFoundError,
  ReportSyncPendingError,
  syncWbReportList,
  WbNotConnectedError
} from "./reports.js";
import {
  getCurrentAccount,
  MINI_APP_SESSION_COOKIE,
  MINI_APP_SESSION_TTL_SECONDS,
  TelegramAuthError,
  validateMiniAppSession
} from "./telegramAuth.js";
import { toUserWbError, WbApiError } from "./wbClient.js";
import { getBot } from "./bot.js";
import { saveAndValidateWbToken } from "./wbToken.js";

type ApiVariables = {
  requestId: string;
  accountId?: string;
  telegramUserId?: string;
};

const app = new Hono<{ Variables: ApiVariables }>();

const moneySchema = z.coerce.number().min(0).default(0);
const productCostSchema = z.object({
  purchaseCost: moneySchema,
  packagingCost: moneySchema,
  fulfillmentCost: moneySchema,
  deliveryToWarehouseCost: moneySchema,
  markingCost: moneySchema,
  otherUnitCost: moneySchema
});
const operatingExpenseSchema = z.object({
  title: z.string().trim().min(1),
  category: z.string().trim().min(1),
  amount: z.coerce.number().positive(),
  expenseType: z.enum(["one_time", "recurring"]),
  recurrenceType: z.enum(["none", "monthly", "weekly", "yearly"]).optional().default("none"),
  expenseDate: z.string().nullable().optional(),
  dayOfMonth: z.coerce.number().int().min(1).max(31).nullable().optional(),
  allocationMode: z.enum(["store_level_only", "by_revenue_share", "by_quantity_sold", "manual"]),
  active: z.boolean().optional().default(true)
});
const reportImportSchema = z.object({
  reportId: z.string().trim().optional(),
  dateFrom: z.string().trim().optional(),
  dateTo: z.string().trim().optional(),
  lines: z.array(z.record(z.unknown())).min(1)
});
const taxModeSchema = z.enum([
  "none",
  "usn_income_1",
  "usn_income_6",
  "usn_profit_5",
  "usn_profit_15"
]);

const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://web.telegram.org",
  config.MINI_APP_URL,
  config.PUBLIC_API_URL
];

function responseError(
  context: any,
  status: 400 | 401 | 402 | 403 | 404 | 429 | 500 | 502 | 503,
  error: string,
  code: string
) {
  context.header("X-Result-Code", code);
  return context.json({ error, code, requestId: context.get("requestId") }, status);
}

function wbStatus(error: WbApiError) {
  const statuses: Record<string, 401 | 402 | 403 | 404 | 429 | 502 | 503> = {
    invalid_token: 401,
    missing_finance_rights: 403,
    missing_content_rights: 403,
    payment_required: 402,
    rate_limited: 429,
    no_reports: 404,
    wb_server_error: 503,
    network_error: 503,
    api_error: 502
  };
  return statuses[error.code] || 502;
}

function redactLogValue(value: string) {
  return value
    .replace(/(authorization|token|secret|password|database_url)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
}

function logRequestError(context: { get: (key: keyof ApiVariables) => string | undefined; req: { path: string } }, error: unknown) {
  const message = error instanceof Error ? redactLogValue(error.stack || error.message) : "Unknown error";
  console.error("[api-error]", {
    requestId: context.get("requestId"),
    route: context.req.path,
    accountId: context.get("accountId"),
    telegramUserId: context.get("telegramUserId"),
    error: message
  });
}

app.use("*", async (context, next) => {
  const requestId = context.req.header("X-Request-Id") || randomUUID();
  const startedAt = Date.now();
  context.set("requestId", requestId);
  context.header("X-Request-Id", requestId);
  try {
    await next();
  } finally {
    const resultCode = context.res.headers.get("X-Result-Code") || (context.res.status < 400 ? "ok" : `http_${context.res.status}`);
    context.res.headers.set("X-Result-Code", resultCode);
    console.info("[api-request]", {
      requestId,
      route: context.req.path,
      accountId: context.get("accountId"),
      telegramUserId: context.get("telegramUserId"),
      status: context.res.status,
      durationMs: Date.now() - startedAt,
      resultCode
    });
  }
});

app.use(
  "*",
  cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Telegram-Init-Data", "X-WB-Finbot-Session", "X-Request-Id"]
  })
);

app.get("/api/health", (context) =>
  context.json({ ok: true, name: "WB Финбот MVP", version: config.BUILD_VERSION, builtAt: config.BUILT_AT })
);

app.post("/api/telegram/webhook", async (context) => {
  if (!config.BOT_TOKEN) return responseError(context, 503, "Сервис Telegram временно не настроен.", "telegram_unavailable");
  if (config.TELEGRAM_WEBHOOK_SECRET) {
    const secret = context.req.header("x-telegram-bot-api-secret-token");
    if (secret !== config.TELEGRAM_WEBHOOK_SECRET) {
      return responseError(context, 401, "Telegram webhook не авторизован.", "telegram_webhook_unauthorized");
    }
  }
  const bot = getBot();
  if (!bot) return responseError(context, 503, "Сервис Telegram временно недоступен.", "telegram_unavailable");
  await bot.init();
  await bot.handleUpdate(await context.req.json());
  return context.json({ ok: true, requestId: context.get("requestId") });
});

app.get("/api/telegram/mini-app", async (context) => {
  const session = context.req.query("session") || "";
  validateMiniAppSession(session);

  const redirectUrl = new URL(config.MINI_APP_URL);
  const reportId = context.req.query("reportId");
  const tab = context.req.query("tab");
  if (reportId && /^[A-Za-z0-9_-]{1,128}$/.test(reportId)) {
    redirectUrl.searchParams.set("reportId", reportId);
  }
  if (tab === "expenses") {
    redirectUrl.searchParams.set("tab", tab);
  }

  context.header(
    "Set-Cookie",
    `${MINI_APP_SESSION_COOKIE}=${session}; Max-Age=${MINI_APP_SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
  context.header("Cache-Control", "no-store");
  return context.redirect(redirectUrl.toString(), 302);
});

app.get("/api/account", async (context) => {
  const account = await getCurrentAccount(context);
  return context.json({
    id: account.id,
    name: account.name,
    tokenStatus: account.tokenStatus,
    taxMode: normalizeTaxMode(account.taxMode),
    useDemoData: config.USE_DEMO_DATA,
    version: config.BUILD_VERSION
  });
});

app.patch("/api/account/tax", async (context) => {
  const account = await getCurrentAccount(context);
  const { taxMode } = z.object({ taxMode: taxModeSchema }).parse(await context.req.json());
  const updated = await prisma.wbAccount.update({ where: { id: account.id }, data: { taxMode } });
  return context.json({ taxMode: updated.taxMode });
});

app.post("/api/demo/reset", async (context) => {
  if (!config.USE_DEMO_DATA) return responseError(context, 403, "Демо-режим выключен.", "demo_disabled");
  const report = await bootstrapDemo({ reset: true });
  const summary = await calculateReportSummary(report.id);
  return context.json({ report, summary });
});

app.get("/api/reports", async (context) => {
  const account = await getCurrentAccount(context);
  const result = await listReports({ accountId: account.id, syncWb: true });
  return context.json(result);
});

app.post("/api/reports/import", async (context) => {
  const account = await getCurrentAccount(context);
  const report = await importReport(reportImportSchema.parse(await context.req.json()), { accountId: account.id });
  const summary = await calculateReportSummary(report.id, account.id);
  return context.json({ report, summary });
});

app.get("/api/reports/:id/summary", async (context) => {
  const account = await getCurrentAccount(context);
  try {
    const loaded = await ensureReportLoaded(context.req.param("id"), { accountId: account.id });
    const summary = await calculateReportSummary(loaded.report.id, account.id);
    return context.json({ ...summary, sync: loaded.sync });
  } catch (error) {
    if (error instanceof ReportSyncPendingError) {
      return context.json(
        {
          syncStatus: error.syncStatus,
          retryAfterSeconds: error.retryAfterSeconds,
          message: error.message,
          requestId: context.get("requestId")
        },
        202
      );
    }
    throw error;
  }
});

app.post("/api/reports/:id/refresh", async (context) => {
  const account = await getCurrentAccount(context);
  try {
    const loaded = await ensureReportLoaded(context.req.param("id"), { accountId: account.id, force: true });
    const summary = await calculateReportSummary(loaded.report.id, account.id);
    return context.json({ summary, sync: loaded.sync });
  } catch (error) {
    if (error instanceof ReportSyncPendingError) {
      return context.json(
        {
          syncStatus: error.syncStatus,
          retryAfterSeconds: error.retryAfterSeconds,
          message: error.message,
          requestId: context.get("requestId")
        },
        202
      );
    }
    throw error;
  }
});

app.post("/api/reports/:id/enrich-products", async (context) => {
  const account = await getCurrentAccount(context);
  return context.json(await enrichReportProducts(context.req.param("id"), account.id));
});

app.get("/api/reports/:id/products/:nmId", async (context) => {
  const account = await getCurrentAccount(context);
  const nmId = Number(context.req.param("nmId"));
  if (!Number.isFinite(nmId)) return responseError(context, 400, "Некорректный nmId.", "invalid_nm_id");
  const loaded = await ensureReportLoaded(context.req.param("id"), { accountId: account.id });
  return context.json(await getReportProductDetail(loaded.report.id, nmId, account.id));
});

app.put("/api/products/:id/cost", async (context) => {
  const account = await getCurrentAccount(context);
  const productId = context.req.param("id");
  const body = productCostSchema.parse(await context.req.json());
  const savedCost = {
    ...body,
    packagingCost: 0,
    markingCost: 0,
    otherUnitCost: 0
  };
  const totalUnitCost =
    savedCost.purchaseCost + savedCost.fulfillmentCost + savedCost.deliveryToWarehouseCost;
  const product = await prisma.product.findFirst({ where: { id: productId, wbAccountId: account.id }, select: { id: true } });
  if (!product) return responseError(context, 404, "Товар не найден.", "product_not_found");
  await prisma.productCost.updateMany({ where: { productId, validTo: null }, data: { validTo: new Date() } });
  const cost = await prisma.productCost.create({ data: { productId, ...savedCost, totalUnitCost, validFrom: new Date() } });
  return context.json({ cost });
});

app.get("/api/expenses", async (context) => {
  const account = await getCurrentAccount(context);
  return context.json({
    expenses: await prisma.operatingExpense.findMany({
      where: { wbAccountId: account.id },
      orderBy: [{ active: "desc" }, { createdAt: "desc" }]
    })
  });
});

app.post("/api/expenses", async (context) => {
  const account = await getCurrentAccount(context);
  const body = operatingExpenseSchema.parse(await context.req.json());
  const expense = await prisma.operatingExpense.create({
    data: {
      wbAccountId: account.id,
      ...body,
      recurrenceType: body.expenseType === "recurring" ? body.recurrenceType || "monthly" : "none",
      expenseDate: body.expenseDate ? new Date(body.expenseDate) : null,
      dayOfMonth: body.expenseType === "recurring" ? body.dayOfMonth : null
    }
  });
  return context.json({ expense });
});

app.patch("/api/expenses/:id", async (context) => {
  const account = await getCurrentAccount(context);
  const id = context.req.param("id");
  const body = operatingExpenseSchema.partial().parse(await context.req.json());
  const result = await prisma.operatingExpense.updateMany({
    where: { id, wbAccountId: account.id },
    data: { ...body, expenseDate: body.expenseDate ? new Date(body.expenseDate) : undefined }
  });
  if (result.count === 0) return responseError(context, 404, "Расход не найден.", "expense_not_found");
  const expense = await prisma.operatingExpense.findFirstOrThrow({ where: { id, wbAccountId: account.id } });
  return context.json({ expense });
});

app.delete("/api/expenses/:id", async (context) => {
  const account = await getCurrentAccount(context);
  const result = await prisma.operatingExpense.deleteMany({ where: { id: context.req.param("id"), wbAccountId: account.id } });
  if (result.count === 0) return responseError(context, 404, "Расход не найден.", "expense_not_found");
  return context.json({ ok: true });
});

app.post("/api/wb/token", async (context) => {
  const account = await getCurrentAccount(context);
  const body = z.object({ token: z.string().trim().min(16) }).parse(await context.req.json());
  const result = await saveAndValidateWbToken(account.id, body.token);
  if (!result.ok) {
    const status = result.errorCode === "invalid_token" ? 401 : result.errorCode === "missing_finance_rights" ? 403 : result.errorCode === "rate_limited" ? 429 : result.errorCode === "payment_required" ? 402 : 503;
    return responseError(context, status, result.error || "Не удалось проверить WB API-токен.", result.errorCode || "wb_token_error");
  }
  return context.json({ tokenStatus: result.tokenStatus, last4: result.last4, warning: result.warning, contentStatus: result.contentStatus });
});

app.delete("/api/wb/token", async (context) => {
  const account = await getCurrentAccount(context);
  await prisma.wbAccount.update({
    where: { id: account.id },
    data: { encryptedApiToken: null, tokenStatus: "not_connected", tokenLast4: null, tokenConnectedAt: null }
  });
  return context.json({ ok: true });
});

app.get("/api/wb/reports", async (context) => {
  const account = await getCurrentAccount(context);
  if (!account.encryptedApiToken) throw new WbNotConnectedError();
  const sync = await syncWbReportList(account.id);
  const result = await listReports({ accountId: account.id, syncWb: false });
  return context.json({ reports: result.reports, sync });
});

if (process.env.SMOKE_MODE === "production") {
  app.get("/api/__smoke/unknown", () => {
    throw new Error("production smoke internal marker");
  });
}

app.onError((error, context) => {
  if (error instanceof z.ZodError) {
    return responseError(context, 400, "Проверьте заполнение полей запроса.", "invalid_request");
  }
  if (error instanceof TelegramAuthError) {
    return responseError(context, 401, "Не удалось подтвердить вход через Telegram. Закройте приложение и откройте его заново из бота.", "telegram_auth_required");
  }
  if (error instanceof WbNotConnectedError) {
    return responseError(context, 400, "WB API не подключён.", "wb_not_connected");
  }
  if (error instanceof ReportNotFoundError) {
    return responseError(context, 404, "Отчёт не найден.", "report_not_found");
  }
  if (error instanceof ReportSyncPendingError) {
    return context.json({ syncStatus: error.syncStatus, retryAfterSeconds: error.retryAfterSeconds, message: error.message, requestId: context.get("requestId") }, 202);
  }
  if (error instanceof WbApiError) {
    return responseError(context, wbStatus(error), toUserWbError(error), error.code);
  }

  logRequestError(context, error);
  const message = config.IS_PRODUCTION ? "Внутренняя ошибка сервиса. Попробуйте ещё раз." : "Внутренняя ошибка сервиса. Попробуйте ещё раз.";
  return responseError(context, 500, message, "internal_error");
});

export { app };

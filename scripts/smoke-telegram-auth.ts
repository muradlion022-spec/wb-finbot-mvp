import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.env.SMOKE_MODE || "local";
const botToken = "smoke-test-bot-token";

process.env.BOT_TOKEN = botToken;
process.env.RUST_BACKTRACE = "1";
process.env.RUST_LOG = "trace";

if (mode === "production") {
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/smoke";
  process.env.ENCRYPTION_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.MINI_APP_URL = "https://example.com";
  process.env.TELEGRAM_WEBHOOK_SECRET = "0123456789abcdef";
  process.env.USE_DEMO_DATA = "false";
} else {
  process.env.NODE_ENV = "development";
  process.env.DATABASE_URL = "file:./wb-finbot-telegram-auth-smoke.db";
}

const root = fileURLToPath(new URL("..", import.meta.url));
const prismaCli = fileURLToPath(new URL("../node_modules/prisma/build/index.js", import.meta.url));
execFileSync(process.execPath, [prismaCli, "generate", "--schema", "prisma/schema.sqlite.prisma"], {
  cwd: root,
  env: process.env,
  stdio: "inherit"
});
if (mode !== "production") {
  execFileSync(process.execPath, [prismaCli, "db", "push", "--schema", "prisma/schema.sqlite.prisma", "--skip-generate"], {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
}

const { app } = await import("../src/server/routes.js");
const { createMiniAppSession } = await import("../src/server/telegramAuth.js");

if (mode === "production") {
  const response = await app.request("https://example.com/api/account");
  if (response.status !== 401) {
    throw new Error(`Expected 401 without Telegram initData, got ${response.status}.`);
  }
  console.log("production no-initData: 401");
  const unknown = await app.request("https://example.com/api/__smoke/unknown");
  const unknownBody = (await unknown.json()) as { error?: string; requestId?: string };
  if (unknown.status !== 500 || unknownBody.error !== "Внутренняя ошибка сервиса. Попробуйте ещё раз." || !unknownBody.requestId) {
    throw new Error("Production unknown error leaked implementation details.");
  }
  console.log("production unknown error: safe 500 with requestId");
  process.exit(0);
}

function initDataFor(userId: number) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: "Smoke" })
  });
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secretKey).update(dataCheckString).digest("hex"));
  return params.toString();
}

function requestAs(userId: number, path: string, options: RequestInit = {}) {
  return app.request(`http://localhost${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": initDataFor(userId),
      ...options.headers
    }
  });
}

const ownerId = 987654321;
const otherId = 987654322;
const response = await requestAs(ownerId, "/api/account");
const body = (await response.json()) as { id?: string };
if (response.status !== 200 || body.id !== "telegram-987654321") {
  throw new Error(`Expected Telegram account, got HTTP ${response.status}.`);
}

const browserSessionResponse = await app.request("http://localhost/api/account", {
  headers: { "X-WB-Finbot-Session": createMiniAppSession(ownerId) }
});
const browserSessionBody = (await browserSessionResponse.json()) as { id?: string };
if (browserSessionResponse.status !== 200 || browserSessionBody.id !== "telegram-987654321") {
  throw new Error("Expected the browser Mini App session to resolve the Telegram account.");
}

const miniAppEntryResponse = await app.request(
  `http://localhost/api/telegram/mini-app?session=${encodeURIComponent(createMiniAppSession(ownerId))}`,
  { redirect: "manual" }
);
const miniAppCookie = miniAppEntryResponse.headers.get("set-cookie") || "";
if (
  miniAppEntryResponse.status !== 302 ||
  !miniAppEntryResponse.headers.get("location") ||
  !miniAppCookie.includes("HttpOnly") ||
  !miniAppCookie.includes("Secure")
) {
  throw new Error("Expected the Mini App entry endpoint to set a secure session cookie and redirect.");
}
const cookieOnlyResponse = await app.request("http://localhost/api/account", {
  headers: { Cookie: miniAppCookie.split(";")[0] }
});
const cookieOnlyBody = (await cookieOnlyResponse.json()) as { id?: string };
if (cookieOnlyResponse.status !== 200 || cookieOnlyBody.id !== "telegram-987654321") {
  throw new Error("Expected the Mini App session cookie to resolve the Telegram account.");
}

const expiredSessionResponse = await app.request("http://localhost/api/account", {
  headers: { "X-WB-Finbot-Session": createMiniAppSession(ownerId, Date.now() - 16 * 60 * 1000) }
});
if (expiredSessionResponse.status !== 401) {
  throw new Error("Expected an expired browser Mini App session to be rejected.");
}

const importResponse = await requestAs(ownerId, "/api/reports/import", {
  method: "POST",
  body: JSON.stringify({
    reportId: "auth-smoke-report",
    dateFrom: "2026-07-01",
    dateTo: "2026-07-01",
    lines: [
      {
        nmId: 123456,
        vendorCode: "AUTH-SMOKE",
        quantity: 1,
        retailAmount: 100,
        forPay: 70,
        operationDate: "2026-07-01",
        operationType: "Продажа"
      }
    ]
  })
});
const imported = (await importResponse.json()) as {
  summary?: { id?: string; products?: Array<{ productId?: string }> };
};
const reportId = imported.summary?.id;
const productId = imported.summary?.products?.[0]?.productId;
if (importResponse.status !== 200 || !reportId || !productId) {
  throw new Error("Could not create the ownership smoke-test report.");
}

const foreignReport = await requestAs(otherId, `/api/reports/${reportId}/summary`);
const foreignProduct = await requestAs(otherId, `/api/products/${productId}/cost`, {
  method: "PUT",
  body: JSON.stringify({
    purchaseCost: 1,
    packagingCost: 0,
    fulfillmentCost: 0,
    deliveryToWarehouseCost: 0,
    markingCost: 0,
    otherUnitCost: 0
  })
});

const expenseResponse = await requestAs(ownerId, "/api/expenses", {
  method: "POST",
  body: JSON.stringify({
    title: "Auth smoke expense",
    category: "other",
    amount: 1,
    expenseType: "one_time",
    expenseDate: "2026-07-01",
    allocationMode: "store_level_only"
  })
});
const expense = (await expenseResponse.json()) as { expense?: { id?: string } };
if (expenseResponse.status !== 200 || !expense.expense?.id) {
  throw new Error("Could not create the ownership smoke-test expense.");
}

const foreignExpense = await requestAs(otherId, `/api/expenses/${expense.expense.id}`, {
  method: "DELETE"
});
await requestAs(ownerId, `/api/expenses/${expense.expense.id}`, { method: "DELETE" });

if (foreignReport.status !== 404 || foreignProduct.status !== 404 || foreignExpense.status !== 404) {
  throw new Error("Ownership checks did not reject a foreign account.");
}

console.log("local valid initData and short-lived Mini App session cookie: Telegram account resolved; foreign report/product/expense rejected");

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const prismaCli = fileURLToPath(new URL("../node_modules/prisma/build/index.js", import.meta.url));
const botToken = "wb-sync-safety-bot-token";
process.env.BOT_TOKEN = botToken;
process.env.RUST_BACKTRACE = "1";
process.env.RUST_LOG = "trace";
process.env.NODE_ENV = "development";
process.env.DATABASE_URL = "file:./wb-finbot-sync-safety.db";
process.env.ENCRYPTION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.USE_DEMO_DATA = "false";

function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  return new Promise<{ server: ReturnType<typeof createServer>; baseUrl: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Could not start WB smoke server.");
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

let listStatus = 200;
let detailedMode: "small" | "large" | "by_id_unavailable" = "small";
let financeListCalls = 0;
let financeDetailedCalls = 0;
let contentCardCalls = 0;
let promotionAccess = false;
let promotionCountCalls = 0;

const finance = await listen((req, res) => {
  const send = (status: number, body?: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  if (req.url === "/ping") return send(200, { ok: true });
  if (req.url === "/api/finance/v1/sales-reports/list") {
    financeListCalls += 1;
    if (listStatus !== 200) return send(listStatus, { message: "rate limited" });
    return send(200, [{
      reportId: "stub-report",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-07",
      rowsCount: 1,
      retailAmountSum: "100",
      forPaySum: "70",
      deliveryServiceSum: "0",
      paidStorageSum: "5",
      paidAcceptanceSum: "0",
      deductionSum: "2",
      penaltySum: "1",
      additionalPaymentSum: "0",
      bankPaymentSum: "62"
    }]);
  }
  if (req.url?.startsWith("/api/finance/v1/sales-reports/detailed/")) {
    financeDetailedCalls += 1;
    if (detailedMode === "by_id_unavailable") {
      return send(404, { message: "report by ID is unavailable for this seller" });
    }
    if (detailedMode === "large") {
      return send(
        200,
        Array.from({ length: 100_000 }, (_, index) => ({
          reportId: "large-report",
          rrdId: String(index + 1),
          nmId: "100200300",
          vendorCode: "LARGE-ROW",
          sellerOperName: "Продажа",
          quantity: "1",
          retailAmount: "10",
          forPay: "7"
        }))
      );
    }
    return send(200, [{ reportId: "stub-report", rrdId: "1", nmId: "100200300", vendorCode: "STUB-42", sellerOperName: "Продажа", quantity: "1", retailAmount: "100", forPay: "70" }]);
  }
  if (req.url === "/api/finance/v1/sales-reports/detailed") {
    financeDetailedCalls += 1;
    return send(200, [
      { reportId: "stub-report", rrdId: "1", nmId: "100200300", vendorCode: "STUB-42", sellerOperName: "Продажа", quantity: "1", retailAmount: "100", forPay: "70" },
      { reportId: "another-report", rrdId: "2", nmId: "100200301", vendorCode: "OTHER-42", sellerOperName: "Продажа", quantity: "1", retailAmount: "200", forPay: "140" }
    ]);
  }
  send(404, { message: "not found" });
});

const content = await listen((req, res) => {
  if (req.url === "/ping") {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "content rights missing" }));
    return;
  }
  if (req.url === "/content/v2/get/cards/list") {
    contentCardCalls += 1;
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "content unavailable" }));
    return;
  }
  res.writeHead(404).end();
});

const promotion = await listen((req, res) => {
  const send = (status: number, body?: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  if (req.url === "/ping") {
    return promotionAccess
      ? send(200, { ok: true })
      : send(403, { message: "promotion rights missing" });
  }
  if (req.url === "/adv/v1/promotion/count") {
    promotionCountCalls += 1;
    return promotionAccess
      ? send(200, { adverts: [{ status: 9, advert_list: [{ advertId: 101 }] }] })
      : send(403, { message: "promotion rights missing" });
  }
  if (req.url?.startsWith("/adv/v3/fullstats")) {
    const date = new URL(req.url, "http://promotion.local").searchParams.get("beginDate") ?? "2026-07-03";
    return promotionAccess
      ? send(200, [{ days: [{ date, apps: [{ nms: [{ nmId: 100200300, sum: 12.34 }] }] }] }])
      : send(403, { message: "promotion rights missing" });
  }
  send(404, { message: "not found" });
});

process.env.WB_FINANCE_API_BASE_URL = finance.baseUrl;
process.env.WB_CONTENT_API_BASE_URL = content.baseUrl;
process.env.WB_PROMOTION_API_BASE_URL = promotion.baseUrl;
execFileSync(process.execPath, [prismaCli, "generate", "--schema", "prisma/schema.sqlite.prisma"], { cwd: root, env: process.env, stdio: "inherit" });
execFileSync(process.execPath, [prismaCli, "db", "push", "--schema", "prisma/schema.sqlite.prisma", "--skip-generate"], { cwd: root, env: process.env, stdio: "inherit" });

const { prisma } = await import("../src/server/db.js");
const { getOrCreateTelegramAccount } = await import("../src/server/defaults.js");
const { saveAndValidateWbToken } = await import("../src/server/wbToken.js");
const { ensureReportLoaded, enrichReportProducts, importReport, listReports } = await import("../src/server/reports.js");
const { calculateCombinedReportSummary, calculateReportSummary } = await import("../src/server/calculations.js");
const { WbClient } = await import("../src/server/wbClient.js");
const { app } = await import("../src/server/routes.js");

await prisma.$transaction([
  prisma.financialReportLine.deleteMany(),
  prisma.productCost.deleteMany(),
  prisma.financialReport.deleteMany(),
  prisma.product.deleteMany(),
  prisma.operatingExpense.deleteMany(),
  prisma.wbSyncState.deleteMany(),
  prisma.wbAccount.deleteMany(),
  prisma.user.deleteMany()
]);

function initDataFor(userId: number) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "Safety" }) });
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(dataCheckString).digest("hex"));
  return params.toString();
}

function requestAs(userId: number, path: string, options: RequestInit = {}) {
  return app.request(`http://localhost${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Telegram-Init-Data": initDataFor(userId), ...options.headers }
  });
}

try {
  const account = await getOrCreateTelegramAccount({ telegramId: 710001, firstName: "Finance only" });
  const saved = await saveAndValidateWbToken(account.id, "finance-only-token-1234567890");
  assert.equal(saved.ok, true);
  assert.equal(saved.tokenStatus, "valid");
  assert.equal(saved.contentStatus, "unavailable");
  assert.equal(saved.promotionStatus, "unavailable");
  assert.match(saved.warning ?? "", /нет доступа к карточкам товаров/);
  assert.match(saved.warning ?? "", /Нет доступа к категории Продвижение/);
  console.log("finance-only token: saved with optional Content and Promotion warnings");

  const firstList = await listReports({ accountId: account.id, syncWb: true });
  assert.equal(firstList.reports.length, 1);
  assert.equal(financeListCalls, 1);
  const secondList = await listReports({ accountId: account.id, syncWb: true });
  assert.equal(secondList.reports.length, 1);
  assert.equal(secondList.sync.cacheHit, true);
  assert.equal(financeListCalls, 1);
  console.log("report list cooldown: second open used database cache without WB request");

  const loaded = await ensureReportLoaded(firstList.reports[0].id, { accountId: account.id });
  await prisma.promotionSpendDaily.create({
    data: {
      wbAccountId: account.id,
      date: new Date("2026-07-03T00:00:00.000Z"),
      nmId: 100200300,
      amount: 999
    }
  });
  await prisma.wbSyncState.create({
    data: {
      wbAccountId: account.id,
      endpointType: "promotion:2026-07-01:2026-07-07",
      status: "failed",
      lastErrorCode: "missing_promotion_rights"
    }
  });
  const summary = await calculateReportSummary(loaded.report.id, account.id);
  assert.equal(summary.forPay, 62);
  assert.equal(summary.storage, 5);
  assert.equal(summary.otherDeductions, 2);
  assert.equal(summary.penalties, 1);
  assert.equal(summary.promotionStatus, "missing_rights");
  assert.equal(summary.adSpend, null);
  assert.equal(await prisma.promotionSpendDaily.count({ where: { wbAccountId: account.id } }), 0);
  assert.equal(await prisma.wbSyncState.count({
    where: { wbAccountId: account.id, endpointType: { startsWith: "promotion:" } }
  }), 0);
  assert.equal(financeDetailedCalls, 1);
  const enrichment = await enrichReportProducts(loaded.report.id, account.id);
  assert.equal(enrichment.status, "failed_optional");
  assert.equal((await calculateReportSummary(loaded.report.id, account.id)).forPay, 62);
  assert.equal(contentCardCalls, 1);
  console.log("content failure: finance summary remains available with vendorCode and nmId");

  promotionAccess = true;
  const replacement = await saveAndValidateWbToken(account.id, "replacement-token-with-promotion-1234564321");
  assert.equal(replacement.ok, true);
  assert.equal(replacement.last4, "4321");
  assert.equal(replacement.promotionStatus, "valid");
  assert.equal(await prisma.wbSyncState.count({ where: { wbAccountId: account.id } }), 0);
  assert.equal(await prisma.promotionSpendDaily.count({ where: { wbAccountId: account.id } }), 0);
  const refreshedList = await listReports({ accountId: account.id, syncWb: true });
  assert.equal(refreshedList.sync.cacheHit, false);
  assert.equal(financeListCalls, 2);
  const promotedSummary = await calculateReportSummary(loaded.report.id, account.id);
  assert.equal(promotedSummary.promotionStatus, "ready");
  assert.equal(promotedSummary.adSpend, 12.34);
  assert.equal(promotedSummary.products[0]?.adSpend, 12.34);
  assert.equal(promotionCountCalls, 2);
  console.log("WB token replacement: old caches cleared and Promotion reloaded with the new token");
  await prisma.$transaction([
    prisma.promotionSpendDaily.deleteMany({ where: { wbAccountId: account.id } }),
    prisma.wbSyncState.deleteMany({
      where: { wbAccountId: account.id, endpointType: { startsWith: "promotion-v2:" } }
    })
  ]);

  const wbReferenceReport = await importReport(
    {
      reportId: "772198476-reference",
      dateFrom: "2026-06-29",
      dateTo: "2026-07-05",
      source: "wb",
      lines: [
        { nmId: 439778726, vendorCode: "REFERENCE-42", docTypeName: "Продажа", quantity: 1225, retailAmount: 1009077.63, forPay: 882097.82 },
        { nmId: 439778726, vendorCode: "REFERENCE-42", docTypeName: "Возврат", quantity: 67, retailAmount: 58430.91, forPay: 49547.16 },
        { nmId: 439778726, vendorCode: "REFERENCE-42", sellerOperName: "Возмещение издержек по перевозке/по складским операциям с товаром", quantity: 17620 },
        { nmId: 439778726, vendorCode: "REFERENCE-42", sellerOperName: "Логистика", deliveryService: 263373.05 },
        { nmId: 0, sellerOperName: "Хранение", paidStorage: 4663.97 },
        { nmId: 0, sellerOperName: "Удержание", deduction: 25220 },
        { nmId: 439778726, vendorCode: "REFERENCE-42", sellerOperName: "Штраф", penalty: 80 }
      ]
    },
    { accountId: account.id, source: "wb" }
  );
  const wbReferenceSummary = await calculateReportSummary(wbReferenceReport.id, account.id);
  assert.equal(wbReferenceSummary.revenue, 950646.72);
  assert.equal(wbReferenceSummary.goodsForPay, 832550.66);
  assert.equal(wbReferenceSummary.wbCommission, 118096.06);
  assert.equal(wbReferenceSummary.forPay, 539213.64);
  assert.equal(wbReferenceSummary.wbExpenses, 293337.02);
  assert.equal(wbReferenceSummary.products[0]?.unitsSold, 1225);
  assert.equal(wbReferenceSummary.products[0]?.returns, 67);
  assert.equal(wbReferenceSummary.deductions.find((item) => item.type === "Хранение")?.amount, 4663.97);
  assert.equal(wbReferenceSummary.deductions.find((item) => item.type === "Прочие удержания")?.amount, 25220);
  assert.equal(wbReferenceSummary.logistics, 263373.05);
  assert.equal(wbReferenceSummary.storage, 4663.97);
  assert.equal(wbReferenceSummary.otherDeductions, 25220);
  assert.equal(wbReferenceSummary.penalties, 80);

  await prisma.$transaction([
    prisma.promotionSpendDaily.deleteMany({ where: { wbAccountId: account.id } }),
    prisma.wbSyncState.deleteMany({
      where: { wbAccountId: account.id, endpointType: { startsWith: "promotion-v2:" } }
    })
  ]);

  const referenceProduct = wbReferenceSummary.products[0];
  assert.ok(referenceProduct);
  await prisma.promotionSpendDaily.create({
    data: {
      wbAccountId: account.id,
      date: new Date("2026-07-01T00:00:00.000Z"),
      nmId: referenceProduct.nmId,
      amount: 95064.67
    }
  });
  await prisma.wbSyncState.upsert({
    where: {
      wbAccountId_endpointType: {
        wbAccountId: account.id,
        endpointType: "promotion-v2:2026-06-29:2026-07-05"
      }
    },
    create: {
      wbAccountId: account.id,
      endpointType: "promotion-v2:2026-06-29:2026-07-05",
      status: "ready",
      lastSuccessAt: new Date()
    },
    update: { status: "ready", lastSuccessAt: new Date(), lastErrorCode: null }
  });
  const promotedReferenceSummary = await calculateReportSummary(wbReferenceReport.id, account.id);
  assert.equal(promotedReferenceSummary.promotionStatus, "ready");
  assert.equal(promotedReferenceSummary.adSpend, 95064.67);
  assert.equal(promotedReferenceSummary.drr, 10);
  assert.equal(promotedReferenceSummary.products[0]?.adSpend, 95064.67);
  assert.equal(promotedReferenceSummary.products[0]?.drr, 10);
  await prisma.productCost.create({
    data: {
      productId: referenceProduct.productId,
      purchaseCost: 100,
      packagingCost: 500,
      markingCost: 500,
      otherUnitCost: 500,
      totalUnitCost: 1600
    }
  });
  await prisma.operatingExpense.create({
    data: {
      wbAccountId: account.id,
      title: "Reference expense",
      category: "services",
      amount: 1000,
      expenseType: "one_time",
      recurrenceType: "none",
      expenseDate: new Date("2026-07-01"),
      allocationMode: "store_level_only"
    }
  });
  await prisma.wbAccount.update({ where: { id: account.id }, data: { taxMode: "usn_income_6" } });
  const taxedReferenceSummary = await calculateReportSummary(wbReferenceReport.id, account.id);
  assert.equal(taxedReferenceSummary.productCost, 115800);
  assert.equal(taxedReferenceSummary.operatingExpenses, 1000);
  assert.equal(taxedReferenceSummary.tax, 57038.8);
  assert.equal(taxedReferenceSummary.profitBeforeTax, 422413.64);
  assert.equal(taxedReferenceSummary.finalProfit, 365374.84);
  assert.equal(taxedReferenceSummary.margin, 38.4);
  assert.equal(taxedReferenceSummary.roi, 315.5);
  await prisma.wbAccount.update({ where: { id: account.id }, data: { taxMode: "usn_profit_5" } });
  const profitTaxReferenceSummary = await calculateReportSummary(wbReferenceReport.id, account.id);
  assert.equal(profitTaxReferenceSummary.tax, 21120.68);
  assert.equal(profitTaxReferenceSummary.finalProfit, 401292.96);
  assert.equal(profitTaxReferenceSummary.margin, 42.2);
  assert.equal(profitTaxReferenceSummary.roi, 346.5);
  await prisma.wbAccount.update({ where: { id: account.id }, data: { taxMode: "none" } });
  console.log("WB report 772198476: sales, payout, costs, tax, margin and ROI reconciled");

  const historicalFirst = await importReport(
    {
      reportId: "historical-cost-first",
      dateFrom: "2026-07-08",
      dateTo: "2026-07-14",
      source: "wb",
      lines: [{
        nmId: 880077,
        vendorCode: "HISTORY-42",
        operationType: "Продажа",
        operationDate: "2026-07-10",
        quantity: 2,
        retailAmount: 400,
        forPay: 300
      }]
    },
    { accountId: account.id, source: "wb" }
  );
  const historicalSecond = await importReport(
    {
      reportId: "historical-cost-second",
      dateFrom: "2026-07-15",
      dateTo: "2026-07-21",
      source: "wb",
      lines: [{
        nmId: 880077,
        vendorCode: "HISTORY-42",
        operationType: "Продажа",
        operationDate: "2026-07-20",
        quantity: 2,
        retailAmount: 400,
        forPay: 300
      }]
    },
    { accountId: account.id, source: "wb" }
  );
  const historicalProduct = await prisma.product.findUniqueOrThrow({
    where: { wbAccountId_nmId: { wbAccountId: account.id, nmId: 880077 } }
  });
  await prisma.productCost.createMany({
    data: [
      {
        productId: historicalProduct.id,
        purchaseCost: 100,
        totalUnitCost: 100,
        validFrom: new Date("2026-07-01T00:00:00.000Z"),
        validTo: new Date("2026-07-15T00:00:00.000Z")
      },
      {
        productId: historicalProduct.id,
        purchaseCost: 150,
        totalUnitCost: 150,
        validFrom: new Date("2026-07-15T00:00:00.000Z")
      }
    ]
  });
  await prisma.operatingExpense.create({
    data: {
      wbAccountId: account.id,
      title: "Combined reports expense",
      category: "services",
      amount: 50,
      expenseType: "one_time",
      recurrenceType: "none",
      expenseDate: new Date("2026-07-10T00:00:00.000Z"),
      allocationMode: "store_level_only"
    }
  });
  const historicalFirstSummary = await calculateReportSummary(historicalFirst.id, account.id);
  const historicalSecondSummary = await calculateReportSummary(historicalSecond.id, account.id);
  const historicalCombined = await calculateCombinedReportSummary([historicalFirst.id, historicalSecond.id], account.id);
  assert.equal(historicalFirstSummary.productCost, 200);
  assert.equal(historicalSecondSummary.productCost, 300);
  assert.equal(historicalCombined.productCost, 500);
  assert.equal(historicalCombined.operatingExpenses, 50);
  assert.equal(historicalCombined.finalProfit, 50);
  assert.equal(historicalCombined.reportCount, 2);
  const combinedResponse = await requestAs(710001, "/api/reports/combined-summary", {
    method: "POST",
    body: JSON.stringify({ reportIds: [historicalFirst.id, historicalSecond.id] })
  });
  const combinedBody = (await combinedResponse.json()) as { productCost?: number; operatingExpenses?: number; reportCount?: number };
  assert.equal(combinedResponse.status, 200);
  assert.equal(combinedBody.productCost, 500);
  assert.equal(combinedBody.operatingExpenses, 50);
  assert.equal(combinedBody.reportCount, 2);
  const combinedProductResponse = await requestAs(710001, "/api/reports/combined/products/880077", {
    method: "POST",
    body: JSON.stringify({ reportIds: [historicalFirst.id, historicalSecond.id] })
  });
  const combinedProductBody = (await combinedProductResponse.json()) as {
    product?: { productCost?: number };
    lines?: unknown[];
    byDay?: unknown[];
    bySize?: Array<{ days?: unknown[] }>;
  };
  assert.equal(combinedProductResponse.status, 200);
  assert.equal(combinedProductBody.product?.productCost, 500);
  assert.equal("lines" in combinedProductBody, false);
  assert.equal(combinedProductBody.byDay?.length, 2);
  assert.equal(combinedProductBody.bySize?.[0]?.days?.length, 2);
  console.log("historical costs and combined reports: dated prices applied and operating expense counted once");

  await prisma.wbAccount.update({ where: { id: account.id }, data: { reportsSyncedAt: new Date(Date.now() - 70_000) } });
  await prisma.wbSyncState.update({
    where: { wbAccountId_endpointType: { wbAccountId: account.id, endpointType: "sales-reports-list" } },
    data: { cooldownUntil: null, lockedAt: null }
  });
  listStatus = 429;
  const rateLimited = await listReports({ accountId: account.id, syncWb: true });
  assert.equal(rateLimited.sync.status, "rate_limited");
  assert.ok(rateLimited.reports.some((report) => report.reportId === "stub-report"));
  console.log("WB 429: saved report list remained available with cooldown");
  listStatus = 200;

  const stored = await prisma.wbAccount.findUniqueOrThrow({ where: { id: account.id } });
  detailedMode = "large";
  const beforeLarge = financeDetailedCalls;
  const large = await new WbClient(stored.encryptedApiToken!).getReportDetails({ reportId: "large-report", dateFrom: "2026-07-01", dateTo: "2026-07-07", rowsCount: 100_000 });
  assert.equal(large.partial, true);
  assert.equal(large.nextRrdId, "100000");
  assert.equal(financeDetailedCalls - beforeLarge, 1);
  console.log("large report: one detailed WB request, partial status and last rrdId saved for MVP limit");
  const bulkImported = await importReport(
    {
      reportId: "large-import-smoke",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-07",
      source: "wb",
      lines: large.rows.slice(0, 2_500)
    },
    { accountId: account.id, source: "wb" }
  );
  assert.equal(await prisma.financialReportLine.count({ where: { financialReportId: bulkImported.id } }), 2_500);
  console.log("large report persistence: 2,500 repeated-product rows saved in batches");
  detailedMode = "small";

  detailedMode = "by_id_unavailable";
  const beforeFallback = financeDetailedCalls;
  const fallback = await new WbClient(stored.encryptedApiToken!).getReportDetails({
    reportId: "stub-report",
    dateFrom: "2026-07-01",
    dateTo: "2026-07-07",
    rowsCount: 1
  });
  assert.equal(fallback.endpoint, "by_period");
  assert.equal(fallback.rows.length, 1);
  assert.equal(fallback.rows[0]?.reportId, "stub-report");
  assert.equal(financeDetailedCalls - beforeFallback, 2);
  console.log("report details fallback: unavailable by-ID method loaded matching rows by period");
  detailedMode = "small";

  const owner = await requestAs(710001, "/api/account");
  const other = await requestAs(710002, "/api/account");
  const ownerBody = (await owner.json()) as { id: string };
  const otherBody = (await other.json()) as { id: string };
  assert.equal(owner.status, 200);
  assert.equal(other.status, 200);
  assert.notEqual(ownerBody.id, otherBody.id);
  const invalidExpense = await requestAs(710001, "/api/expenses", { method: "POST", body: JSON.stringify({}) });
  const invalidBody = (await invalidExpense.json()) as { code?: string };
  assert.equal(invalidExpense.status, 400);
  assert.equal(invalidBody.code, "invalid_request");
  const internal = await requestAs(710001, "/api/reports/import", { method: "POST", body: JSON.stringify({ lines: [{ nope: true }] }) });
  const internalBody = (await internal.json()) as { error?: string; requestId?: string };
  assert.equal(internal.status, 500);
  assert.equal(internalBody.error, "Внутренняя ошибка сервиса. Попробуйте ещё раз.");
  assert.ok(internalBody.requestId);
  console.log("account isolation, Zod 400 and safe unknown error: verified");
} finally {
  await prisma.$disconnect();
  await new Promise<void>((resolve) => finance.server.close(() => resolve()));
  await new Promise<void>((resolve) => content.server.close(() => resolve()));
  await new Promise<void>((resolve) => promotion.server.close(() => resolve()));
}

import type { NormalizedReportLineInput, ReportImportPayload } from "../shared/types.js";
import { config } from "./config.js";
import { getOrCreateLocalAccount } from "./defaults.js";
import { prisma } from "./db.js";
import { normalizeReportLines } from "./normalizer.js";
import {
  acquireWbSync,
  completeWbSync,
  failWbSync,
  secondsUntil,
  WB_SYNC_COOLDOWN_MS
} from "./sync.js";
import {
  WbApiError,
  WbClient,
  type WbReportDetailsPage,
  type WbReportListItem,
  type WbReportTotals
} from "./wbClient.js";

export class ReportNotFoundError extends Error {
  constructor() {
    super("Report not found.");
    this.name = "ReportNotFoundError";
  }
}

export class WbNotConnectedError extends Error {
  constructor() {
    super("WB API не подключён.");
    this.name = "WbNotConnectedError";
  }
}

export class ReportSyncPendingError extends Error {
  readonly syncStatus: "loading" | "queued" | "rate_limited";
  readonly retryAfterSeconds: number;

  constructor(syncStatus: "loading" | "queued" | "rate_limited", retryAfterSeconds: number) {
    super("Отчёт загружается. Это может занять некоторое время.");
    this.name = "ReportSyncPendingError";
    this.syncStatus = syncStatus;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type ReportSyncInfo = {
  status: "not_loaded" | "queued" | "loading" | "ready" | "partial" | "rate_limited" | "failed" | "cooldown";
  cacheHit: boolean;
  retryAfterSeconds: number;
  message?: string;
};

type ReportMeta = {
  source?: string;
  loaded?: boolean;
  dateFrom?: string;
  dateTo?: string;
  rowsCount?: number;
  detailsStrategy?: "by_id" | "by_period";
  reportTooLarge?: boolean;
  summaryTotals?: WbReportTotals;
};

function databaseTotals(totals: WbReportTotals) {
  return {
    totalRetailAmount: totals.retailAmountSum,
    totalForPay: totals.forPaySum,
    totalDeliveryService: totals.deliveryServiceSum,
    totalStorage: totals.paidStorageSum,
    totalAcceptance: totals.paidAcceptanceSum,
    totalPenalty: totals.penaltySum,
    totalDeduction: totals.deductionSum,
    totalBankPayment: totals.bankPaymentSum
  };
}

function parseDateOrDefault(value: string | undefined, fallback: Date) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function lineDate(line: NormalizedReportLineInput) {
  if (!line.operationDate) return null;
  const date = new Date(line.operationDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inferPeriod(lines: NormalizedReportLineInput[]) {
  const dates = lines.map(lineDate).filter((date): date is Date => Boolean(date));
  if (dates.length === 0) {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - 6);
    return { dateFrom: start, dateTo: now };
  }
  return {
    dateFrom: new Date(Math.min(...dates.map((date) => date.getTime()))),
    dateTo: new Date(Math.max(...dates.map((date) => date.getTime())))
  };
}

function makeReportTotals(lines: NormalizedReportLineInput[]) {
  return lines.reduce(
    (totals, line) => {
      totals.totalRetailAmount += line.retailAmount;
      totals.totalForPay += line.forPay;
      totals.totalDeliveryService += line.deliveryService;
      totals.totalStorage += line.storageFee;
      totals.totalAcceptance += line.acceptanceFee;
      totals.totalPenalty += line.penalty;
      totals.totalDeduction += line.deduction;
      totals.totalBankPayment +=
        line.forPay -
        line.deliveryService -
        line.storageFee -
        line.acceptanceFee -
        line.penalty -
        line.deduction +
        line.additionalPayment;
      return totals;
    },
    {
      totalRetailAmount: 0,
      totalForPay: 0,
      totalDeliveryService: 0,
      totalStorage: 0,
      totalAcceptance: 0,
      totalPenalty: 0,
      totalDeduction: 0,
      totalBankPayment: 0
    }
  );
}

function parseRawJson(value: string): ReportMeta {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ReportMeta) : {};
  } catch {
    return {};
  }
}

function reportMeta(report: WbReportListItem, detailsStrategy: "by_id" | "by_period", extra: Partial<ReportMeta> = {}) {
  return {
    source: "wb",
    loaded: false,
    dateFrom: report.dateFrom,
    dateTo: report.dateTo,
    rowsCount: report.rowsCount,
    detailsStrategy,
    ...extra,
    summaryTotals: report.totals ?? extra.summaryTotals
  } satisfies ReportMeta;
}

function reportIdFromRow(row: Record<string, unknown>) {
  const value = row.reportId ?? row.realizationReportId ?? row.realizationreport_id;
  return value === undefined || value === null || value === "" ? null : String(value);
}

function partialMessage() {
  return "Загружена часть большого отчёта. В MVP продолжение после первой страницы до 100 000 строк недоступно.";
}

function cooldownMessage(seconds: number) {
  return `Wildberries временно ограничил частоту запросов. Повторное обновление будет доступно через ${seconds} с.`;
}

export async function importReport(
  payload: ReportImportPayload,
  options: {
    accountId?: string;
    source?: "local_import" | "demo" | "wb";
    createdAtWb?: Date | null;
    meta?: ReportMeta;
    syncStatus?: "ready" | "partial";
    detailsSyncedAt?: Date | null;
    lastRrdId?: string | null;
    contentEnrichmentStatus?: "not_started" | "loading" | "ready" | "failed_optional";
  } = {}
) {
  const account = options.accountId
    ? await prisma.wbAccount.findUniqueOrThrow({ where: { id: options.accountId } })
    : await getOrCreateLocalAccount();
  const lines = normalizeReportLines(payload.lines);
  if (lines.length === 0) throw new Error("Не найдено строк отчета с nmId или артикулом.");

  const inferredPeriod = inferPeriod(lines);
  const dateFrom = parseDateOrDefault(payload.dateFrom, inferredPeriod.dateFrom);
  const dateTo = parseDateOrDefault(payload.dateTo, inferredPeriod.dateTo);
  const reportId = payload.reportId || `local-${dateFrom.toISOString().slice(0, 10)}-${dateTo.toISOString().slice(0, 10)}`;
  const totals = options.meta?.summaryTotals
    ? databaseTotals(options.meta.summaryTotals)
    : makeReportTotals(lines);
  const source = options.source ?? payload.source ?? "local_import";
  const metadata: ReportMeta = options.meta ?? { source, loaded: true };
  const productLines = new Map<number, NormalizedReportLineInput>();
  for (const line of lines) {
    if (line.nmId > 0 && !productLines.has(line.nmId)) productLines.set(line.nmId, line);
  }

  return prisma.$transaction(async (tx) => {
    const report = await tx.financialReport.upsert({
      where: { wbAccountId_reportId: { wbAccountId: account.id, reportId } },
      create: {
        wbAccountId: account.id,
        reportId,
        dateFrom,
        dateTo,
        createdAtWb: options.createdAtWb ?? new Date(),
        rawJson: JSON.stringify({ ...metadata, source, loaded: true }),
        syncStatus: options.syncStatus ?? "ready",
        detailsSyncedAt: options.detailsSyncedAt ?? null,
        lastRrdId: options.lastRrdId ?? null,
        contentEnrichmentStatus: options.contentEnrichmentStatus ?? "not_started",
        ...totals
      },
      update: {
        dateFrom,
        dateTo,
        createdAtWb: options.createdAtWb ?? new Date(),
        rawJson: JSON.stringify({ ...metadata, source, loaded: true }),
        syncStatus: options.syncStatus ?? "ready",
        detailsSyncedAt: options.detailsSyncedAt ?? undefined,
        lastRrdId: options.lastRrdId ?? undefined,
        contentEnrichmentStatus: options.contentEnrichmentStatus ?? undefined,
        contentEnrichmentError: null,
        ...totals
      }
    });

    await tx.financialReportLine.deleteMany({ where: { financialReportId: report.id } });
    const productIds = new Map<number, string>();
    for (const line of productLines.values()) {
      const product = await tx.product.upsert({
        where: { wbAccountId_nmId: { wbAccountId: account.id, nmId: line.nmId } },
        create: {
          wbAccountId: account.id,
          nmId: line.nmId,
          vendorCode: line.vendorCode,
          title: typeof line.raw.title === "string" ? line.raw.title : typeof line.raw.subject === "string" ? line.raw.subject : null,
          brand: typeof line.raw.brandName === "string" ? line.raw.brandName : typeof line.raw.brand === "string" ? line.raw.brand : null,
          subjectName: typeof line.raw.subjectName === "string" ? line.raw.subjectName : null,
          photoUrl: typeof line.raw.photoUrl === "string" ? line.raw.photoUrl : null
        },
        update: {
          vendorCode: line.vendorCode,
          title: typeof line.raw.title === "string" ? line.raw.title : typeof line.raw.subject === "string" ? line.raw.subject : undefined,
          brand: typeof line.raw.brandName === "string" ? line.raw.brandName : typeof line.raw.brand === "string" ? line.raw.brand : undefined,
          subjectName: typeof line.raw.subjectName === "string" ? line.raw.subjectName : undefined,
          photoUrl: typeof line.raw.photoUrl === "string" ? line.raw.photoUrl : undefined
        }
      });
      productIds.set(line.nmId, product.id);
    }

    const lineRows = lines.map((line) => {
      const productId = productIds.get(line.nmId);
      if (line.nmId > 0 && !productId) throw new Error("Не удалось связать строку отчёта с товаром.");
      return {
          financialReportId: report.id,
          productId: productId ?? null,
          nmId: line.nmId,
          vendorCode: line.vendorCode,
          barcode: line.barcode,
          size: line.size,
          operationDate: lineDate(line),
          operationType: line.operationType,
          quantity: line.quantity,
          retailAmount: line.retailAmount,
          forPay: line.forPay,
          commission: line.commission,
          deliveryService: line.deliveryService,
          storageFee: line.storageFee,
          acceptanceFee: line.acceptanceFee,
          penalty: line.penalty,
          deduction: line.deduction,
          additionalPayment: line.additionalPayment,
          rawJson: JSON.stringify(line.raw)
      };
    });

    const batchSize = 500;
    for (let index = 0; index < lineRows.length; index += batchSize) {
      await tx.financialReportLine.createMany({ data: lineRows.slice(index, index + batchSize) });
    }
    return report;
  }, { maxWait: 5_000, timeout: 30_000 });
}

async function reportListRows(accountId: string) {
  return prisma.financialReport.findMany({
    where: {
      wbAccountId: accountId,
      ...(config.USE_DEMO_DATA ? {} : { reportId: { not: { startsWith: "demo-" } } })
    },
    orderBy: { dateFrom: "desc" },
    select: {
      id: true,
      reportId: true,
      dateFrom: true,
      dateTo: true,
      totalRetailAmount: true,
      totalForPay: true,
      updatedAt: true,
      syncStatus: true,
      detailsSyncedAt: true,
      contentEnrichmentStatus: true
    }
  });
}

async function importPeriodPage(accountId: string, reports: WbReportListItem[], page: WbReportDetailsPage) {
  const linesByReport = new Map<string, Record<string, unknown>[]>();
  for (const line of page.rows) {
    const reportId = reportIdFromRow(line);
    if (!reportId) continue;
    const group = linesByReport.get(reportId) ?? [];
    group.push(line);
    linesByReport.set(reportId, group);
  }

  for (const report of reports) {
    const lines = linesByReport.get(report.reportId);
    if (!lines?.length) continue;
    await importReport(
      {
        reportId: report.reportId,
        dateFrom: report.dateFrom,
        dateTo: report.dateTo,
        source: "wb",
        lines
      },
      {
        accountId,
        source: "wb",
        createdAtWb: report.createdAtWb ? new Date(report.createdAtWb) : null,
        meta: reportMeta(report, "by_period", { loaded: true, reportTooLarge: page.partial }),
        syncStatus: page.partial ? "partial" : "ready",
        detailsSyncedAt: new Date(),
        lastRrdId: page.nextRrdId
      }
    );
  }
}

export async function syncWbReportList(accountId: string): Promise<ReportSyncInfo> {
  const account = await prisma.wbAccount.findUniqueOrThrow({ where: { id: accountId } });
  if (!account.encryptedApiToken) throw new WbNotConnectedError();

  const lease = await acquireWbSync(accountId, "sales-reports-list");
  if (!lease.acquired) {
    return {
      status: lease.status === "loading" ? "loading" : "cooldown",
      cacheHit: true,
      retryAfterSeconds: lease.retryAfterSeconds,
      message: lease.status === "loading" ? "Список отчётов уже синхронизируется." : cooldownMessage(lease.retryAfterSeconds)
    };
  }

  try {
    const client = new WbClient(account.encryptedApiToken);
    const result = await client.listReports();
    if (result.source === "period" && result.periodPage) {
      await importPeriodPage(accountId, result.reports, result.periodPage);
    } else {
      for (const report of result.reports) {
        const existing = await prisma.financialReport.findUnique({
          where: { wbAccountId_reportId: { wbAccountId: accountId, reportId: report.reportId } },
          include: { _count: { select: { lines: true } } }
        });
        const existingMeta = existing ? parseRawJson(existing.rawJson) : {};
        const metadata = reportMeta(report, "by_id", {
          ...existingMeta,
          loaded: Boolean(existingMeta.loaded && existing?._count.lines)
        });
        await prisma.financialReport.upsert({
          where: { wbAccountId_reportId: { wbAccountId: accountId, reportId: report.reportId } },
          create: {
            wbAccountId: accountId,
            reportId: report.reportId,
            dateFrom: new Date(report.dateFrom),
            dateTo: new Date(report.dateTo),
            createdAtWb: report.createdAtWb ? new Date(report.createdAtWb) : null,
            rawJson: JSON.stringify(metadata),
            ...(report.totals ? databaseTotals(report.totals) : {})
          },
          update: {
            dateFrom: new Date(report.dateFrom),
            dateTo: new Date(report.dateTo),
            createdAtWb: report.createdAtWb ? new Date(report.createdAtWb) : undefined,
            rawJson: JSON.stringify(metadata),
            ...(report.totals ? databaseTotals(report.totals) : {})
          }
        });
      }
    }

    const completed = await completeWbSync(accountId, "sales-reports-list");
    await prisma.wbAccount.update({
      where: { id: accountId },
      data: { reportsSyncedAt: completed.completedAt, reportsSyncError: null }
    });
    return { status: "ready", cacheHit: false, retryAfterSeconds: secondsUntil(completed.cooldownUntil) };
  } catch (error) {
    const errorCode = error instanceof WbApiError ? error.code : "sync_error";
    const failed = await failWbSync(accountId, "sales-reports-list", errorCode);
    await prisma.wbAccount.update({
      where: { id: accountId },
      data: { reportsSyncError: errorCode }
    });
    throw error;
  }
}

export async function listReports(options: { accountId?: string; syncWb?: boolean } = {}) {
  const account = options.accountId
    ? await prisma.wbAccount.findUniqueOrThrow({ where: { id: options.accountId } })
    : await getOrCreateLocalAccount();
  let reports = await reportListRows(account.id);
  const shouldSync = !config.USE_DEMO_DATA && options.syncWb !== false && account.encryptedApiToken && account.tokenStatus === "valid";

  if (!shouldSync) {
    return { reports, sync: { status: "ready", cacheHit: true, retryAfterSeconds: 0 } satisfies ReportSyncInfo };
  }

  const syncedRecently = account.reportsSyncedAt && Date.now() - account.reportsSyncedAt.getTime() < WB_SYNC_COOLDOWN_MS;
  if (syncedRecently && account.reportsSyncedAt) {
    return {
      reports,
      sync: {
        status: "ready",
        cacheHit: true,
        retryAfterSeconds: secondsUntil(new Date(account.reportsSyncedAt.getTime() + WB_SYNC_COOLDOWN_MS))
      } satisfies ReportSyncInfo
    };
  }

  try {
    const sync = await syncWbReportList(account.id);
    reports = await reportListRows(account.id);
    return { reports, sync };
  } catch (error) {
    if (error instanceof WbApiError && error.code === "rate_limited" && reports.length > 0) {
      return {
        reports,
        sync: {
          status: "rate_limited",
          cacheHit: true,
          retryAfterSeconds: 65,
          message: "Wildberries временно ограничил частоту запросов. Сохранённые данные доступны, обновление можно повторить позже."
        } satisfies ReportSyncInfo
      };
    }
    throw error;
  }
}

async function findReport(reportDbId: string, accountId: string) {
  const report = await prisma.financialReport.findFirst({
    where: { id: reportDbId, wbAccountId: accountId },
    include: { wbAccount: true, _count: { select: { lines: true } } }
  });
  if (!report) throw new ReportNotFoundError();
  return report;
}

export async function ensureReportLoaded(reportDbId: string, options: { accountId: string; force?: boolean }) {
  const report = await findReport(reportDbId, options.accountId);
  const raw = parseRawJson(report.rawJson);
  const localResult = (sync: ReportSyncInfo) => ({ report, sync });

  if (raw.source !== "wb") return localResult({ status: "ready", cacheHit: true, retryAfterSeconds: 0 });
  if (report.syncStatus === "partial" && report._count.lines > 0) {
    return localResult({ status: "partial", cacheHit: true, retryAfterSeconds: 0, message: partialMessage() });
  }
  if (!options.force && report._count.lines > 0 && raw.loaded) {
    return localResult({ status: "ready", cacheHit: true, retryAfterSeconds: 0 });
  }
  if (!report.wbAccount.encryptedApiToken) throw new WbNotConnectedError();

  const lease = await acquireWbSync(report.wbAccountId, "sales-reports-detailed");
  if (!lease.acquired) {
    if (report._count.lines > 0) {
      return localResult({
        status: lease.status === "loading" ? "loading" : "cooldown",
        cacheHit: true,
        retryAfterSeconds: lease.retryAfterSeconds,
        message: lease.status === "loading" ? "Отчёт уже загружается." : cooldownMessage(lease.retryAfterSeconds)
      });
    }
    throw new ReportSyncPendingError(lease.status === "loading" ? "loading" : "rate_limited", lease.retryAfterSeconds);
  }

  try {
    const client = new WbClient(report.wbAccount.encryptedApiToken);
    const details = await client.getReportDetails({
      reportId: report.reportId,
      dateFrom: raw.dateFrom || report.dateFrom.toISOString().slice(0, 10),
      dateTo: raw.dateTo || report.dateTo.toISOString().slice(0, 10),
      createdAtWb: report.createdAtWb?.toISOString(),
      rowsCount: 0
    });
    if (details.rows.length === 0) throw new WbApiError("no_reports", "В финансовом отчёте нет строк.");

    const savedReport = await importReport(
      {
        reportId: report.reportId,
        dateFrom: raw.dateFrom || report.dateFrom.toISOString().slice(0, 10),
        dateTo: raw.dateTo || report.dateTo.toISOString().slice(0, 10),
        source: "wb",
        lines: details.rows
      },
      {
        accountId: report.wbAccountId,
        source: "wb",
        createdAtWb: report.createdAtWb,
        meta: {
          ...raw,
          source: "wb",
          loaded: true,
          detailsStrategy: details.endpoint,
          reportTooLarge: details.partial
        },
        syncStatus: details.partial ? "partial" : "ready",
        detailsSyncedAt: new Date(),
        lastRrdId: details.nextRrdId
      }
    );
    const completed = await completeWbSync(report.wbAccountId, "sales-reports-detailed");
    return {
      report: savedReport,
      sync: {
        status: details.partial ? "partial" : "ready",
        cacheHit: false,
        retryAfterSeconds: secondsUntil(completed.cooldownUntil),
        message: details.partial ? partialMessage() : undefined
      } satisfies ReportSyncInfo
    };
  } catch (error) {
    const errorCode = error instanceof WbApiError ? error.code : "sync_error";
    const failed = await failWbSync(report.wbAccountId, "sales-reports-detailed", errorCode);
    await prisma.financialReport.update({
      where: { id: report.id },
      data: { syncStatus: errorCode === "rate_limited" ? "rate_limited" : "failed" }
    });
    if (errorCode === "rate_limited" && report._count.lines > 0) {
      return localResult({
        status: "rate_limited",
        cacheHit: true,
        retryAfterSeconds: failed.retryAfterSeconds,
        message: cooldownMessage(failed.retryAfterSeconds)
      });
    }
    throw error;
  }
}

export async function enrichReportProducts(reportDbId: string, accountId: string) {
  const report = await prisma.financialReport.findFirst({
    where: { id: reportDbId, wbAccountId: accountId },
    include: { wbAccount: true, lines: { select: { nmId: true } } }
  });
  if (!report) throw new ReportNotFoundError();
  if (!report.wbAccount.encryptedApiToken) {
    await prisma.financialReport.update({
      where: { id: report.id },
      data: { contentEnrichmentStatus: "failed_optional", contentEnrichmentError: "wb_not_connected" }
    });
    return { status: "failed_optional", warning: "Финансы сохранены. WB API-токен не подключён для карточек товаров." };
  }

  const lease = await acquireWbSync(accountId, "content-cards");
  if (!lease.acquired) {
    return {
      status: lease.status === "loading" ? "loading" : "failed_optional",
      warning: lease.status === "loading" ? "Карточки товаров уже обновляются." : cooldownMessage(lease.retryAfterSeconds),
      retryAfterSeconds: lease.retryAfterSeconds
    };
  }

  await prisma.financialReport.update({
    where: { id: report.id },
    data: { contentEnrichmentStatus: "loading", contentEnrichmentError: null }
  });

  try {
    const cards = await new WbClient(report.wbAccount.encryptedApiToken).getProductCards(
      [...new Set(report.lines.map((line) => line.nmId).filter((nmId) => nmId > 0))]
    );
    for (const card of cards) {
      await prisma.product.updateMany({
        where: { wbAccountId: accountId, nmId: card.nmId },
        data: {
          vendorCode: card.vendorCode,
          title: card.title,
          brand: card.brand,
          subjectName: card.subjectName,
          photoUrl: card.photoUrl
        }
      });
    }
    await completeWbSync(accountId, "content-cards");
    await prisma.financialReport.update({
      where: { id: report.id },
      data: { contentEnrichmentStatus: "ready", contentEnrichmentError: null }
    });
    return { status: "ready" };
  } catch (error) {
    const errorCode = error instanceof WbApiError ? error.code : "content_error";
    const failed = await failWbSync(accountId, "content-cards", errorCode);
    await prisma.financialReport.update({
      where: { id: report.id },
      data: { contentEnrichmentStatus: "failed_optional", contentEnrichmentError: errorCode }
    });
    console.warn("[content-enrichment]", { accountId, reportId: report.id, errorCode, retryAfterSeconds: failed.retryAfterSeconds });
    return { status: "failed_optional", warning: "Финансы сохранены, но карточки товаров пока не удалось обновить.", retryAfterSeconds: failed.retryAfterSeconds };
  }
}

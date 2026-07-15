import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { decryptSecret } from "./crypto.js";
import { config } from "./config.js";

export type WbReportTotals = {
  retailAmountSum: number;
  forPaySum: number;
  deliveryServiceSum: number;
  paidStorageSum: number;
  paidAcceptanceSum: number;
  deductionSum: number;
  penaltySum: number;
  additionalPaymentSum: number;
  bankPaymentSum: number;
};

export type WbReportListItem = {
  reportId: string;
  dateFrom: string;
  dateTo: string;
  createdAtWb?: string;
  rowsCount: number;
  totals?: WbReportTotals;
};

export type WbReportDetailsPage = {
  rows: Record<string, unknown>[];
  status: number;
  endpoint: "by_id" | "by_period";
  partial: boolean;
  nextRrdId: string | null;
};

export type WbReportListResult = {
  reports: WbReportListItem[];
  source: "list" | "period";
  periodPage?: WbReportDetailsPage;
};

export type WbProductCard = {
  nmId: number;
  vendorCode: string;
  title: string | null;
  brand: string | null;
  subjectName: string | null;
  photoUrl: string | null;
};

export type WbPromotionSpendDay = {
  date: string;
  nmId: number;
  amount: number;
};

export type WbPromotionSpendResult = {
  rows: WbPromotionSpendDay[];
  syncedDateFrom: string;
  syncedDateTo: string;
  partial: boolean;
  warning?: string;
};

export type WbValidationResult = {
  ok: boolean;
  financeOk: boolean;
  contentOk: boolean;
  promotionOk: boolean;
  financeStatus?: number;
  contentStatus?: number;
  promotionStatus?: number;
  financeError?: string;
  contentError?: string;
  promotionError?: string;
  warning?: string;
};

export type WbApiErrorCode =
  | "invalid_token"
  | "missing_finance_rights"
  | "missing_content_rights"
  | "missing_promotion_rights"
  | "rate_limited"
  | "payment_required"
  | "no_reports"
  | "wb_server_error"
  | "network_error"
  | "api_error";

export class WbApiError extends Error {
  readonly code: WbApiErrorCode;
  readonly status?: number;
  readonly wbMessage?: string;

  constructor(code: WbApiErrorCode, message: string, status?: number, wbMessage?: string) {
    super(message);
    this.name = "WbApiError";
    this.code = code;
    this.status = status;
    this.wbMessage = wbMessage;
  }
}

type WbScope = "finance" | "content" | "promotion";

const CONTENT_OPTIONAL_WARNING =
  "Финансы подключены, но нет доступа к карточкам товаров. Названия и изображения могут не загрузиться.";
const PROMOTION_OPTIONAL_WARNING =
  "Нет доступа к категории Продвижение. Рекламные расходы и ДРР пока недоступны.";
const DETAILED_PAGE_LIMIT = 100_000;

export function sanitizeWbToken(token: string) {
  return token.trim().replace(/\s+/g, "");
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getString(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }
  return null;
}

function getNumber(row: Record<string, unknown>, keys: string[]) {
  const value = getString(row, keys);
  if (value === null) return 0;
  const parsed = Number(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function reportTotalsFromListRow(row: Record<string, unknown>): WbReportTotals | undefined {
  const totalKeys = [
    "retailAmountSum",
    "forPaySum",
    "deliveryServiceSum",
    "paidStorageSum",
    "paidAcceptanceSum",
    "deductionSum",
    "penaltySum",
    "additionalPaymentSum",
    "bankPaymentSum"
  ];
  if (!totalKeys.some((key) => row[key] !== undefined && row[key] !== null)) return undefined;

  return {
    retailAmountSum: getNumber(row, ["retailAmountSum"]),
    forPaySum: getNumber(row, ["forPaySum"]),
    deliveryServiceSum: getNumber(row, ["deliveryServiceSum"]),
    paidStorageSum: getNumber(row, ["paidStorageSum"]),
    paidAcceptanceSum: getNumber(row, ["paidAcceptanceSum"]),
    deductionSum: getNumber(row, ["deductionSum"]),
    penaltySum: getNumber(row, ["penaltySum"]),
    additionalPaymentSum: getNumber(row, ["additionalPaymentSum"]),
    bankPaymentSum: getNumber(row, ["bankPaymentSum"])
  };
}

function getReportId(row: Record<string, unknown>) {
  return getString(row, ["realizationreport_id", "realizationReportId", "reportId"]);
}

function contentCardPayload(limit: number, cursor?: Record<string, unknown>) {
  return {
    settings: {
      sort: { ascending: false },
      filter: {
        textSearch: "",
        allowedCategoriesOnly: false,
        tagIDs: [],
        objectIDs: [],
        brands: [],
        imtID: 0,
        withPhoto: -1
      },
      cursor: { limit, ...cursor }
    }
  };
}

function friendlyWbMessage(code: WbApiErrorCode) {
  const messages: Record<WbApiErrorCode, string> = {
    invalid_token: "WB API-токен неверный или отозван.",
    missing_finance_rights: "Не хватает прав Финансы: Только чтение для финансовых отчётов.",
    missing_content_rights: "Не хватает прав Контент: Только чтение для карточек товаров.",
    missing_promotion_rights: "Нет доступа к категории Продвижение. Рекламные расходы и ДРР пока недоступны.",
    rate_limited: "WB API временно ограничил запросы. Попробуйте позже.",
    payment_required: "WB API требует оплату или доступ к методу недоступен для этого кабинета.",
    no_reports: "Реальных финансовых отчётов за выбранный период пока нет.",
    wb_server_error: "WB API временно недоступен. Попробуйте позже.",
    network_error: "Не удалось соединиться с WB API. Проверьте интернет или попробуйте позже.",
    api_error: "WB API вернул ошибку. Попробуйте позже или проверьте права токена."
  };
  return messages[code];
}

export function toUserWbError(error: unknown) {
  if (error instanceof WbApiError) {
    return error.message || friendlyWbMessage(error.code);
  }
  return "Не удалось выполнить запрос к WB API.";
}

function wbErrorCodeForStatus(status: number, scope: WbScope): WbApiErrorCode {
  if (status === 401) return scope === "promotion" ? "missing_promotion_rights" : "invalid_token";
  if (status === 403) {
    if (scope === "finance") return "missing_finance_rights";
    if (scope === "promotion") return "missing_promotion_rights";
    return "missing_content_rights";
  }
  if (status === 402) return "payment_required";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "wb_server_error";
  return "api_error";
}

function parseWbErrorMessage(raw: string) {
  if (!raw) return "";
  try {
    const payload = JSON.parse(raw) as {
      title?: string;
      detail?: string;
      message?: string;
      error?: string;
      errorText?: string;
    };
    return payload.detail || payload.message || payload.title || payload.errorText || payload.error || raw.slice(0, 500);
  } catch {
    return raw.slice(0, 500);
  }
}

function formatNetworkError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const details = error as Error & {
    code?: string;
    syscall?: string;
    hostname?: string;
    address?: string;
    port?: number;
    cause?: { code?: string; message?: string };
  };
  return [
    error.message,
    details.code ? `code=${details.code}` : null,
    details.cause?.code ? `cause=${details.cause.code}` : null,
    details.syscall ? `syscall=${details.syscall}` : null,
    details.hostname ? `host=${details.hostname}` : null,
    details.address ? `address=${details.address}` : null,
    details.port ? `port=${details.port}` : null,
    details.cause?.message ? `causeMessage=${details.cause.message}` : null
  ]
    .filter(Boolean)
    .join("; ");
}

type HttpResponse = { status: number; raw: string };
type JsonResponse<T> = { status: number; data: T };

async function requestText(
  url: URL,
  options: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const requestForProtocol = url.protocol === "http:" ? httpRequest : httpsRequest;
    const req = requestForProtocol(
      url,
      {
        method: options.method,
        headers: {
          ...options.headers,
          ...(options.body ? { "Content-Length": Buffer.byteLength(options.body).toString() } : {})
        },
        family: 4,
        timeout: 15_000
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            raw: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`request_timeout host=${url.hostname}`)));
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function groupReports(rows: Record<string, unknown>[], dateFrom: string, dateTo: string) {
  const groups = new Map<string, WbReportListItem>();
  for (const row of rows) {
    const reportId = getReportId(row);
    if (!reportId) continue;
    const group = groups.get(reportId) ?? {
      reportId,
      dateFrom: getString(row, ["dateFrom", "date_from"]) || dateFrom,
      dateTo: getString(row, ["dateTo", "date_to"]) || dateTo,
      createdAtWb: getString(row, ["createDate", "createdAtWb", "create_dt"]) || undefined,
      rowsCount: 0,
      totals: reportTotalsFromListRow(row)
    };
    group.rowsCount += 1;
    groups.set(reportId, group);
  }
  return [...groups.values()].toSorted((left, right) => right.dateFrom.localeCompare(left.dateFrom));
}

export class WbClient {
  private readonly apiToken: string;

  constructor(encryptedApiToken: string) {
    this.apiToken = sanitizeWbToken(decryptSecret(encryptedApiToken));
  }

  private tokenLogMeta() {
    return { tokenLength: this.apiToken.length, tokenLast4: this.apiToken.slice(-4) };
  }

  private logWbError(scope: WbScope, status: number | "network_error", wbMessage: string) {
    console.warn("[wb-api]", { scope, ...this.tokenLogMeta(), status, error: wbMessage });
  }

  private async requestJsonWithStatus<T>(
    url: URL,
    options: { method?: "GET" | "POST"; body?: unknown; scope: WbScope }
  ): Promise<JsonResponse<T>> {
    let response: HttpResponse;
    try {
      response = await requestText(url, {
        method: options.method ?? "GET",
        headers: { Authorization: this.apiToken, "Content-Type": "application/json" },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
    } catch (error) {
      const wbMessage = formatNetworkError(error);
      this.logWbError(options.scope, "network_error", wbMessage);
      throw new WbApiError("network_error", friendlyWbMessage("network_error"), undefined, wbMessage);
    }

    if (response.status < 200 || response.status >= 300) {
      const wbMessage = parseWbErrorMessage(response.raw);
      const code = wbErrorCodeForStatus(response.status, options.scope);
      this.logWbError(options.scope, response.status, wbMessage);
      throw new WbApiError(code, friendlyWbMessage(code), response.status, wbMessage);
    }

    if (!response.raw) return { status: response.status, data: undefined as T };
    try {
      return { status: response.status, data: JSON.parse(response.raw) as T };
    } catch {
      return { status: response.status, data: response.raw as T };
    }
  }

  private async requestJson<T>(url: URL, options: { method?: "GET" | "POST"; body?: unknown; scope: WbScope }) {
    return (await this.requestJsonWithStatus<T>(url, options)).data;
  }

  private async getDetailedPage(
    endpoint: "by_id" | "by_period",
    body: Record<string, unknown>
  ): Promise<WbReportDetailsPage> {
    const pathname =
      endpoint === "by_id"
        ? `/api/finance/v1/sales-reports/detailed/${encodeURIComponent(String(body.reportId))}`
        : "/api/finance/v1/sales-reports/detailed";
    const payload = { ...body };
    delete payload.reportId;
    const response = await this.requestJsonWithStatus<Record<string, unknown>[]>(
      new URL(pathname, config.WB_FINANCE_API_BASE_URL),
      { method: "POST", scope: "finance", body: payload }
    );
    const rows = Array.isArray(response.data) ? response.data : [];
    const lastRow = rows[rows.length - 1];
    const nextRrdId = getString(lastRow ?? {}, ["rrdId", "rrd_id"]);
    const partial = rows.length >= DETAILED_PAGE_LIMIT;
    return {
      rows,
      status: response.status,
      endpoint,
      partial,
      nextRrdId: partial ? nextRrdId : null
    };
  }

  async validateToken(): Promise<WbValidationResult> {
    const financeUrl = new URL("/ping", config.WB_FINANCE_API_BASE_URL);
    await this.requestJson<unknown>(financeUrl, { scope: "finance" });

    const result: WbValidationResult = {
      ok: true,
      financeOk: true,
      contentOk: false,
      promotionOk: false,
      financeStatus: 200
    };

    try {
      const contentUrl = new URL("/ping", config.WB_CONTENT_API_BASE_URL);
      await this.requestJson<unknown>(contentUrl, { scope: "content" });
      result.contentOk = true;
      result.contentStatus = 200;
    } catch (error) {
      if (error instanceof WbApiError) {
        result.contentStatus = error.status;
        result.contentError = error.message;
      } else {
        result.contentError = "Неизвестная ошибка Content API.";
      }
    }

    try {
      const promotionUrl = new URL("/ping", config.WB_PROMOTION_API_BASE_URL);
      await this.requestJson<unknown>(promotionUrl, { scope: "promotion" });
      result.promotionOk = true;
      result.promotionStatus = 200;
    } catch (error) {
      if (error instanceof WbApiError) {
        result.promotionStatus = error.status;
        result.promotionError = error.message;
      } else {
        result.promotionError = "Неизвестная ошибка Promotion API.";
      }
    }

    result.warning = [
      result.contentOk ? null : CONTENT_OPTIONAL_WARNING,
      result.promotionOk ? null : PROMOTION_OPTIONAL_WARNING
    ].filter(Boolean).join(" ") || undefined;

    return result;
  }

  async debugToken(): Promise<WbValidationResult> {
    const result: WbValidationResult = { ok: false, financeOk: false, contentOk: false, promotionOk: false };
    try {
      await this.requestJson<unknown>(new URL("/ping", config.WB_FINANCE_API_BASE_URL), { scope: "finance" });
      result.financeOk = true;
      result.financeStatus = 200;
    } catch (error) {
      if (error instanceof WbApiError) {
        result.financeStatus = error.status;
        result.financeError = error.message;
      } else {
        result.financeError = "Неизвестная ошибка Finance API.";
      }
    }

    if (result.financeOk) {
      try {
        await this.requestJson<unknown>(new URL("/ping", config.WB_CONTENT_API_BASE_URL), { scope: "content" });
        result.contentOk = true;
        result.contentStatus = 200;
      } catch (error) {
        if (error instanceof WbApiError) {
          result.contentStatus = error.status;
          result.contentError = error.message;
        } else {
          result.contentError = "Неизвестная ошибка Content API.";
        }
      }

      try {
        await this.requestJson<unknown>(new URL("/ping", config.WB_PROMOTION_API_BASE_URL), { scope: "promotion" });
        result.promotionOk = true;
        result.promotionStatus = 200;
      } catch (error) {
        if (error instanceof WbApiError) {
          result.promotionStatus = error.status;
          result.promotionError = error.message;
        } else {
          result.promotionError = "Неизвестная ошибка Promotion API.";
        }
      }
    }

    result.ok = result.financeOk;
    result.warning = result.financeOk
      ? [
          result.contentOk ? null : CONTENT_OPTIONAL_WARNING,
          result.promotionOk ? null : PROMOTION_OPTIONAL_WARNING
        ].filter(Boolean).join(" ") || undefined
      : undefined;
    return result;
  }

  async listReports(): Promise<WbReportListResult> {
    const dateTo = isoDate(new Date());
    const dateFrom = isoDate(addDays(new Date(), -config.WB_REPORT_LOOKBACK_DAYS));
    try {
      const response = await this.requestJsonWithStatus<Record<string, unknown>[]>(
        new URL("/api/finance/v1/sales-reports/list", config.WB_FINANCE_API_BASE_URL),
        {
          method: "POST",
          scope: "finance",
          body: { dateFrom, dateTo, limit: 1000, offset: 0, period: "weekly" }
        }
      );
      const rows = Array.isArray(response.data) ? response.data : [];
      return { reports: groupReports(rows, dateFrom, dateTo), source: "list" };
    } catch (error) {
      if (!(error instanceof WbApiError) || error.code !== "api_error") throw error;
      const periodPage = await this.getDetailedPage("by_period", {
        dateFrom,
        dateTo,
        limit: DETAILED_PAGE_LIMIT,
        rrdId: 0
      });
      return {
        reports: groupReports(periodPage.rows, dateFrom, dateTo),
        source: "period",
        periodPage
      };
    }
  }

  async getReportDetails(report: WbReportListItem): Promise<WbReportDetailsPage> {
    try {
      return await this.getDetailedPage("by_id", {
        reportId: report.reportId,
        limit: DETAILED_PAGE_LIMIT,
        rrdId: 0
      });
    } catch (error) {
      // WB documents that reports by ID are unavailable for some seller accounts.
      // Keep authorization, payment and rate-limit errors intact; only use the
      // documented period endpoint when the by-ID method itself is unavailable.
      if (!(error instanceof WbApiError) || error.code !== "api_error") {
        throw error;
      }

      const periodPage = await this.getDetailedPage("by_period", {
        dateFrom: report.dateFrom,
        dateTo: report.dateTo,
        limit: DETAILED_PAGE_LIMIT,
        rrdId: 0
      });

      return {
        ...periodPage,
        rows: periodPage.rows.filter((row) => getReportId(row) === report.reportId)
      };
    }
  }

  async getProductCards(targetNmIds: number[]): Promise<WbProductCard[]> {
    if (targetNmIds.length === 0) return [];
    const targetSet = new Set(targetNmIds);
    const cards: WbProductCard[] = [];
    let cursor: Record<string, unknown> | undefined;

    for (let page = 0; page < 10 && cards.length < targetSet.size; page += 1) {
      const payload = await this.requestJson<{
        cards?: Array<Record<string, unknown>>;
        cursor?: Record<string, unknown>;
      }>(new URL("/content/v2/get/cards/list", config.WB_CONTENT_API_BASE_URL), {
        method: "POST",
        scope: "content",
        body: contentCardPayload(100, cursor)
      });

      for (const card of payload.cards ?? []) {
        const nmId = Number(card.nmID ?? card.nmId ?? card.nm_id ?? 0);
        if (!targetSet.has(nmId)) continue;
        const photos = Array.isArray(card.photos) ? (card.photos as Record<string, unknown>[]) : [];
        const firstPhoto = photos[0];
        const photoUrl =
          typeof firstPhoto?.big === "string"
            ? firstPhoto.big
            : typeof firstPhoto?.c246x328 === "string"
              ? firstPhoto.c246x328
              : typeof firstPhoto?.tm === "string"
                ? firstPhoto.tm
                : null;
        cards.push({
          nmId,
          vendorCode: String(card.vendorCode ?? card.supplierArticle ?? `nm-${nmId}`),
          title: typeof card.title === "string" ? card.title : null,
          brand: typeof card.brand === "string" ? card.brand : null,
          subjectName: typeof card.subjectName === "string" ? card.subjectName : null,
          photoUrl
        });
      }

      if (!payload.cursor || (payload.cards ?? []).length === 0) break;
      cursor = payload.cursor;
    }

    return cards;
  }

  async getPromotionSpend(dateFrom: string, dateTo: string): Promise<WbPromotionSpendResult> {
    const campaignPayload = await this.requestJson<{
      adverts?: Array<{
        status?: number;
        advert_list?: Array<{ advertId?: number }>;
      }>;
    }>(new URL("/adv/v1/promotion/count", config.WB_PROMOTION_API_BASE_URL), {
      scope: "promotion"
    });

    const campaignIds = [
      ...new Set(
        (campaignPayload.adverts ?? [])
          .filter((group) => [7, 9, 11].includes(Number(group.status)))
          .flatMap((group) => group.advert_list ?? [])
          .map((campaign) => Number(campaign.advertId))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    ];

    if (campaignIds.length === 0) {
      return { rows: [], syncedDateFrom: dateFrom, syncedDateTo: dateTo, partial: false };
    }

    const requestFrom = new Date(`${dateFrom}T00:00:00.000Z`);
    const requestTo = new Date(`${dateTo}T00:00:00.000Z`);
    const maxFrom = new Date(requestTo);
    maxFrom.setUTCDate(maxFrom.getUTCDate() - 30);
    const effectiveFrom = requestFrom < maxFrom ? isoDate(maxFrom) : dateFrom;
    const requestedCampaignIds = campaignIds.slice(0, 50);
    const partial = effectiveFrom !== dateFrom || requestedCampaignIds.length !== campaignIds.length;

    const url = new URL("/adv/v3/fullstats", config.WB_PROMOTION_API_BASE_URL);
    url.searchParams.set("ids", requestedCampaignIds.join(","));
    url.searchParams.set("beginDate", effectiveFrom);
    url.searchParams.set("endDate", dateTo);
    const stats = await this.requestJson<Array<Record<string, unknown>>>(url, { scope: "promotion" });
    const totals = new Map<string, WbPromotionSpendDay>();

    for (const campaign of Array.isArray(stats) ? stats : []) {
      const days = Array.isArray(campaign.days) ? (campaign.days as Array<Record<string, unknown>>) : [];
      for (const day of days) {
        const date = getString(day, ["date"])?.slice(0, 10);
        if (!date) continue;
        const apps = Array.isArray(day.apps) ? (day.apps as Array<Record<string, unknown>>) : [];
        for (const app of apps) {
          const nms = Array.isArray(app.nms) ? (app.nms as Array<Record<string, unknown>>) : [];
          for (const item of nms) {
            const nmId = getNumber(item, ["nmId", "nmID", "nm_id"]);
            const amount = getNumber(item, ["sum"]);
            if (!Number.isInteger(nmId) || nmId <= 0 || amount === 0) continue;
            const key = `${date}:${nmId}`;
            const current = totals.get(key) ?? { date, nmId, amount: 0 };
            current.amount += amount;
            totals.set(key, current);
          }
        }
      }
    }

    return {
      rows: [...totals.values()].map((row) => ({ ...row, amount: Math.round(row.amount * 100) / 100 })),
      syncedDateFrom: effectiveFrom,
      syncedDateTo: dateTo,
      partial,
      warning: partial
        ? "ДРР рассчитан частично: WB отдаёт не более 31 дня и 50 кампаний за один запрос."
        : undefined
    };
  }
}

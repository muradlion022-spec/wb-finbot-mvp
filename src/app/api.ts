import type { OperatingExpenseInput, ProductCostInput, ReportImportPayload, ReportSummary, TaxMode } from "../shared/types.js";

const API_BASE = import.meta.env.PROD ? "" : (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

export type SyncInfo = {
  status: "not_loaded" | "queued" | "loading" | "ready" | "partial" | "rate_limited" | "failed" | "cooldown";
  cacheHit: boolean;
  retryAfterSeconds: number;
  message?: string;
};

export type PendingReportResponse = {
  syncStatus: "loading" | "queued" | "rate_limited";
  retryAfterSeconds: number;
  message: string;
  requestId?: string;
};

export type SummaryResponse = (ReportSummary & { sync?: SyncInfo }) | PendingReportResponse;

export type ProductDetailResponse = {
  product: import("../shared/types.js").ProductReportItem;
  byDay: MovementItem[];
  bySize: Array<MovementItem & { days: MovementItem[] }>;
};

export type MovementItem = {
  label: string;
  unitsSold: number;
  returns: number;
  revenue: number;
  forPay: number;
  commission: number;
  logistics: number;
  storage: number;
  otherDeductions: number;
  penalties: number;
  buyoutRate: number | null;
};

type ErrorPayload = { error?: string; code?: string; requestId?: string };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function getTelegramInitData() {
  return window.Telegram?.WebApp?.initData || "";
}

function userMessage(code: string, status: number, fallback: string) {
  const messages: Record<string, string> = {
    backend_unreachable: "Нет связи с сервером сервиса. Попробуйте обновить приложение.",
    telegram_auth_required: "Не удалось подтвердить вход через Telegram. Закройте приложение и откройте его заново из бота.",
    wb_not_connected: "WB API не подключён.",
    invalid_token: "WB-токен неверный или был отозван.",
    rate_limited: "Wildberries временно ограничил частоту запросов. Сохранённые данные доступны, обновление можно повторить позже.",
    internal_error: "Сервис временно не смог обработать запрос."
  };
  if (messages[code]) return messages[code];
  if (status >= 500) return "Сервис временно не смог обработать запрос.";
  return fallback || "Не удалось выполнить запрос.";
}

export function readableApiError(error: unknown) {
  if (!(error instanceof ApiError)) return "Сервис временно не смог обработать запрос.";
  const suffix = error.requestId ? ` Код ошибки: ${error.requestId}` : "";
  return `${error.message}${suffix}`;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const initData = getTelegramInitData();
  headers.set("Content-Type", "application/json");
  if (initData) headers.set("X-Telegram-Init-Data", initData);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    throw new ApiError(userMessage("backend_unreachable", 0, ""), 0, "backend_unreachable");
  }

  const payload = (await response.json().catch(() => ({}))) as ErrorPayload;
  if (!response.ok) {
    const code = payload.code || (response.status === 401 ? "telegram_auth_required" : "server_error");
    throw new ApiError(userMessage(code, response.status, payload.error || response.statusText), response.status, code, payload.requestId);
  }
  return payload as T;
}

export const api = {
  health: () => request<{ ok: boolean; version: string; builtAt: string }>("/api/health"),
  account: () =>
    request<{
      id: string;
      name: string;
      tokenStatus: string;
      tokenLast4: string | null;
      tokenConnectedAt: string | null;
      taxMode: TaxMode;
      useDemoData: boolean;
      version: string;
    }>("/api/account"),
  saveTaxMode: (taxMode: TaxMode) =>
    request<{ taxMode: TaxMode }>("/api/account/tax", { method: "PATCH", body: JSON.stringify({ taxMode }) }),
  resetDemo: () => request<{ summary: ReportSummary }>("/api/demo/reset", { method: "POST" }),
  reports: () =>
    request<{
      reports: Array<{
        id: string;
        reportId: string;
        dateFrom: string;
        dateTo: string;
        totalRetailAmount: number;
        totalForPay: number;
        syncStatus: string;
      }>;
      sync: SyncInfo;
    }>("/api/reports"),
  importReport: (payload: ReportImportPayload) =>
    request<{ summary: ReportSummary }>("/api/reports/import", { method: "POST", body: JSON.stringify(payload) }),
  summary: (reportId: string) => request<SummaryResponse>(`/api/reports/${reportId}/summary`),
  combinedSummary: (reportIds: string[]) =>
    request<SummaryResponse>("/api/reports/combined-summary", {
      method: "POST",
      body: JSON.stringify({ reportIds })
    }),
  refreshReport: (reportId: string) =>
    request<{ summary: ReportSummary; sync: SyncInfo } | PendingReportResponse>(`/api/reports/${reportId}/refresh`, { method: "POST" }),
  enrichProducts: (reportId: string) =>
    request<{ status: "ready" | "loading" | "failed_optional"; warning?: string; retryAfterSeconds?: number }>(
      `/api/reports/${reportId}/enrich-products`,
      { method: "POST" }
    ),
  productDetail: (reportId: string, nmId: number) =>
    request<ProductDetailResponse>(`/api/reports/${reportId}/products/${nmId}`),
  combinedProductDetail: (reportIds: string[], nmId: number) =>
    request<ProductDetailResponse>(`/api/reports/combined/products/${nmId}`, {
      method: "POST",
      body: JSON.stringify({ reportIds })
    }),
  saveCost: (productId: string, payload: ProductCostInput) =>
    request<{ cost: unknown }>(`/api/products/${productId}/cost`, { method: "PUT", body: JSON.stringify(payload) }),
  expenses: () =>
    request<{
      expenses: Array<{
        id: string;
        title: string;
        category: string;
        amount: number;
        expenseType: string;
        recurrenceType: string;
        expenseDate: string | null;
        dayOfMonth: number | null;
        allocationMode: string;
        active: boolean;
      }>;
    }>("/api/expenses"),
  createExpense: (payload: OperatingExpenseInput) =>
    request<{ expense: unknown }>("/api/expenses", { method: "POST", body: JSON.stringify(payload) }),
  deleteExpense: (id: string) => request<{ ok: boolean }>(`/api/expenses/${id}`, { method: "DELETE" }),
  saveToken: (token: string) =>
    request<{
      tokenStatus: string;
      last4: string;
      connectedAt: string;
      warning?: string;
      contentStatus?: string;
      promotionStatus?: string;
    }>("/api/wb/token", {
      method: "POST",
      body: JSON.stringify({ token })
    }),
  deleteToken: () => request<{ ok: boolean }>("/api/wb/token", { method: "DELETE" })
};

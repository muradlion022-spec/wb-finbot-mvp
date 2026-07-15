import {
  BadgePercent,
  Banknote,
  BarChart3,
  Boxes,
  CalendarDays,
  ChevronLeft,
  CircleDollarSign,
  Copy,
  Database,
  FileUp,
  KeyRound,
  Loader2,
  Megaphone,
  PackageSearch,
  Percent,
  ReceiptText,
  RefreshCcw,
  RotateCcw,
  Save,
  Scale,
  Settings,
  ShoppingBag,
  Trash2,
  TrendingUp,
  Truck,
  Warehouse,
  WalletCards
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  OperatingExpenseInput,
  ProductCostInput,
  ProductReportItem,
  ReportSummary,
  TaxMode
} from "../shared/types.js";
import { api, readableApiError, type MovementItem, type SyncInfo } from "./api.js";
import { parseReportFile } from "./importReport.js";

type Tab = "dashboard" | "products" | "costs" | "expenses" | "deductions" | "settings";
type ProductFilter = "all" | "profitable" | "loss" | "missing_cost" | "high_logistics" | "high_returns";
type ProductSort = "profit_desc" | "loss_first" | "revenue_desc" | "margin_desc" | "wb_expenses_desc";

const tabs: Array<{ id: Tab; title: string; icon: typeof BarChart3 }> = [
  { id: "dashboard", title: "Сводка", icon: BarChart3 },
  { id: "products", title: "Артикулы", icon: PackageSearch },
  { id: "costs", title: "Себестоимость", icon: Boxes },
  { id: "expenses", title: "Расходы", icon: WalletCards },
  { id: "deductions", title: "Списания", icon: ReceiptText },
  { id: "settings", title: "Настройки", icon: Settings }
];

const emptyCost: ProductCostInput = {
  purchaseCost: 0,
  packagingCost: 0,
  fulfillmentCost: 0,
  deliveryToWarehouseCost: 0,
  markingCost: 0,
  otherUnitCost: 0,
  validFrom: new Date().toISOString().slice(0, 10)
};

const expenseCategories = [
  ["warehouse", "Склад"],
  ["employee", "Сотрудник"],
  ["fulfillment", "Фулфилмент"],
  ["services", "Сервисы"],
  ["designer", "Дизайнер"],
  ["external_ads", "Реклама вне WB"],
  ["accounting", "Бухгалтерия"],
  ["other", "Другое"]
];

const taxModeOptions: Array<[TaxMode, string]> = [
  ["none", "Выберите налоговый режим"],
  ["usn_income_6", "УСН Доходы — 6%"],
  ["usn_income_1", "УСН Доходы — 1%"],
  ["usn_profit_15", "УСН Доходы минус расходы — 15%"],
  ["usn_profit_5", "УСН Доходы минус расходы — 5%"]
];

function taxMetricLabel(mode: TaxMode) {
  const labels: Record<TaxMode, string> = {
    none: "Налог не выбран",
    usn_income_1: "Налог · УСН 1% с доходов",
    usn_income_6: "Налог · УСН 6% с доходов",
    usn_profit_5: "Налог · УСН 5% с прибыли",
    usn_profit_15: "Налог · УСН 15% с прибыли"
  };
  return labels[mode];
}

function costDraftFor(product: ProductReportItem): ProductCostInput {
  return {
    ...(product.costBreakdown ?? {
      ...emptyCost,
      purchaseCost: product.totalUnitCost ?? 0
    }),
    validFrom: new Date().toISOString().slice(0, 10)
  };
}

function reportIdsFromSearch(searchParams: URLSearchParams) {
  const multiple = (searchParams.get("reportIds") || "").split(",").filter(Boolean);
  if (multiple.length > 0) return multiple.slice(0, 10);
  const single = searchParams.get("reportId");
  return single ? [single] : [];
}

function money(value: number) {
  return `${Math.round(value).toLocaleString("ru-RU")} ₽`;
}

function percent(value: number | null) {
  return value === null ? "нет данных" : `${value.toLocaleString("ru-RU")} %`;
}

function moneyAndPercent(amount: number, rate: number | null) {
  return `${money(amount)} · ${percent(rate)}`;
}

function promotionValue(amount: number | null, drr: number | null) {
  return amount === null ? "нет доступа" : `${money(amount)} · ДРР ${percent(drr)}`;
}

function performanceTone(value: number | null) {
  if (value === null) return "neutral" as const;
  return value >= 0 ? "positive" as const : "negative" as const;
}

function dateShort(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit"
  }).format(new Date(value));
}

function reportCountLabel(count: number) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  const noun = mod100 >= 11 && mod100 <= 14 ? "отчётов" : mod10 === 1 ? "отчёт" : mod10 >= 2 && mod10 <= 4 ? "отчёта" : "отчётов";
  return `${count} ${noun}`;
}

function statusLabel(status: ProductReportItem["status"]) {
  const labels = {
    profitable: "прибыльный",
    weak_margin: "слабая маржа",
    loss: "в минусе",
    missing_cost: "нет себестоимости"
  };
  return labels[status];
}

function statusTone(status: ProductReportItem["status"]) {
  if (status === "profitable") {
    return "positive";
  }
  if (status === "weak_margin") {
    return "warning";
  }
  if (status === "loss") {
    return "negative";
  }
  return "muted";
}

function tokenStatusLabel(status: string) {
  const labels: Record<string, string> = {
    valid: "WB API подключён",
    checking: "Проверяем WB API",
    not_connected: "WB API не подключён",
    invalid: "Токен неверный или отозван",
    invalid_token: "Токен неверный или отозван",
    missing_finance_rights: "Нет доступа к финансам",
    missing_content_rights: "Нет доступа к карточкам товаров",
    rate_limited: "WB временно ограничил запросы",
    network_error: "Не удалось соединиться с WB API",
    wb_server_error: "WB API временно недоступен"
  };

  return labels[status] || "Ошибка подключения WB API";
}

function productMatchesFilter(product: ProductReportItem, filter: ProductFilter) {
  if (filter === "all") {
    return true;
  }

  if (filter === "high_logistics") {
    return product.wbExpenses > product.revenue * 0.25;
  }

  if (filter === "high_returns") {
    const total = product.unitsSold + product.returns;
    return total > 0 && product.returns / total >= 0.1;
  }

  return product.status === filter;
}

function sortProducts(products: ProductReportItem[], sort: ProductSort) {
  const next = [...products];
  const sorters: Record<ProductSort, (a: ProductReportItem, b: ProductReportItem) => number> = {
    profit_desc: (a, b) => b.finalProfit - a.finalProfit,
    loss_first: (a, b) => a.finalProfit - b.finalProfit,
    revenue_desc: (a, b) => b.revenue - a.revenue,
    margin_desc: (a, b) => (b.margin ?? -999) - (a.margin ?? -999),
    wb_expenses_desc: (a, b) => b.wbExpenses - a.wbExpenses
  };
  return next.sort(sorters[sort]);
}

function Metric({
  label,
  value,
  tone = "neutral",
  icon: Icon
}: {
  label: string;
  value: string;
  tone?: "neutral" | "income" | "cost" | "positive" | "warning" | "negative";
  icon?: typeof BarChart3;
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-label">
        {Icon && <Icon size={16} strokeWidth={1.8} />}
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
    </div>
  );
}

function MetricSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="metric-section">
      <h2>{title}</h2>
      <div className="metric-grid">{children}</div>
    </section>
  );
}

function MovementMatrix({ items, mode }: { items: MovementItem[]; mode: "days" | "sizes" }) {
  const columns = [...items].sort((left, right) => {
    if (mode === "days") return right.label.localeCompare(left.label);
    return left.label.localeCompare(right.label, "ru", { numeric: true });
  });
  const rows: Array<{ label: string; value: (item: MovementItem) => string }> = [
    { label: "Продажи", value: (item) => money(item.revenue) },
    { label: "Продажи, шт.", value: (item) => String(item.unitsSold) },
    { label: "Возвраты, шт.", value: (item) => String(item.returns) },
    { label: "Выкуп", value: (item) => percent(item.buyoutRate) },
    { label: "К перечислению", value: (item) => money(item.forPay) },
    { label: "Комиссия WB", value: (item) => money(item.commission) },
    { label: "Логистика", value: (item) => money(item.logistics) },
    { label: "Хранение", value: (item) => money(item.storage) },
    { label: "Прочие удержания", value: (item) => money(item.otherDeductions) },
    { label: "Штрафы", value: (item) => money(item.penalties) }
  ];

  return (
    <div className="movement-scroll">
      <table className="movement-matrix">
        <thead>
          <tr>
            <th>Показатель</th>
            {columns.map((item) => (
              <th key={item.label}>
                {mode === "days" && item.label !== "Без даты" ? dateShort(item.label) : item.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th>{row.label}</th>
              {columns.map((item) => <td key={`${row.label}-${item.label}`}>{row.value(item)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductImage({ product }: { product: ProductReportItem }) {
  if (product.photoUrl) {
    return <img className="product-image" src={product.photoUrl} alt={product.title || product.vendorCode} />;
  }

  return (
    <div className="product-image product-image-placeholder">
      <span>{product.vendorCode.slice(0, 2).toUpperCase()}</span>
    </div>
  );
}

export function App() {
  const searchParams = new URLSearchParams(window.location.search);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const reportPickerRef = useRef<HTMLDetailsElement | null>(null);
  const initialReportIds = reportIdsFromSearch(searchParams);
  const [tab, setTab] = useState<Tab>((searchParams.get("tab") as Tab) || "dashboard");
  const [account, setAccount] = useState<{
    name: string;
    tokenStatus: string;
    tokenLast4: string | null;
    tokenConnectedAt: string | null;
    taxMode: TaxMode;
    useDemoData: boolean;
  } | null>(null);
  const [reports, setReports] = useState<
    Array<{ id: string; reportId: string; dateFrom: string; dateTo: string; totalForPay: number }>
  >([]);
  const [selectedReportIds, setSelectedReportIds] = useState<string[]>(initialReportIds);
  const [draftReportIds, setDraftReportIds] = useState<string[]>(initialReportIds);
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [expenses, setExpenses] = useState<Awaited<ReturnType<typeof api.expenses>>["expenses"]>([]);
  const [productFilter, setProductFilter] = useState<ProductFilter>("all");
  const [productSort, setProductSort] = useState<ProductSort>("profit_desc");
  const [selectedProduct, setSelectedProduct] = useState<ProductReportItem | null>(null);
  const [productDetail, setProductDetail] = useState<Awaited<ReturnType<typeof api.productDetail>> | null>(
    null
  );
  const [costDrafts, setCostDrafts] = useState<Record<string, ProductCostInput>>({});
  const [expenseDraft, setExpenseDraft] = useState<OperatingExpenseInput>({
    title: "",
    category: "warehouse",
    amount: 0,
    expenseType: "one_time",
    recurrenceType: "none",
    expenseDate: new Date().toISOString().slice(0, 10),
    dayOfMonth: 1,
    allocationMode: "store_level_only"
  });
  const [tokenDraft, setTokenDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  const visibleProducts = useMemo(() => {
    if (!summary) {
      return [];
    }

    return sortProducts(
      summary.products.filter((product) => productMatchesFilter(product, productFilter)),
      productSort
    );
  }, [productFilter, productSort, summary]);

  function applySync(sync?: SyncInfo) {
    if (!sync) return;
    setCooldownSeconds(Math.max(0, sync.retryAfterSeconds || 0));
    if (sync.message) setNotice(sync.message);
  }

  function updateReportQuery(reportIds: string[]) {
    const url = new URL(window.location.href);
    url.searchParams.delete("reportId");
    url.searchParams.delete("reportIds");
    if (reportIds.length === 1) url.searchParams.set("reportId", reportIds[0]);
    if (reportIds.length > 1) url.searchParams.set("reportIds", reportIds.join(","));
    window.history.replaceState({}, "", url);
  }

  async function refreshReports(reportIds = selectedReportIds) {
    if (reportIds.length === 0) {
      return;
    }
    const response = reportIds.length === 1
      ? await api.summary(reportIds[0])
      : await api.combinedSummary(reportIds);
    if ("syncStatus" in response) {
      setCooldownSeconds(Math.max(0, response.retryAfterSeconds));
      setNotice(response.message);
      return;
    }
    const { sync, ...nextSummary } = response;
    setSummary(nextSummary);
    setSelectedReportIds(nextSummary.reportIds);
    setDraftReportIds(nextSummary.reportIds);
    updateReportQuery(nextSummary.reportIds);
    applySync(sync);
    if (nextSummary.reportIds.length === 1) {
      void api
        .enrichProducts(nextSummary.reportIds[0])
        .then((result) => {
          if (result.status === "failed_optional" && result.warning) setNotice(result.warning);
        })
        .catch(() => undefined);
    }
  }

  async function refreshExpenses() {
    const payload = await api.expenses();
    setExpenses(payload.expenses);
  }

  async function loadInitial() {
    setLoading(true);
    setError("");
    try {
      await api.health();
      const accountPayload = await api.account();
      const reportsPayload = await api.reports();
      setAccount(accountPayload);
      setReports(reportsPayload.reports);
      applySync(reportsPayload.sync);

      const availableIds = new Set(reportsPayload.reports.map((report) => report.id));
      const requestedIds = initialReportIds.filter((id) => availableIds.has(id));
      const reportIds = requestedIds.length > 0 ? requestedIds : reportsPayload.reports[0]?.id ? [reportsPayload.reports[0].id] : [];
      setSelectedReportIds(reportIds);
      setDraftReportIds(reportIds);
      if (reportIds.length > 0) {
        await refreshReports(reportIds);
      } else {
        setSummary(null);
      }

      await refreshExpenses();
    } catch (caught) {
      setError(readableApiError(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadInitial();
  }, []);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setInterval(() => setCooldownSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownSeconds]);

  useEffect(() => {
    if (!selectedProduct || !summary) {
      setProductDetail(null);
      return;
    }

    setBusy(true);
    api
      .combinedProductDetail(selectedReportIds, selectedProduct.nmId)
      .then(setProductDetail)
      .catch((caught) => setError(readableApiError(caught)))
      .finally(() => setBusy(false));
  }, [selectedProduct?.nmId, selectedReportIds.join(",")]);

  async function handleReportsApply(reportIds: string[]) {
    if (reportIds.length === 0 || reportIds.length > 10) return;
    setSelectedReportIds(reportIds);
    setSelectedProduct(null);
    setBusy(true);
    setError("");
    try {
      await refreshReports(reportIds);
      if (reportPickerRef.current) reportPickerRef.current.open = false;
    } catch (caught) {
      setError(readableApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleDemoReset() {
    setBusy(true);
    setError("");
    try {
      const payload = await api.resetDemo();
      setSummary(payload.summary);
      setSelectedReportIds(payload.summary.reportIds);
      setDraftReportIds(payload.summary.reportIds);
      const freshReports = await api.reports();
      setReports(freshReports.reports);
      await refreshExpenses();
      setNotice("Демо-отчёт загружен.");
    } catch (caught) {
      setError(readableApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleFileChange(file: File | null) {
    if (!file) {
      return;
    }

    setBusy(true);
    setError("");
    try {
      const text = await file.text();
      const payload = parseReportFile(file.name, text);
      const imported = await api.importReport(payload);
      setSummary(imported.summary);
      setSelectedReportIds(imported.summary.reportIds);
      setDraftReportIds(imported.summary.reportIds);
      const freshReports = await api.reports();
      setReports(freshReports.reports);
      setNotice("Отчёт импортирован.");
    } catch (caught) {
      setError(readableApiError(caught));
    } finally {
      setBusy(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function updateCostDraft(product: ProductReportItem, key: keyof ProductCostInput, value: number | string) {
    setCostDrafts((drafts) => {
      const current =
        drafts[product.productId] ?? costDraftFor(product);

      return {
        ...drafts,
        [product.productId]: {
          ...current,
          [key]: value
        }
      };
    });
  }

  async function saveCost(product: ProductReportItem) {
    const draft = costDrafts[product.productId] ?? costDraftFor(product);

    setBusy(true);
    setError("");
    try {
      await api.saveCost(product.productId, {
        ...draft,
        packagingCost: 0,
        markingCost: 0,
        otherUnitCost: 0
      });
      setCostDrafts((drafts) => {
        const next = { ...drafts };
        delete next[product.productId];
        return next;
      });
      await refreshReports();
      setNotice("Себестоимость сохранена.");
    } catch (caught) {
      setError(readableApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveExpense() {
    setBusy(true);
    setError("");
    try {
      await api.createExpense(expenseDraft);
      await refreshExpenses();
      await refreshReports();
      setExpenseDraft({
        title: "",
        category: "warehouse",
        amount: 0,
        expenseType: "one_time",
        recurrenceType: "none",
        expenseDate: new Date().toISOString().slice(0, 10),
        dayOfMonth: 1,
        allocationMode: "store_level_only"
      });
      setNotice("Расход добавлен.");
    } catch (caught) {
      setError(readableApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function deleteExpense(id: string) {
    setBusy(true);
    try {
      await api.deleteExpense(id);
      await refreshExpenses();
      await refreshReports();
    } catch (caught) {
      setError(readableApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveToken() {
    setBusy(true);
    setError("");
    try {
      const payload = await api.saveToken(tokenDraft);
      setAccount((current) => current
        ? {
            ...current,
            tokenStatus: payload.tokenStatus,
            tokenLast4: payload.last4,
            tokenConnectedAt: payload.connectedAt
          }
        : current);
      setTokenDraft("");

      let refreshMessage: string | null = null;
      try {
        const reportsPayload = await api.reports();
        setReports(reportsPayload.reports);
        applySync(reportsPayload.sync);
        const availableIds = new Set(reportsPayload.reports.map((report) => report.id));
        const currentIds = selectedReportIds.filter((id) => availableIds.has(id));
        const reportIds = currentIds.length > 0
          ? currentIds
          : reportsPayload.reports[0]?.id
            ? [reportsPayload.reports[0].id]
            : [];
        setSelectedReportIds(reportIds);
        setDraftReportIds(reportIds);
        if (reportIds.length > 0) {
          await refreshReports(reportIds);
        } else {
          setSummary(null);
        }
      } catch {
        refreshMessage = "Токен заменён, но WB временно не отдал данные. Повторите открытие отчёта позже.";
      }

      setNotice(
        [
          `WB API подключён. Новый токен ****${payload.last4} применён в боте и Mini App.`,
          payload.promotionStatus === "valid" ? "Продвижение: доступ есть." : null,
          payload.warning || null,
          refreshMessage
        ]
          .filter(Boolean)
          .join(" ")
      );
    } catch (caught) {
      setError(readableApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function deleteToken() {
    setBusy(true);
    try {
      await api.deleteToken();
      setAccount((current) => current
        ? { ...current, tokenStatus: "not_connected", tokenLast4: null, tokenConnectedAt: null }
        : current);
      setSummary(null);
      setNotice("Токен удалён.");
    } catch (caught) {
      setError(readableApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveTaxMode(taxMode: TaxMode) {
    setBusy(true);
    setError("");
    try {
      const payload = await api.saveTaxMode(taxMode);
      setAccount((current) => (current ? { ...current, taxMode: payload.taxMode } : current));
      await refreshReports();
      setNotice("Налоговый режим сохранён.");
    } catch (caught) {
      setError(readableApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="app-shell centered">
        <Loader2 className="spin" />
        <span>Загрузка</span>
      </main>
    );
  }

  if (!account && error) {
    return (
      <main className="app-shell centered">
        <span>{error}</span>
        <button className="primary-button" onClick={() => void loadInitial()}>
          Повторить подключение
        </button>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">{account?.name || "WB Финбот"}</span>
          <h1>Финансовый отчёт</h1>
        </div>
        <button
          className="icon-button"
          onClick={() => void loadInitial()}
          disabled={busy || cooldownSeconds > 0}
          aria-label="Обновить"
          title={cooldownSeconds > 0 ? `Повторить можно через ${cooldownSeconds} с.` : "Обновить"}
        >
          <RefreshCcw size={19} />
        </button>
      </header>

      <section className="toolbar">
        <details className="report-picker" ref={reportPickerRef}>
          <summary>
            {reportCountLabel(selectedReportIds.length)}
          </summary>
          <div className="report-picker-menu">
            <strong>Выберите до 10 отчётов</strong>
            <div className="report-picker-list">
              {reports.map((report) => {
                const checked = draftReportIds.includes(report.id);
                return (
                  <label className="report-picker-option" key={report.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && draftReportIds.length >= 10}
                      onChange={() => {
                        setDraftReportIds((current) =>
                          current.includes(report.id)
                            ? current.filter((id) => id !== report.id)
                            : [...current, report.id].slice(0, 10)
                        );
                      }}
                    />
                    <span>
                      {dateShort(report.dateFrom)} - {dateShort(report.dateTo)} · {report.reportId}
                    </span>
                  </label>
                );
              })}
            </div>
            <button
              className="primary-button full-width"
              disabled={draftReportIds.length === 0 || busy}
              onClick={() => void handleReportsApply(draftReportIds)}
            >
              Показать выбранные ({draftReportIds.length})
            </button>
          </div>
        </details>
        {account?.useDemoData && (
          <button className="tool-button" onClick={handleDemoReset} disabled={busy}>
            <Database size={18} />
            <span>Демо</span>
          </button>
        )}
        <button className="tool-button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
          <FileUp size={18} />
          <span>Импорт</span>
        </button>
        <input
          ref={fileInputRef}
          className="hidden"
          type="file"
          accept=".json,.csv,application/json,text/csv"
          onChange={(event) => void handleFileChange(event.target.files?.[0] ?? null)}
        />
        {cooldownSeconds > 0 && <span className="muted-text">Обновление через {cooldownSeconds} с.</span>}
      </section>

      {(error || notice) && (
        <div className={error ? "message message-error" : "message message-ok"}>
          {error || notice}
          <button
            className="message-close"
            onClick={() => {
              setError("");
              setNotice("");
            }}
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>
      )}

      <nav className="tabs" aria-label="Разделы">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={tab === item.id ? "tab active" : "tab"}
              onClick={() => {
                setTab(item.id);
                setSelectedProduct(null);
              }}
            >
              <Icon size={18} />
              <span>{item.title}</span>
            </button>
          );
        })}
      </nav>

      {busy && (
        <div className="busy-line">
          <Loader2 className="spin" size={16} />
          <span>Обновление</span>
        </div>
      )}

      {!summary ? (
        <section className="empty-state">
          <Database size={28} />
          <p>
            {account?.tokenStatus === "valid"
              ? "Реальных отчётов пока нет."
              : "Подключите WB API-токен в настройках или через Telegram-бота."}
          </p>
          {account?.useDemoData && (
            <button className="primary-button" onClick={handleDemoReset}>
              Загрузить демо
            </button>
          )}
        </section>
      ) : (
        <>
          {tab === "dashboard" && <Dashboard summary={summary} />}
          {tab === "products" && (
            <Products
              products={visibleProducts}
              productFilter={productFilter}
              productSort={productSort}
              onFilterChange={setProductFilter}
              onSortChange={setProductSort}
              onSelect={setSelectedProduct}
            />
          )}
          {tab === "costs" && (
            <Costs
              products={summary.products}
              costDrafts={costDrafts}
              onDraftChange={updateCostDraft}
              onSave={(product) => void saveCost(product)}
            />
          )}
          {tab === "expenses" && (
            <Expenses
              expenses={expenses}
              draft={expenseDraft}
              onDraftChange={setExpenseDraft}
              onSave={() => void saveExpense()}
              onDelete={(id) => void deleteExpense(id)}
            />
          )}
          {tab === "deductions" && <Deductions summary={summary} />}
          {tab === "settings" && (
            <SettingsView
              tokenStatus={account?.tokenStatus || "not_connected"}
              tokenLast4={account?.tokenLast4 ?? null}
              tokenConnectedAt={account?.tokenConnectedAt ?? null}
              taxMode={account?.taxMode || "none"}
              tokenDraft={tokenDraft}
              onTokenDraftChange={setTokenDraft}
              onSaveToken={() => void saveToken()}
              onDeleteToken={() => void deleteToken()}
              onTaxModeChange={(taxMode) => void saveTaxMode(taxMode)}
            />
          )}
        </>
      )}

      {selectedProduct && (
        <ProductDetail
          product={selectedProduct}
          taxMode={summary?.taxMode ?? "none"}
          detail={productDetail}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </main>
  );
}

function Dashboard({ summary }: { summary: ReportSummary }) {
  return (
    <section className="screen">
      <div className="period-line">
        <span>
          {summary.reportId}
          {summary.reportId.startsWith("demo-") ? " · Демо-режим" : ""}
        </span>
        <strong>
          {dateShort(summary.dateFrom)} - {dateShort(summary.dateTo)}
        </strong>
      </div>

      <MetricSection title="Продажи и выплаты">
        <Metric
          label="Продажи"
          value={`${money(summary.revenue)} · ${summary.unitsSold} шт.`}
          tone="income"
          icon={ShoppingBag}
        />
        <Metric
          label="Выкуп"
          value={`${percent(summary.buyoutRate)} · возвраты ${summary.returns} шт.`}
          icon={RotateCcw}
        />
        <Metric label="К перечислению за товар" value={money(summary.goodsForPay)} tone="income" icon={Banknote} />
        <Metric label="Итого к оплате" value={money(summary.forPay)} tone="income" icon={CircleDollarSign} />
      </MetricSection>

      <MetricSection title="Расходы">
        <Metric
          label="Комиссия / вознаграждение WB"
          value={moneyAndPercent(summary.wbCommission, summary.commissionRate)}
          tone="cost"
          icon={BadgePercent}
        />
        <Metric
          label="Все удержания WB"
          value={moneyAndPercent(summary.wbCommission + summary.wbExpenses, summary.wbDeductionsRate)}
          tone="cost"
          icon={Scale}
        />
        <Metric
          label="Логистика"
          value={`${money(summary.logistics)} · ${summary.logisticsPerUnit === null ? "нет данных" : `${money(summary.logisticsPerUnit)}/шт.`}`}
          tone="cost"
          icon={Truck}
        />
        <Metric label="Хранение" value={money(summary.storage)} tone="cost" icon={Warehouse} />
        <Metric label="Прочие удержания" value={money(summary.otherDeductions)} tone="cost" icon={ReceiptText} />
        <Metric label="Штрафы" value={money(summary.penalties)} tone="cost" icon={CircleDollarSign} />
        <Metric label="Продвижение" value={promotionValue(summary.adSpend, summary.drr)} tone="cost" icon={Megaphone} />
        <Metric label="Себестоимость продаж" value={money(summary.productCost)} tone="cost" icon={Boxes} />
        <Metric label="Опер. расходы" value={money(summary.operatingExpenses)} tone="cost" icon={WalletCards} />
        <Metric label={taxMetricLabel(summary.taxMode)} value={money(summary.tax)} tone="cost" icon={Banknote} />
      </MetricSection>

      <MetricSection title="Результат">
        <Metric
          label="Чистая прибыль"
          value={money(summary.finalProfit)}
          tone={summary.finalProfit >= 0 ? "positive" : "negative"}
          icon={TrendingUp}
        />
        <Metric label="Маржинальность" value={percent(summary.margin)} tone={performanceTone(summary.margin)} icon={Percent} />
        <Metric label="ROI" value={percent(summary.roi)} tone={performanceTone(summary.roi)} icon={BadgePercent} />
      </MetricSection>

      {summary.promotionWarning && <div className="message message-info">{summary.promotionWarning}</div>}

      <section className="panel">
        <h2>Главные выводы</h2>
        <ul className="insight-list">
          {summary.insights.map((insight) => (
            <li key={insight}>{insight}</li>
          ))}
        </ul>
      </section>

      <div className="compact-stats">
        <Metric label="Без себестоимости" value={String(summary.missingCostProducts)} tone="warning" />
        <Metric label="Убыточные" value={String(summary.lossProducts)} tone="negative" />
        <Metric label="Слабая маржа" value={String(summary.weakMarginProducts)} tone="warning" />
      </div>
    </section>
  );
}

function Products({
  products,
  productFilter,
  productSort,
  onFilterChange,
  onSortChange,
  onSelect
}: {
  products: ProductReportItem[];
  productFilter: ProductFilter;
  productSort: ProductSort;
  onFilterChange: (filter: ProductFilter) => void;
  onSortChange: (sort: ProductSort) => void;
  onSelect: (product: ProductReportItem) => void;
}) {
  return (
    <section className="screen">
      <div className="controls-row">
        <select
          value={productFilter}
          onChange={(event) => onFilterChange(event.target.value as ProductFilter)}
          aria-label="Фильтр"
        >
          <option value="all">Все</option>
          <option value="profitable">Прибыльные</option>
          <option value="loss">В минусе</option>
          <option value="missing_cost">Без себестоимости</option>
          <option value="high_logistics">Высокая логистика</option>
          <option value="high_returns">Высокие возвраты</option>
        </select>
        <select
          value={productSort}
          onChange={(event) => onSortChange(event.target.value as ProductSort)}
          aria-label="Сортировка"
        >
          <option value="profit_desc">По прибыли</option>
          <option value="loss_first">По убытку</option>
          <option value="revenue_desc">По продажам</option>
          <option value="margin_desc">По марже</option>
          <option value="wb_expenses_desc">По удержаниям WB</option>
        </select>
      </div>

      <div className="product-list">
        {products.map((product) => (
          <article
            className="product-row"
            key={product.nmId}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(product)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onSelect(product);
            }}
          >
            <ProductImage product={product} />
            <div className="product-main">
              <div className="product-title">
                <strong>{product.title || product.vendorCode}</strong>
                <span className={`badge badge-${statusTone(product.status)}`}>{statusLabel(product.status)}</span>
              </div>
              <span className="muted-text">
                {[product.subjectName, product.vendorCode, `nmId ${product.nmId}`].filter(Boolean).join(" · ")}
              </span>
              <div className="article-metrics">
                <span><b>Продажи</b>{money(product.revenue)} · {product.unitsSold} шт.</span>
                <span><b>Выкуп</b>{percent(product.buyoutRate)}</span>
                <span><b>Удержания WB</b>{percent(product.wbDeductionsRate)}</span>
                <span><b>Комиссия WB</b>{percent(product.commissionRate)}</span>
                <span><b>Логистика / шт.</b>{product.logisticsPerUnit === null ? "нет данных" : money(product.logisticsPerUnit)}</span>
                <span><b>Продвижение / ДРР</b>{product.adSpend === null ? "нет доступа" : `${money(product.adSpend)} · ${percent(product.drr)}`}</span>
              </div>
            </div>
            <div className="product-profit">
              <button
                className="copy-button"
                type="button"
                title="Копировать артикул WB"
                aria-label="Копировать артикул WB"
                onClick={(event) => {
                  event.stopPropagation();
                  void navigator.clipboard.writeText(String(product.nmId));
                }}
              >
                <Copy size={16} />
              </button>
              <strong className={product.finalProfit >= 0 ? "text-positive" : "text-negative"}>
                {money(product.finalProfit)}
              </strong>
              <span>Маржа {percent(product.margin)} · ROI {percent(product.roi)}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Costs({
  products,
  costDrafts,
  onDraftChange,
  onSave
}: {
  products: ProductReportItem[];
  costDrafts: Record<string, ProductCostInput>;
  onDraftChange: (product: ProductReportItem, key: keyof ProductCostInput, value: number | string) => void;
  onSave: (product: ProductReportItem) => void;
}) {
  const fields: Array<[keyof ProductCostInput, string]> = [
    ["purchaseCost", "Закупка"],
    ["fulfillmentCost", "Фулфилмент"],
    ["deliveryToWarehouseCost", "Доставка до склада"]
  ];

  return (
    <section className="screen">
      <div className="cost-list">
        {products.map((product) => {
          const draft = costDrafts[product.productId] ?? costDraftFor(product);
          const total = draft.purchaseCost + draft.fulfillmentCost + draft.deliveryToWarehouseCost;

          return (
            <article className="cost-item" key={product.productId || product.nmId}>
              <div className="cost-head">
                <ProductImage product={product} />
                <div>
                  <strong>{product.title || product.vendorCode}</strong>
                  <span className="muted-text">{product.vendorCode}</span>
                  {product.costBreakdown && (
                    <span className="muted-text">Текущая цена действует с {dateShort(product.costBreakdown.validFrom)}</span>
                  )}
                  {product.missingCost && <span className="badge badge-warning">себестоимость не указана</span>}
                </div>
              </div>

              <div className="cost-grid">
                {fields.map(([key, label]) => (
                  <label key={key}>
                    <span>{label}</span>
                    <input
                      type="number"
                      min="0"
                      inputMode="decimal"
                      value={draft[key] || ""}
                      placeholder="0"
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => onDraftChange(product, key, Number(event.target.value || 0))}
                    />
                  </label>
                ))}
                <label className="cost-effective-date">
                  <span>Новая цена действует с</span>
                  <div className="date-input-wrap">
                    <CalendarDays size={17} />
                    <input
                      type="date"
                      value={draft.validFrom}
                      onChange={(event) => onDraftChange(product, "validFrom", event.target.value)}
                    />
                  </div>
                </label>
              </div>

              <div className="cost-actions">
                <strong>Итого: {money(total)}</strong>
                <button className="primary-button" onClick={() => onSave(product)} disabled={!product.productId}>
                  <Save size={17} />
                  <span>Сохранить</span>
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Expenses({
  expenses,
  draft,
  onDraftChange,
  onSave,
  onDelete
}: {
  expenses: Awaited<ReturnType<typeof api.expenses>>["expenses"];
  draft: OperatingExpenseInput;
  onDraftChange: (draft: OperatingExpenseInput) => void;
  onSave: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section className="screen">
      <section className="panel">
        <h2>Новый расход</h2>
        <div className="form-grid">
          <label>
            <span>Название</span>
            <input
              value={draft.title}
              onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
            />
          </label>
          <label>
            <span>Категория</span>
            <select
              value={draft.category}
              onChange={(event) => onDraftChange({ ...draft, category: event.target.value })}
            >
              {expenseCategories.map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Сумма</span>
            <input
              type="number"
              min="0"
              inputMode="decimal"
              value={draft.amount}
              onChange={(event) => onDraftChange({ ...draft, amount: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>Тип</span>
            <select
              value={draft.expenseType}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  expenseType: event.target.value as OperatingExpenseInput["expenseType"],
                  recurrenceType: event.target.value === "recurring" ? "monthly" : "none"
                })
              }
            >
              <option value="one_time">Единоразовый</option>
              <option value="recurring">Ежемесячный</option>
            </select>
          </label>
          {draft.expenseType === "one_time" ? (
            <label>
              <span>Дата</span>
              <input
                type="date"
                value={draft.expenseDate || ""}
                onChange={(event) => onDraftChange({ ...draft, expenseDate: event.target.value })}
              />
            </label>
          ) : (
            <label>
              <span>День месяца</span>
              <input
                type="number"
                min="1"
                max="31"
                value={draft.dayOfMonth || 1}
                onChange={(event) => onDraftChange({ ...draft, dayOfMonth: Number(event.target.value) })}
              />
            </label>
          )}
          <label className="wide">
            <span>Способ учёта</span>
            <select
              value={draft.allocationMode}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  allocationMode: event.target.value as OperatingExpenseInput["allocationMode"]
                })
              }
            >
              <option value="store_level_only">Только в общей прибыли магазина</option>
              <option value="by_revenue_share">Распределить по артикулам</option>
            </select>
          </label>
        </div>
        <button className="primary-button full-width" onClick={onSave} disabled={!draft.title || draft.amount <= 0}>
          <CircleDollarSign size={18} />
          <span>Добавить расход</span>
        </button>
      </section>

      <div className="expense-list">
        {expenses.map((expense) => (
          <article className="expense-row" key={expense.id}>
            <div>
              <strong>{expense.title}</strong>
              <span className="muted-text">
                {expense.expenseType === "recurring" ? `ежемесячно, ${expense.dayOfMonth} числа` : "единоразовый"}
              </span>
              <span className="muted-text">
                {expense.allocationMode === "by_revenue_share"
                  ? "распределяется по артикулам"
                  : "только в общей прибыли"}
              </span>
            </div>
            <div className="expense-side">
              <strong>{money(expense.amount)}</strong>
              <button className="icon-button danger" onClick={() => onDelete(expense.id)} aria-label="Удалить">
                <Trash2 size={17} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Deductions({ summary }: { summary: ReportSummary }) {
  return (
    <section className="screen">
      <div className="deduction-list">
        {summary.deductions.map((deduction) => (
          <article className="deduction-row" key={deduction.type}>
            <div>
              <strong>{deduction.type}</strong>
              <span className="muted-text">строк: {deduction.linesCount}</span>
            </div>
            <strong className={deduction.amount > 1000 ? "text-negative" : ""}>{money(deduction.amount)}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}

function SettingsView({
  tokenStatus,
  tokenLast4,
  tokenConnectedAt,
  taxMode,
  tokenDraft,
  onTokenDraftChange,
  onSaveToken,
  onDeleteToken,
  onTaxModeChange
}: {
  tokenStatus: string;
  tokenLast4: string | null;
  tokenConnectedAt: string | null;
  taxMode: TaxMode;
  tokenDraft: string;
  onTokenDraftChange: (value: string) => void;
  onSaveToken: () => void;
  onDeleteToken: () => void;
  onTaxModeChange: (taxMode: TaxMode) => void;
}) {
  return (
    <section className="screen">
      <section className="panel">
        <h2>WB API-токен</h2>
        <div className="token-status">
          <KeyRound size={18} />
          <span>{tokenStatusLabel(tokenStatus)}</span>
        </div>
        {tokenLast4 && (
          <p className="muted-text">
            Текущий токен: ****{tokenLast4}
            {tokenConnectedAt ? ` · подключён ${new Date(tokenConnectedAt).toLocaleString("ru-RU")}` : ""}
          </p>
        )}
        <p className="muted-text">Обязательно: Финансы · Только чтение. Для названий и фото добавьте Контент, для рекламных расходов и ДРР — Продвижение.</p>
        <label>
          <span>{tokenStatus === "valid" ? "Заменить WB API-токен" : "Подключить WB API-токен"}</span>
          <input
            type="password"
            value={tokenDraft}
            onChange={(event) => onTokenDraftChange(event.target.value)}
            autoComplete="off"
          />
        </label>
        <div className="settings-actions">
          <button className="primary-button" onClick={onSaveToken} disabled={tokenDraft.length < 16}>
            <Save size={17} />
            <span>{tokenStatus === "valid" ? "Заменить" : "Подключить"}</span>
          </button>
          <button className="secondary-button danger" onClick={onDeleteToken}>
            <Trash2 size={17} />
            <span>Удалить</span>
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Параметры</h2>
        <label>
          <span>Налоговый режим</span>
          <select value={taxMode} onChange={(event) => onTaxModeChange(event.target.value as TaxMode)}>
            {taxModeOptions.map(([value, label]) => (
              <option value={value} key={value} disabled={value === "none"}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted-text">Расчёт справочный: налог с доходов считается от продаж, а «доходы минус расходы» — от расчётной прибыли отчёта.</p>
      </section>
    </section>
  );
}

function ProductDetail({
  product,
  taxMode,
  detail,
  onClose
}: {
  product: ProductReportItem;
  taxMode: TaxMode;
  detail: Awaited<ReturnType<typeof api.productDetail>> | null;
  onClose: () => void;
}) {
  const [movementMode, setMovementMode] = useState<"days" | "sizes">("days");

  const movementRows = movementMode === "days" ? detail?.byDay ?? [] : detail?.bySize ?? [];

  return (
    <aside className="detail-sheet">
      <div className="detail-bar">
        <button className="icon-button" onClick={onClose} aria-label="Назад">
          <ChevronLeft size={20} />
        </button>
        <strong>{product.vendorCode}</strong>
        <button
          className="icon-button detail-copy"
          type="button"
          title="Копировать артикул WB"
          aria-label="Копировать артикул WB"
          onClick={() => void navigator.clipboard.writeText(String(product.nmId))}
        >
          <Copy size={17} />
        </button>
      </div>

      <div className="detail-content">
        <div className="detail-head">
          <ProductImage product={product} />
          <div>
            <h2>{product.title || product.vendorCode}</h2>
            <span className="muted-text">
              nmId {product.nmId} · {statusLabel(product.status)}
            </span>
          </div>
        </div>

        <MetricSection title="Продажи и выплаты">
          <Metric label="Продажи" value={`${money(product.revenue)} · ${product.unitsSold} шт.`} tone="income" icon={ShoppingBag} />
          <Metric label="Продано / возвраты" value={`${product.unitsSold} / ${product.returns} шт.`} icon={RotateCcw} />
          <Metric label="Выкуп" value={percent(product.buyoutRate)} icon={Percent} />
          <Metric label="К перечислению за товар" value={money(product.goodsForPay)} tone="income" icon={Banknote} />
          <Metric label="Итого к оплате" value={money(product.forPay)} tone="income" icon={CircleDollarSign} />
        </MetricSection>

        <MetricSection title="Расходы">
          <Metric
            label="Комиссия / вознаграждение WB"
            value={moneyAndPercent(product.wbCommission, product.commissionRate)}
            tone="cost"
            icon={BadgePercent}
          />
          <Metric
            label="Все удержания WB"
            value={moneyAndPercent(product.wbCommission + product.wbExpenses, product.wbDeductionsRate)}
            tone="cost"
            icon={Scale}
          />
          <Metric
            label="Логистика"
            value={`${money(product.logistics)} · ${product.logisticsPerUnit === null ? "нет данных" : `${money(product.logisticsPerUnit)}/шт.`}`}
            tone="cost"
            icon={Truck}
          />
          <Metric label="Хранение" value={money(product.storage)} tone="cost" icon={Warehouse} />
          <Metric label="Прочие удержания" value={money(product.otherDeductions)} tone="cost" icon={ReceiptText} />
          <Metric label="Штрафы" value={money(product.penalties)} tone="cost" icon={CircleDollarSign} />
          <Metric label="Продвижение" value={promotionValue(product.adSpend, product.drr)} tone="cost" icon={Megaphone} />
          <Metric label="Себестоимость" value={money(product.productCost)} tone="cost" icon={Boxes} />
          <Metric label="Опер. расходы" value={money(product.operatingExpenses)} tone="cost" icon={WalletCards} />
          <Metric label={taxMetricLabel(taxMode)} value={money(product.tax)} tone="cost" icon={Banknote} />
        </MetricSection>

        <MetricSection title="Результат">
          <Metric
            label="Прибыль"
            value={money(product.finalProfit)}
            tone={product.finalProfit >= 0 ? "positive" : "negative"}
            icon={TrendingUp}
          />
          <Metric label="Маржинальность" value={percent(product.margin)} tone={performanceTone(product.margin)} icon={Percent} />
          <Metric label="ROI" value={percent(product.roi)} tone={performanceTone(product.roi)} icon={BadgePercent} />
        </MetricSection>

        {!detail ? (
          <div className="busy-line">
            <Loader2 className="spin" size={16} />
            <span>Загрузка</span>
          </div>
        ) : (
          <>
            <section className="panel movement-panel">
              <div className="segmented-control" aria-label="Детализация артикула">
                <button className={movementMode === "days" ? "active" : ""} onClick={() => setMovementMode("days")}>По дням</button>
                <button className={movementMode === "sizes" ? "active" : ""} onClick={() => setMovementMode("sizes")}>По размерам</button>
              </div>
              <MovementMatrix items={movementRows} mode={movementMode} />
            </section>
            <details>
              <summary>Удержания WB</summary>
              <div className="small-table">
                <div>
                  <span>Комиссия</span>
                  <span />
                  <span>{money(product.wbCommission)}</span>
                </div>
                <div>
                  <span>Логистика</span>
                  <span />
                  <span>{money(product.logistics)}</span>
                </div>
                <div>
                  <span>Хранение</span>
                  <span />
                  <span>{money(product.storage)}</span>
                </div>
                <div>
                  <span>Прочие удержания</span>
                  <span />
                  <span>{money(product.otherDeductions)}</span>
                </div>
                <div>
                  <span>Штрафы</span>
                  <span />
                  <span>{money(product.penalties)}</span>
                </div>
              </div>
            </details>
          </>
        )}
      </div>
    </aside>
  );
}

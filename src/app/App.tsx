import {
  BarChart3,
  Boxes,
  ChevronLeft,
  CircleDollarSign,
  Database,
  FileUp,
  KeyRound,
  Loader2,
  PackageSearch,
  ReceiptText,
  RefreshCcw,
  Save,
  Settings,
  Trash2,
  WalletCards
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  OperatingExpenseInput,
  ProductCostInput,
  ProductReportItem,
  ReportSummary,
  TaxMode
} from "../shared/types.js";
import { api, readableApiError, type SyncInfo } from "./api.js";
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
  otherUnitCost: 0
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
  ["none", "Не учитывать"],
  ["usn_income_6", "УСН Доходы — 6%"],
  ["usn_income_5", "УСН Доходы — 5% (региональная)"],
  ["usn_income_1", "УСН Доходы — 1% (региональная)"],
  ["usn_profit_15", "УСН Доходы минус расходы — 15%"],
  ["usn_profit_6", "УСН Доходы минус расходы — 6% (региональная)"]
];

function money(value: number) {
  return `${Math.round(value).toLocaleString("ru-RU")} ₽`;
}

function percent(value: number | null) {
  return value === null ? "нет данных" : `${value.toLocaleString("ru-RU")} %`;
}

function dateShort(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit"
  }).format(new Date(value));
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
  tone = "neutral"
}: {
  label: string;
  value: string;
  tone?: "neutral" | "positive" | "warning" | "negative";
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
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
  const [tab, setTab] = useState<Tab>((searchParams.get("tab") as Tab) || "dashboard");
  const [account, setAccount] = useState<{ name: string; tokenStatus: string; taxMode: TaxMode; useDemoData: boolean; version: string } | null>(
    null
  );
  const [reports, setReports] = useState<
    Array<{ id: string; reportId: string; dateFrom: string; dateTo: string; totalForPay: number }>
  >([]);
  const [selectedReportId, setSelectedReportId] = useState(searchParams.get("reportId") || "");
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
  const [buildInfo, setBuildInfo] = useState({ version: import.meta.env.VITE_APP_VERSION || "local", builtAt: import.meta.env.VITE_APP_BUILT_AT || "" });

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

  async function refreshReport(reportId = selectedReportId) {
    if (!reportId) {
      return;
    }
    const response = await api.summary(reportId);
    if ("syncStatus" in response) {
      setCooldownSeconds(Math.max(0, response.retryAfterSeconds));
      setNotice(response.message);
      return;
    }
    const { sync, ...nextSummary } = response;
    setSummary(nextSummary);
    setSelectedReportId(nextSummary.id);
    applySync(sync);
    void api
      .enrichProducts(nextSummary.id)
      .then((result) => {
        if (result.status === "failed_optional" && result.warning) setNotice(result.warning);
      })
      .catch(() => undefined);
  }

  async function refreshExpenses() {
    const payload = await api.expenses();
    setExpenses(payload.expenses);
  }

  async function loadInitial() {
    setLoading(true);
    setError("");
    try {
      const healthPayload = await api.health();
      setBuildInfo({ version: healthPayload.version, builtAt: healthPayload.builtAt });
      const accountPayload = await api.account();
      const reportsPayload = await api.reports();
      setAccount(accountPayload);
      setReports(reportsPayload.reports);
      applySync(reportsPayload.sync);

      const reportId = selectedReportId || reportsPayload.reports[0]?.id || "";
      if (reportId) {
        await refreshReport(reportId);
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
      .productDetail(summary.id, selectedProduct.nmId)
      .then(setProductDetail)
      .catch((caught) => setError(readableApiError(caught)))
      .finally(() => setBusy(false));
  }, [selectedProduct?.nmId, summary?.id]);

  async function handleReportSelect(reportId: string) {
    setSelectedReportId(reportId);
    setSelectedProduct(null);
    setBusy(true);
    setError("");
    try {
      await refreshReport(reportId);
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
      setSelectedReportId(payload.summary.id);
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
      setSelectedReportId(imported.summary.id);
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

  function updateCostDraft(product: ProductReportItem, key: keyof ProductCostInput, value: number) {
    setCostDrafts((drafts) => {
      const current =
        drafts[product.productId] ??
        ({
          ...emptyCost,
          purchaseCost: product.totalUnitCost ?? 0
        } satisfies ProductCostInput);

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
    const draft = costDrafts[product.productId] ?? {
      ...emptyCost,
      purchaseCost: product.totalUnitCost ?? 0
    };

    setBusy(true);
    setError("");
    try {
      await api.saveCost(product.productId, draft);
      await refreshReport();
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
      await refreshReport();
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
      await refreshReport();
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
      setAccount((current) => (current ? { ...current, tokenStatus: payload.tokenStatus } : current));
      setTokenDraft("");
      setNotice(
        [`WB API подключён. Токен сохранён, последние 4 символа: ${payload.last4}.`, payload.warning || null]
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
      setAccount((current) => (current ? { ...current, tokenStatus: "not_connected" } : current));
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
      await refreshReport();
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
        <select
          value={selectedReportId}
          onChange={(event) => void handleReportSelect(event.target.value)}
          aria-label="Отчёт"
          disabled={reports.length === 0}
        >
          {reports.map((report) => (
            <option value={report.id} key={report.id}>
              {dateShort(report.dateFrom)} - {dateShort(report.dateTo)} · {report.reportId}
            </option>
          ))}
        </select>
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
              taxMode={account?.taxMode || "none"}
              version={buildInfo.version || account?.version || "local"}
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

      <div className="metric-grid">
        <Metric label="Продажи" value={money(summary.revenue)} />
        <Metric label="К перечислению за товар" value={money(summary.goodsForPay)} />
        <Metric label="Комиссия WB" value={money(summary.wbCommission)} tone="warning" />
        <Metric label="Расходы WB" value={money(summary.wbExpenses)} tone="warning" />
        <Metric label="Итого к оплате" value={money(summary.forPay)} />
        <Metric label="Себестоимость продаж" value={money(summary.productCost)} />
        <Metric label="Опер. расходы" value={money(summary.operatingExpenses)} tone="warning" />
        <Metric label="Налог" value={money(summary.tax)} tone="warning" />
        <Metric
          label="Прибыль до налога"
          value={money(summary.profitBeforeTax)}
          tone={summary.profitBeforeTax >= 0 ? "positive" : "negative"}
        />
        <Metric
          label="Чистая прибыль"
          value={money(summary.finalProfit)}
          tone={summary.finalProfit >= 0 ? "positive" : "negative"}
        />
        <Metric
          label="До опер. расходов"
          value={money(summary.profitBeforeOperatingExpenses)}
          tone={summary.profitBeforeOperatingExpenses >= 0 ? "positive" : "negative"}
        />
        <Metric label="Маржинальность" value={percent(summary.margin)} />
        <Metric label="ROI" value={percent(summary.roi)} />
      </div>

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
          <option value="wb_expenses_desc">По расходам WB</option>
        </select>
      </div>

      <div className="product-list">
        {products.map((product) => (
          <button className="product-row" key={product.nmId} onClick={() => onSelect(product)}>
            <ProductImage product={product} />
            <div className="product-main">
              <div className="product-title">
                <strong>{product.title || product.vendorCode}</strong>
                <span className={`badge badge-${statusTone(product.status)}`}>{statusLabel(product.status)}</span>
              </div>
              <span className="muted-text">
                {product.vendorCode} · nmId {product.nmId}
              </span>
              <div className="mini-metrics">
                <span>Продано: {product.unitsSold}</span>
                <span>Возвраты: {product.returns}</span>
                <span>Итого к оплате: {money(product.forPay)}</span>
              </div>
            </div>
            <div className="product-profit">
              <strong className={product.finalProfit >= 0 ? "text-positive" : "text-negative"}>
                {money(product.finalProfit)}
              </strong>
              <span>{percent(product.margin)}</span>
            </div>
          </button>
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
  onDraftChange: (product: ProductReportItem, key: keyof ProductCostInput, value: number) => void;
  onSave: (product: ProductReportItem) => void;
}) {
  const fields: Array<[keyof ProductCostInput, string]> = [
    ["purchaseCost", "Закупка"],
    ["packagingCost", "Упаковка"],
    ["fulfillmentCost", "Фулфилмент"],
    ["deliveryToWarehouseCost", "Доставка до склада"],
    ["markingCost", "Маркировка"],
    ["otherUnitCost", "Прочее"]
  ];

  return (
    <section className="screen">
      <div className="cost-list">
        {products.map((product) => {
          const draft = costDrafts[product.productId] ?? {
            ...emptyCost,
            purchaseCost: product.totalUnitCost ?? 0
          };
          const total = Object.values(draft).reduce((sum, value) => sum + Number(value || 0), 0);

          return (
            <article className="cost-item" key={product.productId || product.nmId}>
              <div className="cost-head">
                <ProductImage product={product} />
                <div>
                  <strong>{product.title || product.vendorCode}</strong>
                  <span className="muted-text">{product.vendorCode}</span>
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
                      value={draft[key]}
                      onChange={(event) => onDraftChange(product, key, Number(event.target.value))}
                    />
                  </label>
                ))}
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
  taxMode,
  version,
  tokenDraft,
  onTokenDraftChange,
  onSaveToken,
  onDeleteToken,
  onTaxModeChange
}: {
  tokenStatus: string;
  taxMode: TaxMode;
  version: string;
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
        <label>
          <span>Новый токен</span>
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
            <span>Сохранить</span>
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
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted-text">Расчёт справочный. Для режимов «доходы минус расходы» учитывается минимальный налог 1% от продаж.</p>
        <div className="settings-list">
          <span>Часовой пояс</span>
          <strong>Europe/Moscow</strong>
          <span>Валюта</span>
          <strong>RUB</strong>
          <span>Версия</span>
          <strong>{version}</strong>
        </div>
      </section>
    </section>
  );
}

function ProductDetail({
  product,
  detail,
  onClose
}: {
  product: ProductReportItem;
  detail: Awaited<ReturnType<typeof api.productDetail>> | null;
  onClose: () => void;
}) {
  return (
    <aside className="detail-sheet">
      <div className="detail-bar">
        <button className="icon-button" onClick={onClose} aria-label="Назад">
          <ChevronLeft size={20} />
        </button>
        <strong>{product.vendorCode}</strong>
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

        <div className="metric-grid">
          <Metric label="Продажи" value={money(product.revenue)} />
          <Metric label="К перечислению за товар" value={money(product.goodsForPay)} />
          <Metric label="Комиссия WB" value={money(product.wbCommission)} tone="warning" />
          <Metric label="Итого к оплате" value={money(product.forPay)} />
          <Metric label="Себестоимость" value={money(product.productCost)} />
          <Metric label="Расходы WB" value={money(product.wbExpenses)} tone="warning" />
          <Metric label="Налог" value={money(product.tax)} tone="warning" />
          <Metric label="ROI" value={percent(product.roi)} />
          <Metric label="Опер. расходы" value={money(product.operatingExpenses)} tone="warning" />
          <Metric
            label="Прибыль"
            value={money(product.finalProfit)}
            tone={product.finalProfit >= 0 ? "positive" : "negative"}
          />
        </div>

        {!detail ? (
          <div className="busy-line">
            <Loader2 className="spin" size={16} />
            <span>Загрузка</span>
          </div>
        ) : (
          <>
            <details open>
              <summary>По размерам</summary>
              <div className="small-table">
                {detail.bySize.map((item) => (
                  <div key={item.size}>
                    <span>{item.size}</span>
                    <span>{item.units}</span>
                    <span>{money(item.forPay)}</span>
                  </div>
                ))}
              </div>
            </details>
            <details>
              <summary>Расходы WB</summary>
              <div className="small-table">
                <div>
                  <span>Комиссия</span>
                  <span />
                  <span>{money(detail.lines.reduce((sum, line) => sum + line.commission, 0))}</span>
                </div>
                <div>
                  <span>Логистика</span>
                  <span />
                  <span>{money(detail.lines.reduce((sum, line) => sum + line.deliveryService, 0))}</span>
                </div>
                <div>
                  <span>Хранение</span>
                  <span />
                  <span>{money(detail.lines.reduce((sum, line) => sum + line.storageFee, 0))}</span>
                </div>
                <div>
                  <span>Штрафы и удержания</span>
                  <span />
                  <span>
                    {money(detail.lines.reduce((sum, line) => sum + line.penalty + line.deduction, 0))}
                  </span>
                </div>
              </div>
            </details>
            <details>
              <summary>Операции</summary>
              <div className="operations-table">
                <div className="operations-head">
                  <span>Дата</span>
                  <span>Тип</span>
                  <span>Размер</span>
                  <span>Кол-во</span>
                  <span>К перечислению</span>
                </div>
                {detail.lines.map((line) => (
                  <div className="operations-row" key={line.id}>
                    <span>{line.operationDate ? dateShort(line.operationDate) : "-"}</span>
                    <span>{line.operationType || "-"}</span>
                    <span>{line.size || "-"}</span>
                    <span>{line.quantity}</span>
                    <span>{money(line.forPay)}</span>
                  </div>
                ))}
              </div>
            </details>
          </>
        )}
      </div>
    </aside>
  );
}

import type {
  DeductionsSummaryItem,
  ProductReportItem,
  ReportSummary,
  TaxMode
} from "../shared/types.js";
import { prisma } from "./db.js";
import { saleQuantityFromReportRow } from "./normalizer.js";

type Expense = {
  id: string;
  title: string;
  category: string;
  amount: number;
  expenseType: string;
  recurrenceType: string;
  expenseDate: Date | null;
  dayOfMonth: number | null;
  allocationMode: string;
  active: boolean;
};

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundMargin(value: number | null) {
  return value === null ? null : Math.round(value * 10) / 10;
}

function startOfDay(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfDay(date: Date) {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

function isBetween(date: Date, dateFrom: Date, dateTo: Date) {
  return date >= startOfDay(dateFrom) && date <= endOfDay(dateTo);
}

function monthsBetween(dateFrom: Date, dateTo: Date) {
  const months: Array<{ year: number; month: number }> = [];
  const cursor = new Date(dateFrom.getFullYear(), dateFrom.getMonth(), 1);
  const end = new Date(dateTo.getFullYear(), dateTo.getMonth(), 1);

  while (cursor <= end) {
    months.push({ year: cursor.getFullYear(), month: cursor.getMonth() });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return months;
}

function monthlyChargeHitsPeriod(expense: Expense, dateFrom: Date, dateTo: Date) {
  const day = expense.dayOfMonth ?? expense.expenseDate?.getDate() ?? 1;

  return monthsBetween(dateFrom, dateTo).some(({ year, month }) => {
    const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
    const chargeDate = new Date(year, month, Math.min(day, lastDayOfMonth));
    return isBetween(chargeDate, dateFrom, dateTo);
  });
}

function expenseAppliesToReport(expense: Expense, dateFrom: Date, dateTo: Date) {
  if (!expense.active) {
    return false;
  }

  if (expense.expenseType === "one_time") {
    return expense.expenseDate ? isBetween(expense.expenseDate, dateFrom, dateTo) : false;
  }

  if (expense.expenseType === "recurring" && expense.recurrenceType === "monthly") {
    return monthlyChargeHitsPeriod(expense, dateFrom, dateTo);
  }

  return false;
}

function getStatus(finalProfit: number, margin: number | null, missingCost: boolean) {
  if (missingCost) {
    return "missing_cost" as const;
  }

  if (finalProfit < 0) {
    return "loss" as const;
  }

  if (margin !== null && margin < 10) {
    return "weak_margin" as const;
  }

  return "profitable" as const;
}

type FinancialLine = {
  operationType: string | null;
  retailAmount: number;
  forPay: number;
  deliveryService: number;
  storageFee: number;
  acceptanceFee: number;
  penalty: number;
  deduction: number;
  additionalPayment: number;
};

type QuantityLine = {
  rawJson: string;
  operationType: string | null;
  quantity: number;
};

function correctedSaleQuantity(line: QuantityLine) {
  try {
    const raw = JSON.parse(line.rawJson) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return saleQuantityFromReportRow(raw as Record<string, unknown>, line.operationType, line.quantity);
    }
  } catch {
    // Older imported rows can have malformed raw metadata; fall back to normalized fields.
  }

  return saleQuantityFromReportRow({}, line.operationType, line.quantity);
}

function isReturnOperation(operationType: string | null) {
  const normalized = operationType?.toLowerCase() ?? "";
  return normalized.includes("возврат") || normalized.includes("return");
}

function signedTransactionAmount(value: number, operationType: string | null) {
  return isReturnOperation(operationType) ? -Math.abs(value) : value;
}

function financialsOfLine(line: FinancialLine) {
  const revenue = signedTransactionAmount(line.retailAmount, line.operationType);
  const goodsForPay = signedTransactionAmount(line.forPay, line.operationType);
  const logistics = line.deliveryService;
  const storage = line.storageFee;
  const otherDeductions = line.acceptanceFee + line.deduction - line.additionalPayment;
  const penalties = line.penalty;
  const serviceExpenses = logistics + storage + otherDeductions + penalties;
  const payout = goodsForPay - serviceExpenses;

  return {
    revenue,
    goodsForPay,
    wbCommission: revenue - goodsForPay,
    payout,
    wbExpenses: serviceExpenses,
    logistics,
    storage,
    otherDeductions,
    penalties
  };
}

const TAX_MODES = new Set<TaxMode>([
  "none",
  "usn_income_1",
  "usn_income_6",
  "usn_profit_5",
  "usn_profit_15"
]);

export function normalizeTaxMode(value: string): TaxMode {
  if (value === "usn_profit_6") return "usn_profit_5";
  return TAX_MODES.has(value as TaxMode) ? (value as TaxMode) : "none";
}

function calculateTax(mode: TaxMode, revenue: number, profitBeforeTax: number) {
  const income = Math.max(0, revenue);
  if (mode === "usn_income_1") return income * 0.01;
  if (mode === "usn_income_6") return income * 0.06;
  if (mode === "usn_profit_5" || mode === "usn_profit_15") {
    const rate = mode === "usn_profit_5" ? 0.05 : 0.15;
    return Math.max(0, profitBeforeTax) * rate;
  }
  return 0;
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function buildInsights(summary: Omit<ReportSummary, "insights">) {
  const insights: string[] = [];

  insights.push(
    summary.finalProfit >= 0
      ? `Чистая прибыль положительная: ${summary.finalProfit.toLocaleString("ru-RU")} ₽.`
      : `Отчет в минусе: ${summary.finalProfit.toLocaleString("ru-RU")} ₽.`
  );

  const expenseCandidates = [
    ["логистика", summary.logistics],
    ["хранение", summary.storage],
    ["прочие удержания", summary.otherDeductions],
    ["штрафы", summary.penalties],
    ["себестоимость", summary.productCost],
    ["операционные расходы", summary.operatingExpenses],
    ["налог", summary.tax]
  ] as const;
  const biggestExpense = expenseCandidates.toSorted((a, b) => b[1] - a[1])[0];
  if (biggestExpense && biggestExpense[1] > 0) {
    insights.push(`Самая заметная статья расходов: ${biggestExpense[0]}.`);
  }

  if (summary.missingCostProducts > 0) {
    insights.push(`Без себестоимости: ${summary.missingCostProducts} товаров, прибыль по ним неполная.`);
  }

  if (summary.lossProducts > 0) {
    insights.push(`В минус ушли ${summary.lossProducts} артикула.`);
  }

  if (summary.operatingExpenses > 0) {
    insights.push(
      `Операционные расходы снизили прибыль на ${roundMoney(summary.operatingExpenses).toLocaleString("ru-RU")} ₽.`
    );
  }

  if (summary.tax > 0) {
    insights.push(`Расчётный налог: ${roundMoney(summary.tax).toLocaleString("ru-RU")} ₽.`);
  }

  return insights;
}

function buildDeductions(lines: Array<{
  deliveryService: number;
  storageFee: number;
  acceptanceFee: number;
  penalty: number;
  deduction: number;
}>) {
  const groups = new Map<string, DeductionsSummaryItem>();
  const definitions: Array<[string, keyof (typeof lines)[number]]> = [
    ["Логистика", "deliveryService"],
    ["Хранение", "storageFee"],
    ["Приемка", "acceptanceFee"],
    ["Штрафы", "penalty"],
    ["Прочие удержания", "deduction"]
  ];

  for (const line of lines) {
    for (const [type, key] of definitions) {
      const amount = Number(line[key]) || 0;
      if (amount <= 0) {
        continue;
      }

      const current = groups.get(type) ?? { type, amount: 0, linesCount: 0 };
      current.amount += amount;
      current.linesCount += 1;
      groups.set(type, current);
    }
  }

  return [...groups.values()]
    .map((item) => ({ ...item, amount: roundMoney(item.amount) }))
    .toSorted((a, b) => b.amount - a.amount);
}

export async function calculateReportSummary(reportId: string, accountId?: string): Promise<ReportSummary> {
  const report = await prisma.financialReport.findFirst({
    where: {
      id: reportId,
      ...(accountId ? { wbAccountId: accountId } : {})
    },
    include: {
      wbAccount: {
        include: {
          operatingExpenses: true
        }
      },
      lines: {
        include: {
          product: {
            include: {
              costs: {
                orderBy: { validFrom: "desc" },
                take: 1
              }
            }
          }
        }
      }
    }
  });

  if (!report) {
    throw new Error("Report not found.");
  }

  const productGroups = new Map<number, typeof report.lines>();
  for (const line of report.lines) {
    if (line.nmId <= 0) continue;
    const current = productGroups.get(line.nmId) ?? [];
    current.push(line);
    productGroups.set(line.nmId, current);
  }

  const applicableExpenses = report.wbAccount.operatingExpenses.filter((expense) =>
    expenseAppliesToReport(expense, report.dateFrom, report.dateTo)
  );

  const storeLevelOperatingExpenses = applicableExpenses
    .filter((expense) => expense.allocationMode === "store_level_only")
    .reduce((sum, expense) => sum + expense.amount, 0);

  const byRevenueShareExpenses = applicableExpenses
    .filter((expense) => expense.allocationMode === "by_revenue_share")
    .reduce((sum, expense) => sum + expense.amount, 0);

  const preProducts = [...productGroups.entries()].map(([nmId, lines]) => {
    const product = lines.find((line) => line.product)?.product ?? null;
    const quantities = lines.map((line) => correctedSaleQuantity(line));
    const unitsSold = quantities.reduce((sum, quantity) => sum + Math.max(0, quantity), 0);
    const returns = Math.abs(quantities.reduce((sum, quantity) => sum + Math.min(0, quantity), 0));
    const financials = lines.map(financialsOfLine);
    const revenue = financials.reduce((sum, line) => sum + line.revenue, 0);
    const goodsForPay = financials.reduce((sum, line) => sum + line.goodsForPay, 0);
    const wbCommission = financials.reduce((sum, line) => sum + line.wbCommission, 0);
    const payout = financials.reduce((sum, line) => sum + line.payout, 0);
    const wbExpenses = financials.reduce((sum, line) => sum + line.wbExpenses, 0);
    const logistics = financials.reduce((sum, line) => sum + line.logistics, 0);
    const storage = financials.reduce((sum, line) => sum + line.storage, 0);
    const otherDeductions = financials.reduce((sum, line) => sum + line.otherDeductions, 0);
    const penalties = financials.reduce((sum, line) => sum + line.penalties, 0);
    const savedCost = product?.costs[0] ?? null;
    const costBreakdown = savedCost
      ? {
          purchaseCost: savedCost.purchaseCost,
          packagingCost: 0,
          fulfillmentCost: savedCost.fulfillmentCost,
          deliveryToWarehouseCost: savedCost.deliveryToWarehouseCost,
          markingCost: 0,
          otherUnitCost: 0
        }
      : null;
    const totalUnitCost = costBreakdown
      ? costBreakdown.purchaseCost + costBreakdown.fulfillmentCost + costBreakdown.deliveryToWarehouseCost
      : null;
    const missingCost = totalUnitCost === null || totalUnitCost <= 0;
    const productCost = missingCost ? 0 : totalUnitCost * Math.max(0, unitsSold - returns);

    return {
      product,
      nmId,
      vendorCode: product?.vendorCode ?? lines[0]?.vendorCode ?? `nm-${nmId}`,
      title: product?.title ?? null,
      brand: product?.brand ?? null,
      subjectName: product?.subjectName ?? null,
      photoUrl: product?.photoUrl ?? null,
      unitsSold,
      returns,
      revenue,
      goodsForPay,
      wbCommission,
      payout,
      wbExpenses,
      logistics,
      storage,
      otherDeductions,
      penalties,
      totalUnitCost,
      costBreakdown,
      missingCost,
      productCost,
      linesCount: lines.length
    };
  });

  const allocationBase = preProducts.reduce((sum, item) => sum + Math.max(0, item.revenue || item.payout), 0);
  const accountLevelWbExpenses = report.lines
    .filter((line) => line.nmId <= 0)
    .reduce((sum, line) => sum + financialsOfLine(line).wbExpenses, 0);
  const accountLevelBreakdown = report.lines
    .filter((line) => line.nmId <= 0)
    .map(financialsOfLine)
    .reduce(
      (totals, line) => ({
        logistics: totals.logistics + line.logistics,
        storage: totals.storage + line.storage,
        otherDeductions: totals.otherDeductions + line.otherDeductions,
        penalties: totals.penalties + line.penalties
      }),
      { logistics: 0, storage: 0, otherDeductions: 0, penalties: 0 }
    );

  const preTaxProducts = preProducts.map((item) => {
    const shareBase = Math.max(0, item.revenue || item.payout);
    const share = allocationBase > 0 ? shareBase / allocationBase : 0;
    const allocatedWbExpenses = accountLevelWbExpenses * share;
    const operatingExpenses =
      allocationBase > 0 ? byRevenueShareExpenses * share : 0;
    const payout = item.payout - allocatedWbExpenses;
    const wbExpenses = item.wbExpenses + allocatedWbExpenses;
    const logistics = item.logistics + accountLevelBreakdown.logistics * share;
    const storage = item.storage + accountLevelBreakdown.storage * share;
    const otherDeductions = item.otherDeductions + accountLevelBreakdown.otherDeductions * share;
    const penalties = item.penalties + accountLevelBreakdown.penalties * share;
    const profitBeforeOperatingExpenses = payout - item.productCost;
    const profitBeforeTax = profitBeforeOperatingExpenses - operatingExpenses;
    return {
      ...item,
      payout,
      wbExpenses,
      logistics,
      storage,
      otherDeductions,
      penalties,
      operatingExpenses,
      profitBeforeOperatingExpenses,
      profitBeforeTax,
      share
    };
  });

  const reportFinancials = report.lines.map(financialsOfLine);
  const totalRevenue = reportFinancials.reduce((sum, line) => sum + line.revenue, 0);
  const totalGoodsForPay = reportFinancials.reduce((sum, line) => sum + line.goodsForPay, 0);
  const totalWbCommission = reportFinancials.reduce((sum, line) => sum + line.wbCommission, 0);
  const totalForPay = reportFinancials.reduce((sum, line) => sum + line.payout, 0);
  const totalWbExpenses = reportFinancials.reduce((sum, line) => sum + line.wbExpenses, 0);
  const totalLogistics = reportFinancials.reduce((sum, line) => sum + line.logistics, 0);
  const totalStorage = reportFinancials.reduce((sum, line) => sum + line.storage, 0);
  const totalOtherDeductions = reportFinancials.reduce((sum, line) => sum + line.otherDeductions, 0);
  const totalPenalties = reportFinancials.reduce((sum, line) => sum + line.penalties, 0);
  const totalProductCost = preTaxProducts.reduce((sum, item) => sum + item.productCost, 0);
  const totalOperatingExpenses = storeLevelOperatingExpenses + byRevenueShareExpenses;
  const profitBeforeOperatingExpenses = totalForPay - totalProductCost;
  const profitBeforeTax = profitBeforeOperatingExpenses - totalOperatingExpenses;
  const taxMode = normalizeTaxMode(report.wbAccount.taxMode);
  const tax = calculateTax(taxMode, totalRevenue, profitBeforeTax);
  const finalNetProfit = profitBeforeTax - tax;
  const margin = totalRevenue > 0 ? (finalNetProfit / totalRevenue) * 100 : null;
  const roi = totalProductCost > 0 ? (finalNetProfit / totalProductCost) * 100 : null;

  const products: ProductReportItem[] = preTaxProducts.map((item) => {
    const productTax = tax * item.share;
    const finalProfit = item.profitBeforeTax - productTax;
    const margin = item.revenue > 0 ? (finalProfit / item.revenue) * 100 : null;
    const roi = item.productCost > 0 ? (finalProfit / item.productCost) * 100 : null;

    return {
      productId: item.product?.id ?? "",
      nmId: item.nmId,
      vendorCode: item.vendorCode,
      title: item.title,
      brand: item.brand,
      subjectName: item.subjectName,
      photoUrl: item.photoUrl,
      unitsSold: item.unitsSold,
      returns: item.returns,
      revenue: roundMoney(item.revenue),
      goodsForPay: roundMoney(item.goodsForPay),
      wbCommission: roundMoney(item.wbCommission),
      forPay: roundMoney(item.payout),
      wbExpenses: roundMoney(item.wbExpenses),
      logistics: roundMoney(item.logistics),
      storage: roundMoney(item.storage),
      otherDeductions: roundMoney(item.otherDeductions),
      penalties: roundMoney(item.penalties),
      productCost: roundMoney(item.productCost),
      operatingExpenses: roundMoney(item.operatingExpenses),
      tax: roundMoney(productTax),
      profitBeforeOperatingExpenses: roundMoney(item.profitBeforeOperatingExpenses),
      profitBeforeTax: roundMoney(item.profitBeforeTax),
      finalProfit: roundMoney(finalProfit),
      margin: roundMargin(margin),
      roi: roundMargin(roi),
      totalUnitCost: item.totalUnitCost,
      costBreakdown: item.costBreakdown,
      missingCost: item.missingCost,
      status: getStatus(finalProfit, margin, item.missingCost),
      linesCount: item.linesCount
    };
  });

  const summaryWithoutInsights = {
    id: report.id,
    reportId: report.reportId,
    dateFrom: toIsoDate(report.dateFrom),
    dateTo: toIsoDate(report.dateTo),
    taxMode,
    revenue: roundMoney(totalRevenue),
    goodsForPay: roundMoney(totalGoodsForPay),
    wbCommission: roundMoney(totalWbCommission),
    forPay: roundMoney(totalForPay),
    wbExpenses: roundMoney(totalWbExpenses),
    logistics: roundMoney(totalLogistics),
    storage: roundMoney(totalStorage),
    otherDeductions: roundMoney(totalOtherDeductions),
    penalties: roundMoney(totalPenalties),
    productCost: roundMoney(totalProductCost),
    operatingExpenses: roundMoney(totalOperatingExpenses),
    tax: roundMoney(tax),
    profitBeforeOperatingExpenses: roundMoney(profitBeforeOperatingExpenses),
    profitBeforeTax: roundMoney(profitBeforeTax),
    finalProfit: roundMoney(finalNetProfit),
    margin: roundMargin(margin),
    roi: roundMargin(roi),
    totalProducts: products.length,
    missingCostProducts: products.filter((item) => item.missingCost).length,
    lossProducts: products.filter((item) => item.status === "loss").length,
    weakMarginProducts: products.filter((item) => item.status === "weak_margin").length,
    storeLevelOperatingExpenses: roundMoney(storeLevelOperatingExpenses),
    allocatedOperatingExpenses: roundMoney(byRevenueShareExpenses),
    products: products.toSorted((a, b) => b.finalProfit - a.finalProfit),
    deductions: buildDeductions(report.lines)
  };

  return {
    ...summaryWithoutInsights,
    insights: buildInsights(summaryWithoutInsights)
  };
}

export async function getReportProductDetail(reportId: string, nmId: number, accountId?: string) {
  const summary = await calculateReportSummary(reportId, accountId);
  const product = summary.products.find((item) => item.nmId === nmId);

  if (!product) {
    throw new Error("Product not found in report.");
  }

  const lines = await prisma.financialReportLine.findMany({
    where: {
      financialReportId: reportId,
      nmId
    },
    orderBy: [{ operationDate: "asc" }, { createdAt: "asc" }]
  });

  const bySize = new Map<string, { size: string; units: number; forPay: number; profitHint: number }>();
  for (const line of lines) {
    const amounts = financialsOfLine(line);
    const saleQuantity = correctedSaleQuantity(line);
    const size = line.size || "Без размера";
    const current = bySize.get(size) ?? { size, units: 0, forPay: 0, profitHint: 0 };
    current.units += saleQuantity;
    current.forPay += amounts.payout;
    current.profitHint += amounts.payout;
    bySize.set(size, current);
  }

  return {
    product,
    bySize: [...bySize.values()].map((item) => ({
      ...item,
      forPay: roundMoney(item.forPay),
      profitHint: roundMoney(item.profitHint)
    })),
    lines: lines.map((line) => {
      const amounts = financialsOfLine(line);
      return {
        id: line.id,
        operationDate: line.operationDate?.toISOString() ?? null,
        operationType: line.operationType,
        barcode: line.barcode,
        size: line.size,
        quantity: correctedSaleQuantity(line),
        retailAmount: amounts.revenue,
        forPay: amounts.payout,
        commission: signedTransactionAmount(line.commission, line.operationType),
        deliveryService: line.deliveryService,
        storageFee: line.storageFee,
        acceptanceFee: line.acceptanceFee,
        penalty: line.penalty,
        deduction: line.deduction,
        additionalPayment: line.additionalPayment
      };
    })
  };
}

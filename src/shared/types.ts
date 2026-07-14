export type AllocationMode = "store_level_only" | "by_revenue_share" | "by_quantity_sold" | "manual";
export type ExpenseType = "one_time" | "recurring";
export type RecurrenceType = "none" | "monthly" | "weekly" | "yearly";
export type TaxMode =
  | "none"
  | "usn_income_1"
  | "usn_income_6"
  | "usn_profit_5"
  | "usn_profit_15";

export type NormalizedReportLineInput = {
  nmId: number;
  vendorCode: string;
  barcode?: string | null;
  size?: string | null;
  operationDate?: string | null;
  operationType?: string | null;
  quantity: number;
  retailAmount: number;
  forPay: number;
  commission: number;
  deliveryService: number;
  storageFee: number;
  acceptanceFee: number;
  penalty: number;
  deduction: number;
  additionalPayment: number;
  raw: Record<string, unknown>;
};

export type ReportImportPayload = {
  reportId?: string;
  dateFrom?: string;
  dateTo?: string;
  source?: "local_import" | "demo" | "wb";
  lines: Record<string, unknown>[];
};

export type ProductCostInput = {
  purchaseCost: number;
  packagingCost: number;
  fulfillmentCost: number;
  deliveryToWarehouseCost: number;
  markingCost: number;
  otherUnitCost: number;
  validFrom: string;
};

export type OperatingExpenseInput = {
  title: string;
  category: string;
  amount: number;
  expenseType: ExpenseType;
  recurrenceType?: RecurrenceType;
  expenseDate?: string | null;
  dayOfMonth?: number | null;
  allocationMode: AllocationMode;
  active?: boolean;
};

export type MoneyBreakdown = {
  revenue: number;
  goodsForPay: number;
  wbCommission: number;
  forPay: number;
  wbExpenses: number;
  logistics: number;
  storage: number;
  otherDeductions: number;
  penalties: number;
  adSpend: number | null;
  drr: number | null;
  wbDeductionsRate: number | null;
  commissionRate: number | null;
  logisticsPerUnit: number | null;
  buyoutRate: number | null;
  productCost: number;
  operatingExpenses: number;
  tax: number;
  profitBeforeOperatingExpenses: number;
  profitBeforeTax: number;
  finalProfit: number;
  margin: number | null;
  roi: number | null;
};

export type ProductReportItem = MoneyBreakdown & {
  productId: string;
  nmId: number;
  vendorCode: string;
  title: string | null;
  brand: string | null;
  subjectName: string | null;
  photoUrl: string | null;
  unitsSold: number;
  returns: number;
  totalUnitCost: number | null;
  costBreakdown: ProductCostInput | null;
  missingCost: boolean;
  status: "profitable" | "weak_margin" | "loss" | "missing_cost";
  linesCount: number;
};

export type DeductionsSummaryItem = {
  type: string;
  amount: number;
  linesCount: number;
};

export type ReportSummary = MoneyBreakdown & {
  id: string;
  reportId: string;
  reportIds: string[];
  reportCount: number;
  dateFrom: string;
  dateTo: string;
  taxMode: TaxMode;
  promotionStatus: "ready" | "partial" | "not_connected" | "missing_rights" | "rate_limited" | "loading" | "unavailable";
  promotionWarning: string | null;
  unitsSold: number;
  returns: number;
  totalProducts: number;
  missingCostProducts: number;
  lossProducts: number;
  weakMarginProducts: number;
  storeLevelOperatingExpenses: number;
  allocatedOperatingExpenses: number;
  insights: string[];
  products: ProductReportItem[];
  deductions: DeductionsSummaryItem[];
};

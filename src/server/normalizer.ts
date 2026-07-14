import type { NormalizedReportLineInput } from "../shared/types.js";

const NUMBER_KEYS = {
  nmId: ["nmId", "nmID", "nm_id", "nmid", "nm", "Номенклатура"],
  retailAmount: [
    "retailAmount",
    "retailPriceWithDisc",
    "retail_amount",
    "retail_amount_withdisc_rub",
    "retail_price_withdisc_rub",
    "sale_sum",
    "Продажи"
  ],
  forPay: [
    "forPay",
    "for_pay",
    "ppvz_for_pay",
    "seller_reward",
    "amount_pay",
    "for_pay_nds",
    "К перечислению"
  ],
  commission: [
    "commission",
    "ppvzSalesCommission",
    "ppvz_sales_commission",
    "sales_commission",
    "commission_percent_amount",
    "Комиссия"
  ],
  deliveryService: [
    "deliveryService",
    "delivery_service",
    "delivery_rub",
    "delivery_amount",
    "logistics",
    "Логистика"
  ],
  storageFee: ["paidStorage", "storageFee", "storage_fee", "storage", "Хранение"],
  acceptanceFee: ["paidAcceptance", "acceptanceFee", "acceptance_fee", "acceptance", "paid_acceptance", "Приемка"],
  penalty: ["penalty", "штраф", "Штраф"],
  deduction: ["deduction", "deductions", "holding", "Удержание", "Удержания"],
  additionalPayment: ["additionalPayment", "additional_payment", "additional_pay", "Доплата"],
  quantity: ["quantity", "qty", "sale_quantity", "count", "Кол-во", "Количество"]
} as const;

const STRING_KEYS = {
  vendorCode: ["vendorCode", "vendor_code", "supplierArticle", "sa_name", "Артикул продавца"],
  barcode: ["barcode", "bar_code", "sku", "Штрихкод"],
  size: ["techSize", "size", "tech_size", "ts_name", "Размер"],
  operationDate: ["rrDate", "saleDt", "orderDt", "operationDate", "operation_dt", "rr_dt", "sale_dt", "order_dt", "Дата"],
  operationType: ["docTypeName", "sellerOperName", "operationType", "supplier_oper_name", "doc_type_name", "operation", "Операция"]
} as const;

function getValue(row: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return row[key];
    }
  }

  const lowerCaseEntries = Object.entries(row).map(([key, value]) => [key.toLowerCase(), value] as const);

  for (const key of keys) {
    const found = lowerCaseEntries.find(([entryKey]) => entryKey === key.toLowerCase());
    if (found && found[1] !== undefined && found[1] !== null && found[1] !== "") {
      return found[1];
    }
  }

  return undefined;
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/\s/g, "").replace(",", ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function toInteger(value: unknown) {
  return Math.trunc(toNumber(value));
}

function toStringValue(value: unknown) {
  if (value === undefined || value === null) {
    return null;
  }

  return String(value).trim() || null;
}

function isReturnOperation(operationType: string | null) {
  if (!operationType) {
    return false;
  }

  const normalized = operationType.toLowerCase();
  return normalized.includes("возврат") || normalized.includes("return");
}

function isSaleOperation(operationType: string | null) {
  if (!operationType) {
    return false;
  }

  const normalized = operationType.toLowerCase();
  return normalized.includes("продаж") || normalized.includes("sale");
}

function signedTransactionAmount(value: number, operationType: string | null) {
  return isReturnOperation(operationType) ? -Math.abs(value) : value;
}

export function normalizeReportLine(row: Record<string, unknown>): NormalizedReportLineInput | null {
  const operationType = toStringValue(getValue(row, STRING_KEYS.operationType));
  const nmId = toInteger(getValue(row, NUMBER_KEYS.nmId));
  const retailAmount = toNumber(getValue(row, NUMBER_KEYS.retailAmount));
  const forPay = toNumber(getValue(row, NUMBER_KEYS.forPay));
  const commission = toNumber(getValue(row, NUMBER_KEYS.commission));
  const deliveryService = toNumber(getValue(row, NUMBER_KEYS.deliveryService));
  const storageFee = toNumber(getValue(row, NUMBER_KEYS.storageFee));
  const acceptanceFee = toNumber(getValue(row, NUMBER_KEYS.acceptanceFee));
  const penalty = toNumber(getValue(row, NUMBER_KEYS.penalty));
  const deduction = toNumber(getValue(row, NUMBER_KEYS.deduction));
  const additionalPayment = toNumber(getValue(row, NUMBER_KEYS.additionalPayment));
  const vendorCode =
    toStringValue(getValue(row, STRING_KEYS.vendorCode)) || (nmId ? `nm-${nmId}` : "Общие расходы WB");

  const hasFinancialData = [
    retailAmount,
    forPay,
    commission,
    deliveryService,
    storageFee,
    acceptanceFee,
    penalty,
    deduction,
    additionalPayment
  ].some((value) => value !== 0);

  if (!nmId && !hasFinancialData) {
    return null;
  }

  const rawQuantity = toInteger(getValue(row, NUMBER_KEYS.quantity));
  const quantity =
    rawQuantity !== 0
      ? isReturnOperation(operationType) && rawQuantity > 0
        ? -rawQuantity
        : rawQuantity
      : isReturnOperation(operationType)
        ? -1
        : isSaleOperation(operationType)
          ? 1
          : 0;

  return {
    nmId,
    vendorCode,
    barcode: toStringValue(getValue(row, STRING_KEYS.barcode)),
    size: toStringValue(getValue(row, STRING_KEYS.size)),
    operationDate: toStringValue(getValue(row, STRING_KEYS.operationDate)),
    operationType,
    quantity,
    retailAmount: signedTransactionAmount(retailAmount, operationType),
    forPay: signedTransactionAmount(forPay, operationType),
    commission: signedTransactionAmount(commission, operationType),
    deliveryService,
    storageFee,
    acceptanceFee,
    penalty,
    deduction,
    additionalPayment,
    raw: row
  };
}

export function normalizeReportLines(rows: Record<string, unknown>[]) {
  return rows.flatMap((row) => {
    const normalized = normalizeReportLine(row);
    return normalized ? [normalized] : [];
  });
}

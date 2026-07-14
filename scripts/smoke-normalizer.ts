import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeReportLine } from "../src/server/normalizer.js";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/wb-finance-camelcase.json", import.meta.url), "utf8")
) as Record<string, unknown>;
const camelCase = normalizeReportLine(fixture);
assert.ok(camelCase, "camelCase fixture must normalize");
assert.equal(camelCase.nmId, 100200300);
assert.equal(camelCase.vendorCode, "VV-NEW-42");
assert.equal(camelCase.barcode, "4601234567890");
assert.equal(camelCase.size, "42");
assert.equal(camelCase.operationType, "Продажа");
assert.equal(camelCase.quantity, 2);
assert.equal(camelCase.retailAmount, 3499.5);
assert.equal(camelCase.forPay, 2110.75);
assert.equal(camelCase.commission, 524.93);
assert.equal(camelCase.deliveryService, 245.1);
assert.equal(camelCase.storageFee, 14.25);
assert.equal(camelCase.acceptanceFee, 4.5);
assert.equal(camelCase.penalty, 9.75);
assert.equal(camelCase.deduction, 12);
assert.equal(camelCase.additionalPayment, 3.5);

const snakeCase = normalizeReportLine({
  realizationreport_id: "legacy-1",
  rrd_id: "8",
  nm_id: "111",
  sa_name: "LEGACY-111",
  barcode: "4600000000111",
  tech_size: "41",
  doc_type_name: "Продажа",
  quantity: "1",
  retail_amount: "1000,50",
  ppvz_sales_commission: "100.25",
  ppvz_for_pay: "700.75",
  delivery_rub: "50.25",
  storage_fee: "10",
  acceptance_fee: "2",
  penalty: "1",
  deduction: "3",
  additional_payment: "4",
  rr_dt: "2026-07-10"
});
assert.ok(snakeCase, "snake_case fixture must normalize");
assert.equal(snakeCase.forPay, 700.75);
assert.equal(snakeCase.deliveryService, 50.25);
assert.equal(snakeCase.commission, 100.25);
assert.equal(snakeCase.storageFee, 10);
assert.equal(snakeCase.deduction, 3);

const returned = normalizeReportLine({
  nmId: 100200300,
  vendorCode: "RETURN-42",
  docTypeName: "Возврат",
  quantity: 2,
  retailAmount: 1000,
  forPay: 700,
  ppvzSalesCommission: 100
});
assert.ok(returned, "return row must normalize");
assert.equal(returned.quantity, -2);
assert.equal(returned.retailAmount, -1000);
assert.equal(returned.forPay, -700);
assert.equal(returned.commission, -100);

const logistics = normalizeReportLine({
  nmId: 100200300,
  vendorCode: "LOGISTICS-42",
  docTypeName: "Продажа",
  sellerOperName: "Логистика",
  quantity: 2,
  deliveryService: 245
});
assert.ok(logistics, "logistics row must normalize");
assert.equal(logistics.quantity, 0);
assert.equal(logistics.operationType, "Логистика");

const transportReimbursement = normalizeReportLine({
  nmId: 100200300,
  vendorCode: "REIMBURSEMENT-42",
  sellerOperName: "Возмещение издержек по перевозке/по складским операциям с товаром",
  quantity: 17_620
});
assert.ok(transportReimbursement, "transport reimbursement row must normalize");
assert.equal(transportReimbursement.quantity, 0);

const sharedStorage = normalizeReportLine({
  nmId: 0,
  sellerOperName: "Хранение",
  paidStorage: 4663.97
});
assert.ok(sharedStorage, "account-level WB expense must not be dropped");
assert.equal(sharedStorage.nmId, 0);
assert.equal(sharedStorage.quantity, 0);
assert.equal(sharedStorage.storageFee, 4663.97);

console.log("normalizer: sale quantities, return signs and WB expense rows verified");

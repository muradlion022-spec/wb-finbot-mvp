import assert from "node:assert/strict";
import { productCostAt, totalProductUnitCost, type ProductCostVersion } from "../src/server/productCosts.js";

const costs: ProductCostVersion[] = [
  {
    purchaseCost: 100,
    fulfillmentCost: 20,
    deliveryToWarehouseCost: 10,
    validFrom: new Date("2026-07-01T00:00:00.000Z"),
    validTo: new Date("2026-07-15T00:00:00.000Z")
  },
  {
    purchaseCost: 150,
    fulfillmentCost: 20,
    deliveryToWarehouseCost: 10,
    validFrom: new Date("2026-07-15T00:00:00.000Z"),
    validTo: null
  }
];

assert.equal(totalProductUnitCost(productCostAt(costs, new Date("2026-06-20T12:00:00.000Z"))!), 130);
assert.equal(totalProductUnitCost(productCostAt(costs, new Date("2026-07-14T23:59:59.000Z"))!), 130);
assert.equal(totalProductUnitCost(productCostAt(costs, new Date("2026-07-15T00:00:00.000Z"))!), 180);
assert.equal(productCostAt([], new Date()), null);

console.log("cost history: old reports keep the old price and the new price starts on the selected date");

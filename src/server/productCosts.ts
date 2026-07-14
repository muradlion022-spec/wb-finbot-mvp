import type { ProductCostInput } from "../shared/types.js";
import { prisma } from "./db.js";

export type ProductCostVersion = {
  id?: string;
  purchaseCost: number;
  fulfillmentCost: number;
  deliveryToWarehouseCost: number;
  validFrom: Date;
  validTo: Date | null;
};

export function totalProductUnitCost(cost: Pick<ProductCostVersion, "purchaseCost" | "fulfillmentCost" | "deliveryToWarehouseCost">) {
  return cost.purchaseCost + cost.fulfillmentCost + cost.deliveryToWarehouseCost;
}

export function productCostAt(costs: ProductCostVersion[], operationDate: Date) {
  if (costs.length === 0) return null;
  const ordered = [...costs].sort((left, right) => left.validFrom.getTime() - right.validFrom.getTime());
  const matched = ordered.find(
    (cost) => cost.validFrom <= operationDate && (!cost.validTo || operationDate < cost.validTo)
  );
  if (matched) return matched;

  // Existing MVP costs were saved on entry day without a historical start date.
  // Treat the earliest saved price as the old price for earlier reports.
  if (operationDate < ordered[0].validFrom) return ordered[0];
  return [...ordered].reverse().find((cost) => cost.validFrom <= operationDate) ?? ordered[0];
}

function dateAtUtcStart(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

export async function saveProductCostVersion(productId: string, accountId: string, input: ProductCostInput) {
  const product = await prisma.product.findFirst({
    where: { id: productId, wbAccountId: accountId },
    select: { id: true }
  });
  if (!product) return null;

  const validFrom = dateAtUtcStart(input.validFrom);
  const existing = await prisma.productCost.findMany({
    where: { productId },
    orderBy: { validFrom: "asc" }
  });
  const exact = [...existing].reverse().find((cost) => cost.validFrom.toISOString().slice(0, 10) === input.validFrom);
  const boundary = exact?.validFrom ?? validFrom;
  const previous = [...existing].reverse().find((cost) => cost.id !== exact?.id && cost.validFrom < boundary);
  const next = existing.find((cost) => cost.id !== exact?.id && cost.validFrom > boundary);
  const values = {
    purchaseCost: input.purchaseCost,
    packagingCost: 0,
    fulfillmentCost: input.fulfillmentCost,
    deliveryToWarehouseCost: input.deliveryToWarehouseCost,
    markingCost: 0,
    otherUnitCost: 0,
    totalUnitCost: input.purchaseCost + input.fulfillmentCost + input.deliveryToWarehouseCost,
    validTo: next?.validFrom ?? null
  };

  return prisma.$transaction(async (transaction) => {
    if (exact) {
      return transaction.productCost.update({ where: { id: exact.id }, data: values });
    }
    if (previous && previous.validTo?.getTime() !== validFrom.getTime()) {
      await transaction.productCost.update({ where: { id: previous.id }, data: { validTo: validFrom } });
    }
    return transaction.productCost.create({ data: { productId, ...values, validFrom } });
  });
}

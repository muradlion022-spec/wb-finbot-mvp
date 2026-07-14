import { getOrCreateLocalAccount } from "./defaults.js";
import { prisma } from "./db.js";
import { importReport } from "./reports.js";

const demoLines = [
  {
    nmId: 101001,
    vendorCode: "WB-TEE-BLACK",
    title: "Футболка oversize черная",
    brand: "Local Basic",
    subjectName: "Футболки",
    size: "M",
    operationDate: "2026-06-17",
    operationType: "Продажа",
    quantity: 7,
    retailAmount: 12600,
    forPay: 9130,
    commission: 1512,
    deliveryService: 840,
    storageFee: 96,
    acceptanceFee: 0,
    penalty: 0,
    deduction: 0
  },
  {
    nmId: 101001,
    vendorCode: "WB-TEE-BLACK",
    title: "Футболка oversize черная",
    brand: "Local Basic",
    subjectName: "Футболки",
    size: "L",
    operationDate: "2026-06-18",
    operationType: "Продажа",
    quantity: 5,
    retailAmount: 9000,
    forPay: 6520,
    commission: 1080,
    deliveryService: 610,
    storageFee: 70,
    acceptanceFee: 0,
    penalty: 0,
    deduction: 0
  },
  {
    nmId: 101001,
    vendorCode: "WB-TEE-BLACK",
    title: "Футболка oversize черная",
    brand: "Local Basic",
    subjectName: "Футболки",
    size: "M",
    operationDate: "2026-06-20",
    operationType: "Возврат",
    quantity: -1,
    retailAmount: -1800,
    forPay: -1280,
    commission: -216,
    deliveryService: 160,
    storageFee: 12,
    acceptanceFee: 0,
    penalty: 0,
    deduction: 0
  },
  {
    nmId: 202002,
    vendorCode: "WB-BAG-SHOPPER",
    title: "Шоппер хлопковый",
    brand: "Local Basic",
    subjectName: "Сумки",
    size: "ONE",
    operationDate: "2026-06-18",
    operationType: "Продажа",
    quantity: 11,
    retailAmount: 15400,
    forPay: 10210,
    commission: 1848,
    deliveryService: 1650,
    storageFee: 154,
    acceptanceFee: 320,
    penalty: 0,
    deduction: 0
  },
  {
    nmId: 202002,
    vendorCode: "WB-BAG-SHOPPER",
    title: "Шоппер хлопковый",
    brand: "Local Basic",
    subjectName: "Сумки",
    size: "ONE",
    operationDate: "2026-06-21",
    operationType: "Удержание",
    quantity: 0,
    retailAmount: 0,
    forPay: 0,
    commission: 0,
    deliveryService: 0,
    storageFee: 0,
    acceptanceFee: 0,
    penalty: 0,
    deduction: 1300
  },
  {
    nmId: 303003,
    vendorCode: "WB-HOODIE-GRAY",
    title: "Худи серое",
    brand: "Street Seed",
    subjectName: "Толстовки",
    size: "S",
    operationDate: "2026-06-19",
    operationType: "Продажа",
    quantity: 3,
    retailAmount: 10500,
    forPay: 4210,
    commission: 1260,
    deliveryService: 690,
    storageFee: 95,
    acceptanceFee: 0,
    penalty: 1200,
    deduction: 0
  },
  {
    nmId: 404004,
    vendorCode: "WB-SOCKS-SET",
    title: "Набор носков",
    brand: "Street Seed",
    subjectName: "Носки",
    size: "42-44",
    operationDate: "2026-06-20",
    operationType: "Продажа",
    quantity: 16,
    retailAmount: 9600,
    forPay: 5960,
    commission: 1152,
    deliveryService: 1760,
    storageFee: 88,
    acceptanceFee: 0,
    penalty: 0,
    deduction: 0
  }
];

export async function bootstrapDemo(options: { reset?: boolean } = {}) {
  const account = await getOrCreateLocalAccount();

  if (options.reset) {
    await prisma.financialReport.deleteMany({ where: { wbAccountId: account.id } });
    await prisma.operatingExpense.deleteMany({ where: { wbAccountId: account.id } });
    await prisma.productCost.deleteMany({
      where: {
        product: {
          wbAccountId: account.id
        }
      }
    });
    await prisma.product.deleteMany({ where: { wbAccountId: account.id } });
  }

  const report = await importReport({
    reportId: "demo-2026-06-17-2026-06-23",
    dateFrom: "2026-06-17",
    dateTo: "2026-06-23",
    lines: demoLines
  });

  const products = await prisma.product.findMany({
    where: { wbAccountId: account.id }
  });

  const costsByVendorCode = new Map([
    [
      "WB-TEE-BLACK",
      {
        purchaseCost: 520,
        packagingCost: 35,
        fulfillmentCost: 55,
        deliveryToWarehouseCost: 20,
        markingCost: 8,
        otherUnitCost: 0
      }
    ],
    [
      "WB-BAG-SHOPPER",
      {
        purchaseCost: 430,
        packagingCost: 28,
        fulfillmentCost: 45,
        deliveryToWarehouseCost: 16,
        markingCost: 7,
        otherUnitCost: 0
      }
    ],
    [
      "WB-HOODIE-GRAY",
      {
        purchaseCost: 1550,
        packagingCost: 45,
        fulfillmentCost: 80,
        deliveryToWarehouseCost: 35,
        markingCost: 8,
        otherUnitCost: 50
      }
    ]
  ]);

  for (const product of products) {
    const cost = costsByVendorCode.get(product.vendorCode);
    if (!cost) {
      continue;
    }

    const totalUnitCost = Object.values(cost).reduce((sum, value) => sum + value, 0);
    await prisma.productCost.create({
      data: {
        productId: product.id,
        ...cost,
        totalUnitCost,
        validFrom: new Date("2026-06-01")
      }
    });
  }

  if (options.reset) {
    await prisma.operatingExpense.createMany({
      data: [
        {
          wbAccountId: account.id,
          title: "Склад",
          category: "warehouse",
          amount: 30000,
          expenseType: "recurring",
          recurrenceType: "monthly",
          dayOfMonth: 20,
          allocationMode: "store_level_only"
        },
        {
          wbAccountId: account.id,
          title: "Сервис аналитики",
          category: "services",
          amount: 3000,
          expenseType: "recurring",
          recurrenceType: "monthly",
          dayOfMonth: 18,
          allocationMode: "by_revenue_share"
        },
        {
          wbAccountId: account.id,
          title: "Дизайнер карточек",
          category: "designer",
          amount: 5000,
          expenseType: "one_time",
          recurrenceType: "none",
          expenseDate: new Date("2026-06-19"),
          allocationMode: "store_level_only"
        }
      ]
    });
  }

  return report;
}

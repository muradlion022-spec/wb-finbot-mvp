import "dotenv/config";
import { prisma } from "../src/server/db.js";
import { getOrCreateTelegramAccount } from "../src/server/defaults.js";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const telegramUserId = option("--telegram-user-id");
const apply = process.argv.includes("--apply");
const confirmation = option("--confirm");

if (!telegramUserId || !/^\d+$/.test(telegramUserId)) {
  throw new Error("Usage: node --import tsx scripts/migrate-demo-account.ts --telegram-user-id <Telegram ID> [--apply --confirm telegram-<Telegram ID>]");
}

const source = await prisma.wbAccount.findUnique({ where: { id: "local-demo-account" } });
if (!source) {
  console.log("local-demo-account not found; nothing to migrate.");
  process.exit(0);
}

const targetId = `telegram-${telegramUserId}`;
const [reports, products, expenses, costs, targetReports, targetProducts, targetExpenses] = await Promise.all([
  prisma.financialReport.count({ where: { wbAccountId: source.id } }),
  prisma.product.count({ where: { wbAccountId: source.id } }),
  prisma.operatingExpense.count({ where: { wbAccountId: source.id } }),
  prisma.productCost.count({ where: { product: { wbAccountId: source.id } } }),
  prisma.financialReport.count({ where: { wbAccountId: targetId } }),
  prisma.product.count({ where: { wbAccountId: targetId } }),
  prisma.operatingExpense.count({ where: { wbAccountId: targetId } })
]);

console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      sourceAccountId: source.id,
      targetAccountId: targetId,
      token: source.encryptedApiToken ? { present: true, last4: source.tokenLast4 ?? null } : { present: false },
      move: { reports, products, costs, expenses },
      targetExistingData: { reports: targetReports, products: targetProducts, expenses: targetExpenses }
    },
    null,
    2
  )
);

if (!apply) {
  console.log("Dry run only. Add --apply --confirm " + targetId + " to perform the migration.");
  process.exit(0);
}

if (confirmation !== targetId) {
  throw new Error(`Refusing to migrate without --confirm ${targetId}.`);
}
if (targetReports || targetProducts || targetExpenses) {
  throw new Error("Refusing to merge demo data into a Telegram account that already has data.");
}

const target = await getOrCreateTelegramAccount({ telegramId: telegramUserId });

await prisma.$transaction(async (tx) => {
  await tx.wbAccount.update({
    where: { id: target.id },
    data: {
      encryptedApiToken: source.encryptedApiToken,
      tokenStatus: source.tokenStatus,
      taxMode: source.taxMode,
      tokenLast4: source.tokenLast4,
      tokenConnectedAt: source.tokenConnectedAt,
      reportsSyncedAt: source.reportsSyncedAt,
      reportsSyncError: source.reportsSyncError
    }
  });
  await tx.financialReport.updateMany({ where: { wbAccountId: source.id }, data: { wbAccountId: target.id } });
  await tx.product.updateMany({ where: { wbAccountId: source.id }, data: { wbAccountId: target.id } });
  await tx.operatingExpense.updateMany({ where: { wbAccountId: source.id }, data: { wbAccountId: target.id } });
  await tx.wbAccount.update({
    where: { id: source.id },
    data: {
      encryptedApiToken: null,
      tokenStatus: "not_connected",
      tokenLast4: null,
      tokenConnectedAt: null,
      reportsSyncedAt: null,
      reportsSyncError: null
    }
  });
});

console.log(`Migration completed: ${source.id} -> ${targetId}.`);

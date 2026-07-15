import { prisma } from "./db.js";
import { WbApiError, WbClient } from "./wbClient.js";

export type PromotionStatus =
  | "ready"
  | "partial"
  | "not_connected"
  | "missing_rights"
  | "rate_limited"
  | "loading"
  | "unavailable";

export type PromotionSpendSnapshot = {
  status: PromotionStatus;
  warning: string | null;
  byNmId: Map<number, number>;
  total: number;
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LOCK_TTL_MS = 90 * 1000;
const CACHE_VERSION = "v2";

function dayStart(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function dayEnd(value: string) {
  return new Date(`${value}T23:59:59.999Z`);
}

function endpointType(dateFrom: string, dateTo: string) {
  return `promotion-${CACHE_VERSION}:${dateFrom}:${dateTo}`;
}

async function clearLegacyPromotionCache(accountId: string) {
  const legacyState = await prisma.wbSyncState.findFirst({
    where: { wbAccountId: accountId, endpointType: { startsWith: "promotion:" } },
    select: { id: true }
  });
  if (!legacyState) return;

  await prisma.$transaction([
    prisma.wbSyncState.deleteMany({
      where: { wbAccountId: accountId, endpointType: { startsWith: "promotion:" } }
    }),
    prisma.promotionSpendDaily.deleteMany({ where: { wbAccountId: accountId } })
  ]);
}

function statusForError(code: string | null): PromotionStatus {
  if (code === "missing_promotion_rights") return "missing_rights";
  if (code === "rate_limited") return "rate_limited";
  return "unavailable";
}

function warningForStatus(status: PromotionStatus) {
  if (status === "missing_rights") {
    return "Добавьте токену категорию Продвижение: Только чтение, чтобы увидеть рекламные расходы и ДРР.";
  }
  if (status === "rate_limited") return "WB временно ограничил статистику продвижения. Показываем сохранённые данные.";
  if (status === "loading") return "Статистика продвижения уже обновляется. Показываем сохранённые данные.";
  if (status === "unavailable") return "Статистика продвижения временно недоступна. Финансовый отчёт продолжает работать.";
  return null;
}

async function cachedSnapshot(accountId: string, dateFrom: string, dateTo: string) {
  const rows = await prisma.promotionSpendDaily.findMany({
    where: {
      wbAccountId: accountId,
      date: { gte: dayStart(dateFrom), lte: dayEnd(dateTo) }
    }
  });
  const byNmId = new Map<number, number>();
  for (const row of rows) {
    byNmId.set(row.nmId, (byNmId.get(row.nmId) ?? 0) + row.amount);
  }
  return {
    byNmId,
    total: [...byNmId.values()].reduce((sum, amount) => sum + amount, 0)
  };
}

export async function getPromotionSpendSnapshot(
  accountId: string,
  dateFrom: string,
  dateTo: string
): Promise<PromotionSpendSnapshot> {
  await clearLegacyPromotionCache(accountId);
  const account = await prisma.wbAccount.findUnique({
    where: { id: accountId },
    select: { encryptedApiToken: true, tokenConnectedAt: true }
  });
  const cached = await cachedSnapshot(accountId, dateFrom, dateTo);
  if (!account?.encryptedApiToken) {
    return { status: "not_connected", warning: null, ...cached };
  }

  const key = endpointType(dateFrom, dateTo);
  const state = await prisma.wbSyncState.findUnique({
    where: { wbAccountId_endpointType: { wbAccountId: accountId, endpointType: key } }
  });
  const now = new Date();
  const stateIsForCurrentToken = !state || !account.tokenConnectedAt || state.updatedAt >= account.tokenConnectedAt;
  if (stateIsForCurrentToken && state?.lastSuccessAt && now.getTime() - state.lastSuccessAt.getTime() < CACHE_TTL_MS) {
    const status = state.lastErrorCode === "partial" ? "partial" : "ready";
    return {
      status,
      warning: status === "partial" ? "ДРР рассчитан по доступной части периода или кампаний." : null,
      ...cached
    };
  }
  if (stateIsForCurrentToken && state?.lockedAt && now.getTime() - state.lockedAt.getTime() < LOCK_TTL_MS) {
    return { status: "loading", warning: warningForStatus("loading"), ...cached };
  }
  if (stateIsForCurrentToken && state?.cooldownUntil && state.cooldownUntil > now) {
    return { status: "rate_limited", warning: warningForStatus("rate_limited"), ...cached };
  }
  if (stateIsForCurrentToken && state?.status === "failed" && now.getTime() - state.updatedAt.getTime() < CACHE_TTL_MS) {
    const status = statusForError(state.lastErrorCode);
    return { status, warning: warningForStatus(status), ...cached };
  }

  await prisma.wbSyncState.upsert({
    where: { wbAccountId_endpointType: { wbAccountId: accountId, endpointType: key } },
    create: { wbAccountId: accountId, endpointType: key, status: "loading", lockedAt: now },
    update: { status: "loading", lockedAt: now, lastErrorCode: null, retryAfterSeconds: null }
  });

  try {
    const result = await new WbClient(account.encryptedApiToken).getPromotionSpend(dateFrom, dateTo);
    const syncedFrom = dayStart(result.syncedDateFrom);
    const syncedTo = dayEnd(result.syncedDateTo);
    await prisma.$transaction(async (tx) => {
      await tx.promotionSpendDaily.deleteMany({
        where: { wbAccountId: accountId, date: { gte: syncedFrom, lte: syncedTo } }
      });
      if (result.rows.length > 0) {
        await tx.promotionSpendDaily.createMany({
          data: result.rows.map((row) => ({
            wbAccountId: accountId,
            date: dayStart(row.date),
            nmId: row.nmId,
            amount: row.amount
          }))
        });
      }
      await tx.wbSyncState.update({
        where: { wbAccountId_endpointType: { wbAccountId: accountId, endpointType: key } },
        data: {
          status: "ready",
          lockedAt: null,
          cooldownUntil: null,
          lastSuccessAt: now,
          lastErrorCode: result.partial ? "partial" : null,
          retryAfterSeconds: null
        }
      });
    });
    const refreshed = await cachedSnapshot(accountId, dateFrom, dateTo);
    return {
      status: result.partial ? "partial" : "ready",
      warning: result.warning ?? null,
      ...refreshed
    };
  } catch (error) {
    const code = error instanceof WbApiError ? error.code : "api_error";
    const retryAfterSeconds = code === "rate_limited" ? 60 : null;
    await prisma.wbSyncState.update({
      where: { wbAccountId_endpointType: { wbAccountId: accountId, endpointType: key } },
      data: {
        status: "failed",
        lockedAt: null,
        cooldownUntil: retryAfterSeconds ? new Date(Date.now() + retryAfterSeconds * 1000) : null,
        lastErrorCode: code,
        retryAfterSeconds
      }
    });
    const status = statusForError(code);
    return { status, warning: warningForStatus(status), ...cached };
  }
}

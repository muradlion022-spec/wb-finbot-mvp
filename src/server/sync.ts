import { prisma } from "./db.js";

export const WB_SYNC_COOLDOWN_MS = 65_000;
const WB_SYNC_LOCK_TTL_MS = 120_000;

export type WbEndpointType = "sales-reports-list" | "sales-reports-detailed" | "content-cards";

export type SyncLease =
  | { acquired: true; retryAfterSeconds: 0 }
  | {
      acquired: false;
      status: "loading" | "cooldown";
      retryAfterSeconds: number;
    };

export function secondsUntil(value: Date | null | undefined, now = Date.now()) {
  if (!value) {
    return 0;
  }
  return Math.max(0, Math.ceil((value.getTime() - now) / 1000));
}

export async function acquireWbSync(accountId: string, endpointType: WbEndpointType): Promise<SyncLease> {
  const now = new Date();
  const state = await prisma.wbSyncState.upsert({
    where: {
      wbAccountId_endpointType: {
        wbAccountId: accountId,
        endpointType
      }
    },
    create: {
      wbAccountId: accountId,
      endpointType
    },
    update: {}
  });

  const cooldownSeconds = secondsUntil(state.cooldownUntil, now.getTime());
  if (cooldownSeconds > 0) {
    return { acquired: false, status: "cooldown", retryAfterSeconds: cooldownSeconds };
  }

  const staleBefore = new Date(now.getTime() - WB_SYNC_LOCK_TTL_MS);
  const locked = await prisma.wbSyncState.updateMany({
    where: {
      id: state.id,
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }]
    },
    data: {
      status: "loading",
      lockedAt: now,
      retryAfterSeconds: null,
      lastErrorCode: null
    }
  });

  if (locked.count > 0) {
    return { acquired: true, retryAfterSeconds: 0 };
  }

  const current = await prisma.wbSyncState.findUniqueOrThrow({ where: { id: state.id } });
  const currentCooldown = secondsUntil(current.cooldownUntil, now.getTime());
  if (currentCooldown > 0) {
    return { acquired: false, status: "cooldown", retryAfterSeconds: currentCooldown };
  }

  return {
    acquired: false,
    status: "loading",
    retryAfterSeconds: Math.max(1, secondsUntil(new Date((current.lockedAt?.getTime() ?? now.getTime()) + WB_SYNC_LOCK_TTL_MS), now.getTime()))
  };
}

export async function completeWbSync(accountId: string, endpointType: WbEndpointType) {
  const now = new Date();
  const cooldownUntil = new Date(now.getTime() + WB_SYNC_COOLDOWN_MS);
  await prisma.wbSyncState.update({
    where: {
      wbAccountId_endpointType: {
        wbAccountId: accountId,
        endpointType
      }
    },
    data: {
      status: "ready",
      lockedAt: null,
      cooldownUntil,
      lastSuccessAt: now,
      lastErrorCode: null,
      retryAfterSeconds: secondsUntil(cooldownUntil, now.getTime())
    }
  });
  return { completedAt: now, cooldownUntil };
}

export async function failWbSync(accountId: string, endpointType: WbEndpointType, errorCode: string) {
  const now = new Date();
  const rateLimited = errorCode === "rate_limited";
  const cooldownUntil = rateLimited ? new Date(now.getTime() + WB_SYNC_COOLDOWN_MS) : null;
  await prisma.wbSyncState.update({
    where: {
      wbAccountId_endpointType: {
        wbAccountId: accountId,
        endpointType
      }
    },
    data: {
      status: rateLimited ? "rate_limited" : "failed",
      lockedAt: null,
      cooldownUntil,
      lastErrorCode: errorCode,
      retryAfterSeconds: cooldownUntil ? secondsUntil(cooldownUntil, now.getTime()) : null
    }
  });
  return { cooldownUntil, retryAfterSeconds: secondsUntil(cooldownUntil, now.getTime()) };
}

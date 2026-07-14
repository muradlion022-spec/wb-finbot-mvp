ALTER TABLE "WbAccount" ADD COLUMN "reportsSyncedAt" TIMESTAMP(3);
ALTER TABLE "WbAccount" ADD COLUMN "reportsSyncError" TEXT;

ALTER TABLE "FinancialReport" ADD COLUMN "detailsSyncedAt" TIMESTAMP(3);
ALTER TABLE "FinancialReport" ADD COLUMN "lastRrdId" TEXT;
ALTER TABLE "FinancialReport" ADD COLUMN "syncStatus" TEXT NOT NULL DEFAULT 'not_loaded';
ALTER TABLE "FinancialReport" ADD COLUMN "contentEnrichmentStatus" TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE "FinancialReport" ADD COLUMN "contentEnrichmentError" TEXT;

CREATE TABLE "WbSyncState" (
  "id" TEXT NOT NULL,
  "wbAccountId" TEXT NOT NULL,
  "endpointType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'not_loaded',
  "lockedAt" TIMESTAMP(3),
  "cooldownUntil" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "retryAfterSeconds" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WbSyncState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WbSyncState_wbAccountId_endpointType_key" ON "WbSyncState"("wbAccountId", "endpointType");
CREATE INDEX "WbSyncState_wbAccountId_cooldownUntil_idx" ON "WbSyncState"("wbAccountId", "cooldownUntil");
ALTER TABLE "WbSyncState" ADD CONSTRAINT "WbSyncState_wbAccountId_fkey" FOREIGN KEY ("wbAccountId") REFERENCES "WbAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

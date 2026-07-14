CREATE TABLE "PromotionSpendDaily" (
  "id" TEXT NOT NULL,
  "wbAccountId" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "nmId" INTEGER NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PromotionSpendDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PromotionSpendDaily_wbAccountId_date_nmId_key"
  ON "PromotionSpendDaily"("wbAccountId", "date", "nmId");
CREATE INDEX "PromotionSpendDaily_wbAccountId_date_idx"
  ON "PromotionSpendDaily"("wbAccountId", "date");
CREATE INDEX "PromotionSpendDaily_wbAccountId_nmId_date_idx"
  ON "PromotionSpendDaily"("wbAccountId", "nmId", "date");

ALTER TABLE "PromotionSpendDaily"
  ADD CONSTRAINT "PromotionSpendDaily_wbAccountId_fkey"
  FOREIGN KEY ("wbAccountId") REFERENCES "WbAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

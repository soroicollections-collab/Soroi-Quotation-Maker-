-- CreateTable
CREATE TABLE "RateCardSeason" (
    "id" TEXT NOT NULL,
    "rateCardId" TEXT NOT NULL,
    "seasonName" TEXT NOT NULL,
    "dateRangeStart" TIMESTAMP(3) NOT NULL,
    "dateRangeEnd" TIMESTAMP(3) NOT NULL,
    "rawLabel" TEXT,

    CONSTRAINT "RateCardSeason_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateCardSeason_rateCardId_seasonName_idx" ON "RateCardSeason"("rateCardId", "seasonName");

-- AddForeignKey
ALTER TABLE "RateCardSeason" ADD CONSTRAINT "RateCardSeason_rateCardId_fkey" FOREIGN KEY ("rateCardId") REFERENCES "RateCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

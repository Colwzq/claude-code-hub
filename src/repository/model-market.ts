import "server-only";

import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { modelPrices, providerGroups, providers, usageLedger } from "@/drizzle/schema";
import type {
  ModelMarketPriceRow,
  ModelMarketProviderRow,
  ModelMarketUsageRow,
} from "@/lib/model-market";
import { buildModelMarket, MODEL_MARKET_CACHE_TTL_SECONDS } from "@/lib/model-market";
import type { ModelMarketResponse } from "@/types/model-market";
import { LEDGER_BILLING_CONDITION } from "./_shared/ledger-conditions";

interface ModelMarketCacheEntry {
  expiresAt: number;
  data: ModelMarketResponse;
}

let cacheEntry: ModelMarketCacheEntry | null = null;

export async function getModelMarket() {
  const now = Date.now();
  if (cacheEntry && cacheEntry.expiresAt > now) {
    return cacheEntry.data;
  }

  const providerRows = await db
    .select({
      id: providers.id,
      costMultiplier: providers.costMultiplier,
      allowedModels: providers.allowedModels,
    })
    .from(providers)
    .where(and(eq(providers.isEnabled, true), isNull(providers.deletedAt)));

  const priceRows = await db
    .select({
      modelName: modelPrices.modelName,
      priceData: modelPrices.priceData,
      source: modelPrices.source,
      updatedAt: modelPrices.updatedAt,
    })
    .from(modelPrices)
    .orderBy(
      modelPrices.modelName,
      sql`(${modelPrices.source} = 'manual') DESC`,
      desc(modelPrices.updatedAt),
      desc(modelPrices.id)
    );

  const [defaultGroup] = await db
    .select({ costMultiplier: providerGroups.costMultiplier })
    .from(providerGroups)
    .where(eq(providerGroups.name, "default"))
    .limit(1);

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const usageRows = await db
    .select({
      model: usageLedger.model,
      requests30d: sql<number>`COUNT(*)::int`,
      inputTokens30d: sql<number>`COALESCE(SUM(${usageLedger.inputTokens}), 0)::double precision`,
      outputTokens30d: sql<number>`COALESCE(SUM(${usageLedger.outputTokens}), 0)::double precision`,
      cacheWriteTokens30d: sql<number>`COALESCE(SUM(COALESCE(${usageLedger.cacheCreationInputTokens}, COALESCE(${usageLedger.cacheCreation5mInputTokens}, 0) + COALESCE(${usageLedger.cacheCreation1hInputTokens}, 0))), 0)::double precision`,
      cacheReadTokens30d: sql<number>`COALESCE(SUM(${usageLedger.cacheReadInputTokens}), 0)::double precision`,
    })
    .from(usageLedger)
    .where(
      and(
        gte(usageLedger.createdAt, since),
        sql`${usageLedger.model} IS NOT NULL`,
        LEDGER_BILLING_CONDITION
      )
    )
    .groupBy(usageLedger.model);

  const data = buildModelMarket({
    providers: providerRows as ModelMarketProviderRow[],
    prices: priceRows as ModelMarketPriceRow[],
    usage: usageRows.flatMap((row): ModelMarketUsageRow[] =>
      row.model
        ? [
            {
              model: row.model,
              requests30d: Number(row.requests30d),
              inputTokens30d: Number(row.inputTokens30d),
              outputTokens30d: Number(row.outputTokens30d),
              cacheWriteTokens30d: Number(row.cacheWriteTokens30d),
              cacheReadTokens30d: Number(row.cacheReadTokens30d),
            },
          ]
        : []
    ),
    defaultGroupMultiplier: defaultGroup?.costMultiplier ?? "1.0",
  });

  cacheEntry = {
    expiresAt: now + MODEL_MARKET_CACHE_TTL_SECONDS * 1000,
    data,
  };

  return data;
}

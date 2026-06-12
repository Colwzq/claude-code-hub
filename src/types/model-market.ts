export interface ModelMarketModel {
  model: string;
  company: string;
  finalInputPer1M: number;
  finalOutputPer1M: number;
  finalCacheWritePer1M: number | null;
  finalCacheReadPer1M: number | null;
  averageCostPer1MTokens: number | null;
  cacheHitRate30d: number | null;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  requests30d: number;
  totalTokens30d: number;
}

export interface ModelMarketSummary {
  modelCount: number;
  priceUpdatedAt: string | null;
  generatedAt: string;
  cacheTtlSeconds: number;
  statsWindowDays: number;
  currency: "USD";
  unit: "$/1M tokens";
  pricingGroup: "default";
}

export interface ModelMarketResponse {
  summary: ModelMarketSummary;
  models: ModelMarketModel[];
}

import type { ModelMarketModel, ModelMarketResponse } from "@/types/model-market";
import type { ModelPriceData, ModelPriceSource } from "@/types/model-price";
import type { AllowedModelRuleInput } from "@/types/provider";
import { normalizeAllowedModelRules } from "./allowed-model-rules";

const TOKEN_PRICE_UNIT = 1_000_000;
export const MODEL_MARKET_STATS_WINDOW_DAYS = 30;
export const MODEL_MARKET_CACHE_TTL_SECONDS = 300;

export interface ModelMarketProviderRow {
  id: number;
  costMultiplier: string | number | null;
  allowedModels: AllowedModelRuleInput[] | null;
}

export interface ModelMarketPriceRow {
  modelName: string;
  priceData: ModelPriceData;
  source: ModelPriceSource;
  updatedAt: Date | null;
}

export interface ModelMarketUsageRow {
  model: string;
  requests30d: number;
  inputTokens30d: number;
  outputTokens30d: number;
  cacheWriteTokens30d: number;
  cacheReadTokens30d: number;
}

interface AllowedExactModel {
  model: string;
  providerMultiplier: number;
}

export interface BuildModelMarketInput {
  providers: ModelMarketProviderRow[];
  prices: ModelMarketPriceRow[];
  usage: ModelMarketUsageRow[];
  defaultGroupMultiplier: string | number | null;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveMultiplier(value: unknown): number {
  const parsed = toFiniteNumber(value, 1);
  return parsed >= 0 ? parsed : 1;
}

function toOptionalFiniteNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function perTokenToPer1M(value: unknown, multiplier: number): number | null {
  const cost = toOptionalFiniteNumber(value);
  if (cost === null) return null;
  return cost * TOKEN_PRICE_UNIT * multiplier;
}

function roundPrice(value: number): number {
  return Number(value.toFixed(6));
}

function maxNullable(values: Array<number | null>): number | null {
  const numeric = values.filter((value): value is number => value !== null);
  return numeric.length > 0 ? Math.max(...numeric) : null;
}

function getExactAllowedModels(providers: ModelMarketProviderRow[]): AllowedExactModel[] {
  return providers.flatMap((provider) => {
    const rules = normalizeAllowedModelRules(provider.allowedModels) ?? [];
    return rules
      .filter((rule) => rule.matchType === "exact")
      .map((rule) => ({
        model: rule.pattern,
        providerMultiplier: toPositiveMultiplier(provider.costMultiplier),
      }));
  });
}

function companyLabel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  if (!normalized) return "Other";

  if (normalized === "anthropic" || normalized === "claude" || normalized.startsWith("claude")) {
    return "Anthropic";
  }
  if (
    normalized === "openai" ||
    normalized === "azure" ||
    normalized === "azure-openai" ||
    normalized === "gpt" ||
    normalized === "gpt-pro" ||
    normalized.startsWith("openai")
  ) {
    return "OpenAI";
  }
  if (normalized.includes("deepseek")) return "DeepSeek";
  if (
    normalized.includes("gemini") ||
    normalized.includes("google") ||
    normalized === "vertex-ai"
  ) {
    return "Google";
  }
  if (normalized.includes("kimi") || normalized.includes("moonshot")) return "Moonshot";
  if (normalized === "glm" || normalized.includes("zhipu")) return "Zhipu";
  if (
    normalized.includes("qwen") ||
    normalized.includes("alicloud") ||
    normalized === "dashscope"
  ) {
    return "Alibaba";
  }
  if (normalized.includes("mistral")) return "Mistral";
  if (normalized.includes("cohere")) return "Cohere";
  if (normalized.includes("xai") || normalized.includes("grok")) return "xAI";

  return value
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferCompanyFromModelId(model: string): string | null {
  const normalized = model.toLowerCase();
  if (model.startsWith("claude-")) return "Anthropic";
  if (
    model.startsWith("gpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    normalized.includes("/gpt-")
  ) {
    return "OpenAI";
  }
  if (normalized.includes("deepseek")) return "DeepSeek";
  if (normalized.includes("gemini")) return "Google";
  if (normalized.includes("kimi")) return "Moonshot";
  if (normalized.includes("glm-")) return "Zhipu";
  if (normalized.includes("qwen")) return "Alibaba";
  if (normalized.includes("mistral")) return "Mistral";
  if (normalized.includes("cohere")) return "Cohere";
  if (normalized.includes("grok")) return "xAI";
  return null;
}

function getModelCompany(model: string, priceData: ModelPriceData): string {
  const modelCompany = inferCompanyFromModelId(model);
  if (modelCompany) return modelCompany;

  const explicitFamily = typeof priceData.model_family === "string" ? priceData.model_family : "";
  if (explicitFamily.trim()) return companyLabel(explicitFamily);

  const provider = typeof priceData.litellm_provider === "string" ? priceData.litellm_provider : "";
  if (provider.trim()) return companyLabel(provider);

  return "Other";
}

function pickLatestPriceMap(prices: ModelMarketPriceRow[]): Map<string, ModelMarketPriceRow> {
  const sorted = [...prices].sort((a, b) => {
    if (a.modelName !== b.modelName) return a.modelName.localeCompare(b.modelName);
    if (a.source !== b.source) return a.source === "manual" ? -1 : 1;
    const aTime = a.updatedAt?.getTime() ?? 0;
    const bTime = b.updatedAt?.getTime() ?? 0;
    return bTime - aTime;
  });

  const result = new Map<string, ModelMarketPriceRow>();
  for (const price of sorted) {
    if (!result.has(price.modelName)) {
      result.set(price.modelName, price);
    }
  }
  return result;
}

export function buildModelMarket(input: BuildModelMarketInput): ModelMarketResponse {
  const exactModels = getExactAllowedModels(input.providers);
  const priceMap = pickLatestPriceMap(input.prices);
  const usageMap = new Map(input.usage.map((item) => [item.model, item]));
  const groupMultiplier = toPositiveMultiplier(input.defaultGroupMultiplier);

  const byModel = new Map<string, AllowedExactModel[]>();
  for (const allowed of exactModels) {
    const providers = byModel.get(allowed.model) ?? [];
    providers.push(allowed);
    byModel.set(allowed.model, providers);
  }

  const models: ModelMarketModel[] = [];
  let latestPriceUpdatedAt: Date | null = null;

  for (const [model, modelProviders] of byModel.entries()) {
    const price = priceMap.get(model);
    if (!price) continue;

    const inputPrice = toOptionalFiniteNumber(price.priceData.input_cost_per_token);
    const outputPrice = toOptionalFiniteNumber(price.priceData.output_cost_per_token);
    if (inputPrice === null || outputPrice === null) continue;

    const providerPrices = modelProviders.map((provider) => {
      const finalMultiplier = provider.providerMultiplier * groupMultiplier;
      return {
        finalMultiplier,
        finalInputPer1M: perTokenToPer1M(inputPrice, finalMultiplier),
        finalOutputPer1M: perTokenToPer1M(outputPrice, finalMultiplier),
        finalCacheWritePer1M: perTokenToPer1M(
          price.priceData.cache_creation_input_token_cost,
          finalMultiplier
        ),
        finalCacheReadPer1M: perTokenToPer1M(
          price.priceData.cache_read_input_token_cost,
          finalMultiplier
        ),
      };
    });

    const finalInputPer1M = maxNullable(providerPrices.map((item) => item.finalInputPer1M));
    const finalOutputPer1M = maxNullable(providerPrices.map((item) => item.finalOutputPer1M));
    if (finalInputPer1M === null || finalOutputPer1M === null) continue;

    const finalCacheWritePer1M = maxNullable(
      providerPrices.map((item) => item.finalCacheWritePer1M)
    );
    const finalCacheReadPer1M = maxNullable(providerPrices.map((item) => item.finalCacheReadPer1M));
    if (
      price.updatedAt &&
      (!latestPriceUpdatedAt || price.updatedAt.getTime() > latestPriceUpdatedAt.getTime())
    ) {
      latestPriceUpdatedAt = price.updatedAt;
    }

    const usage = usageMap.get(model);
    const requests30d = usage?.requests30d ?? 0;
    const inputTokens30d = usage?.inputTokens30d ?? 0;
    const outputTokens30d = usage?.outputTokens30d ?? 0;
    const cacheWriteTokens30d = usage?.cacheWriteTokens30d ?? 0;
    const cacheReadTokens30d = usage?.cacheReadTokens30d ?? 0;
    const totalTokens30d =
      inputTokens30d + outputTokens30d + cacheWriteTokens30d + cacheReadTokens30d;
    const cacheWriteCostPer1MForEstimate = finalCacheWritePer1M ?? finalInputPer1M * 1.25;
    const cacheReadCostPer1MForEstimate = finalCacheReadPer1M ?? finalInputPer1M * 0.1;
    const estimatedCost30d =
      (inputTokens30d * finalInputPer1M) / TOKEN_PRICE_UNIT +
      (outputTokens30d * finalOutputPer1M) / TOKEN_PRICE_UNIT +
      (cacheWriteTokens30d * cacheWriteCostPer1MForEstimate) / TOKEN_PRICE_UNIT +
      (cacheReadTokens30d * cacheReadCostPer1MForEstimate) / TOKEN_PRICE_UNIT;
    const averageCostPer1MTokens =
      totalTokens30d > 0 ? (estimatedCost30d / totalTokens30d) * TOKEN_PRICE_UNIT : null;
    const inputSideTokens30d = inputTokens30d + cacheWriteTokens30d + cacheReadTokens30d;
    const cacheHitRate30d = inputSideTokens30d > 0 ? cacheReadTokens30d / inputSideTokens30d : null;

    models.push({
      model,
      company: getModelCompany(model, price.priceData),
      finalInputPer1M: roundPrice(finalInputPer1M),
      finalOutputPer1M: roundPrice(finalOutputPer1M),
      finalCacheWritePer1M: finalCacheWritePer1M === null ? null : roundPrice(finalCacheWritePer1M),
      finalCacheReadPer1M: finalCacheReadPer1M === null ? null : roundPrice(finalCacheReadPer1M),
      averageCostPer1MTokens:
        averageCostPer1MTokens === null ? null : roundPrice(averageCostPer1MTokens),
      cacheHitRate30d: cacheHitRate30d === null ? null : Number(cacheHitRate30d.toFixed(6)),
      contextTokens:
        toOptionalFiniteNumber(price.priceData.max_input_tokens) ??
        toOptionalFiniteNumber(price.priceData.max_tokens),
      maxOutputTokens: toOptionalFiniteNumber(price.priceData.max_output_tokens),
      requests30d,
      totalTokens30d,
    });
  }

  models.sort((a, b) => {
    if (b.requests30d !== a.requests30d) return b.requests30d - a.requests30d;
    return a.model.localeCompare(b.model);
  });

  return {
    summary: {
      modelCount: models.length,
      priceUpdatedAt: latestPriceUpdatedAt?.toISOString() ?? null,
      generatedAt: new Date().toISOString(),
      cacheTtlSeconds: MODEL_MARKET_CACHE_TTL_SECONDS,
      statsWindowDays: MODEL_MARKET_STATS_WINDOW_DAYS,
      currency: "USD",
      unit: "$/1M tokens",
      pricingGroup: "default",
    },
    models,
  };
}

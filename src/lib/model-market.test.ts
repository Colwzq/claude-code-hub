import { describe, expect, test } from "vitest";
import { buildModelMarket } from "./model-market";
import type { ModelMarketPriceRow, ModelMarketProviderRow } from "./model-market";

const baseProvider: ModelMarketProviderRow = {
  id: 1,
  costMultiplier: "0.5",
  allowedModels: [
    { pattern: "gpt-5.5", matchType: "exact" },
    { pattern: "deepseek-v4-pro", matchType: "exact" },
    { pattern: "unused-model", matchType: "exact" },
  ],
};

const prices: ModelMarketPriceRow[] = [
  {
    modelName: "gpt-5.5",
    source: "litellm",
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    priceData: {
      litellm_provider: "openai",
      input_cost_per_token: 0.000005,
      output_cost_per_token: 0.00003,
      cache_read_input_token_cost: 0.0000005,
    },
  },
  {
    modelName: "deepseek-v4-pro",
    source: "manual",
    updatedAt: new Date("2026-06-02T00:00:00Z"),
    priceData: {
      litellm_provider: "deepseek",
      input_cost_per_token: 0.000012,
      output_cost_per_token: 0.000024,
      cache_read_input_token_cost: 0.0000001,
    },
  },
  {
    modelName: "unused-model",
    source: "manual",
    updatedAt: new Date("2026-06-03T00:00:00Z"),
    priceData: {
      litellm_provider: "anthropic",
      input_cost_per_token: 0.00001,
      output_cost_per_token: 0.00002,
    },
  },
];

describe("buildModelMarket", () => {
  test("calculates average cost per 1M total tokens from 30d token mix", () => {
    const market = buildModelMarket({
      providers: [baseProvider],
      prices,
      defaultGroupMultiplier: "1",
      usage: [
        {
          model: "gpt-5.5",
          requests30d: 10,
          inputTokens30d: 100_000,
          outputTokens30d: 10_000,
          cacheWriteTokens30d: 0,
          cacheReadTokens30d: 890_000,
        },
      ],
    });

    const gpt = market.models.find((model) => model.model === "gpt-5.5");
    expect(gpt).toMatchObject({
      company: "OpenAI",
      finalInputPer1M: 2.5,
      finalOutputPer1M: 15,
      finalCacheReadPer1M: 0.25,
      requests30d: 10,
      totalTokens30d: 1_000_000,
      averageCostPer1MTokens: 0.6225,
      cacheHitRate30d: 0.89899,
    });
  });

  test("keeps models with no 30d token history but does not estimate a ranking cost", () => {
    const market = buildModelMarket({
      providers: [baseProvider],
      prices,
      defaultGroupMultiplier: "1",
      usage: [],
    });

    const unused = market.models.find((model) => model.model === "unused-model");
    expect(unused).toMatchObject({
      company: "Anthropic",
      requests30d: 0,
      totalTokens30d: 0,
      averageCostPer1MTokens: null,
      cacheHitRate30d: null,
    });
  });

  test("uses manual price before synced price", () => {
    const market = buildModelMarket({
      providers: [baseProvider],
      prices: [
        ...prices,
        {
          modelName: "deepseek-v4-pro",
          source: "litellm",
          updatedAt: new Date("2026-06-04T00:00:00Z"),
          priceData: {
            litellm_provider: "deepseek",
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.000002,
          },
        },
      ],
      defaultGroupMultiplier: "1",
      usage: [],
    });

    const deepseek = market.models.find((model) => model.model === "deepseek-v4-pro");
    expect(deepseek?.finalInputPer1M).toBe(6);
    expect(deepseek?.finalOutputPer1M).toBe(12);
  });

  test("infers the model company from the model id before route provider metadata", () => {
    const market = buildModelMarket({
      providers: [
        {
          id: 2,
          costMultiplier: "1",
          allowedModels: [
            {
              pattern: "accounts/fireworks/models/deepseek-v4-pro",
              matchType: "exact",
            },
          ],
        },
      ],
      prices: [
        {
          modelName: "accounts/fireworks/models/deepseek-v4-pro",
          source: "litellm",
          updatedAt: new Date("2026-06-04T00:00:00Z"),
          priceData: {
            model_family: "fireworks",
            litellm_provider: "fireworks_ai",
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.000002,
          },
        },
      ],
      defaultGroupMultiplier: "1",
      usage: [],
    });

    expect(market.models[0]).toMatchObject({
      model: "accounts/fireworks/models/deepseek-v4-pro",
      company: "DeepSeek",
    });
  });
});

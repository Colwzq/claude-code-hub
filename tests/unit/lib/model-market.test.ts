import { describe, expect, it } from "vitest";
import { buildModelMarket } from "@/lib/model-market";
import type {
  ModelMarketPriceRow,
  ModelMarketProviderRow,
  ModelMarketUsageRow,
} from "@/lib/model-market";

const now = new Date("2026-06-04T00:00:00.000Z");

function provider(costMultiplier: string, models: string[]): ModelMarketProviderRow {
  return {
    id: Math.floor(Math.random() * 1000),
    costMultiplier,
    allowedModels: models.map((model) => ({ matchType: "exact", pattern: model })),
  };
}

function price(
  modelName: string,
  input: number | undefined,
  output: number | undefined,
  source: "manual" | "litellm",
  extra: Record<string, unknown> = {}
): ModelMarketPriceRow {
  return {
    modelName,
    source,
    updatedAt: now,
    priceData: {
      input_cost_per_token: input,
      output_cost_per_token: output,
      mode: "chat",
      ...extra,
    },
  };
}

function usage(
  model: string,
  overrides: Partial<Omit<ModelMarketUsageRow, "model">> = {}
): ModelMarketUsageRow {
  return {
    model,
    requests30d: 0,
    inputTokens30d: 0,
    outputTokens30d: 0,
    cacheWriteTokens30d: 0,
    cacheReadTokens30d: 0,
    ...overrides,
  };
}

describe("buildModelMarket", () => {
  it("uses manual price first and applies default group multiplier", () => {
    const result = buildModelMarket({
      providers: [provider("2", ["model-a"])],
      prices: [
        price("model-a", 0.000001, 0.000002, "litellm"),
        price("model-a", 0.000003, 0.000004, "manual", { display_name: "Manual A" }),
      ],
      usage: [usage("model-a", { requests30d: 7 })],
      defaultGroupMultiplier: "3",
    });

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      model: "model-a",
      company: "Other",
      finalInputPer1M: 18,
      finalOutputPer1M: 24,
      requests30d: 7,
      totalTokens30d: 0,
      averageCostPer1MTokens: null,
    });
  });

  it("takes the highest final price when multiple providers expose the same model", () => {
    const result = buildModelMarket({
      providers: [provider("0.2", ["deepseek-v4-pro"]), provider("0.25", ["deepseek-v4-pro"])],
      prices: [price("deepseek-v4-pro", 0.000012, 0.000024, "manual")],
      usage: [],
      defaultGroupMultiplier: "1",
    });

    expect(result.models[0]).toMatchObject({
      company: "DeepSeek",
      finalInputPer1M: 3,
      finalOutputPer1M: 6,
    });
  });

  it("filters missing or incomplete token prices", () => {
    const result = buildModelMarket({
      providers: [provider("1", ["priced", "missing", "no-output"])],
      prices: [
        price("priced", 0.000001, 0.000002, "litellm"),
        price("no-output", 0.000001, undefined, "litellm"),
      ],
      usage: [],
      defaultGroupMultiplier: "1",
    });

    expect(result.models.map((model) => model.model)).toEqual(["priced"]);
  });

  it("ignores non-exact allowed model rules in the first market version", () => {
    const result = buildModelMarket({
      providers: [
        {
          id: 1,
          costMultiplier: "1",
          allowedModels: [
            { matchType: "exact", pattern: "visible" },
            { matchType: "prefix", pattern: "hidden-" },
          ],
        },
      ],
      prices: [
        price("visible", 0.000001, 0.000002, "manual"),
        price("hidden-model", 0.000001, 0.000002, "manual"),
      ],
      usage: [],
      defaultGroupMultiplier: "1",
    });

    expect(result.models.map((model) => model.model)).toEqual(["visible"]);
  });

  it("applies explicit cache creation price to 30d cost estimates", () => {
    const result = buildModelMarket({
      providers: [provider("1", ["claude-sonnet-4-6", "gpt-5.4"])],
      prices: [
        price("claude-sonnet-4-6", 0.000003, 0.000015, "litellm", {
          litellm_provider: "anthropic",
          cache_creation_input_token_cost: 0.00000375,
        }),
        price("gpt-5.4", 0.000003, 0.000015, "litellm", {
          litellm_provider: "openai",
          cache_creation_input_token_cost: 0.00000375,
        }),
      ],
      usage: [
        usage("claude-sonnet-4-6", {
          requests30d: 5,
          inputTokens30d: 100_000,
          outputTokens30d: 10_000,
          cacheWriteTokens30d: 100_000,
        }),
        usage("gpt-5.4", {
          requests30d: 5,
          inputTokens30d: 100_000,
          outputTokens30d: 10_000,
          cacheWriteTokens30d: 100_000,
        }),
      ],
      defaultGroupMultiplier: "1",
    });

    const claude = result.models.find((model) => model.model === "claude-sonnet-4-6");
    const gpt = result.models.find((model) => model.model === "gpt-5.4");

    expect(claude).toMatchObject({
      company: "Anthropic",
      finalCacheWritePer1M: 3.75,
      averageCostPer1MTokens: 3.928571,
    });
    expect(gpt).toMatchObject({
      company: "OpenAI",
      finalCacheWritePer1M: 3.75,
      averageCostPer1MTokens: 3.928571,
    });
  });
});

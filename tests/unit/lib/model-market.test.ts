import { describe, expect, it } from "vitest";
import { buildModelMarket } from "@/lib/model-market";
import type { ModelMarketPriceRow, ModelMarketProviderRow } from "@/lib/model-market";

const now = new Date("2026-06-04T00:00:00.000Z");

function provider(costMultiplier: string, models: string[]): ModelMarketProviderRow {
  return {
    id: Math.floor(Math.random() * 1000),
    providerType: "claude",
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

describe("buildModelMarket", () => {
  it("uses manual price first and applies default group multiplier", () => {
    const result = buildModelMarket({
      providers: [provider("2", ["model-a"])],
      prices: [
        price("model-a", 0.000001, 0.000002, "litellm"),
        price("model-a", 0.000003, 0.000004, "manual", { display_name: "Manual A" }),
      ],
      usage: [{ model: "model-a", requests30d: 7 }],
      defaultGroupMultiplier: "3",
    });

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      model: "model-a",
      displayName: "Manual A",
      finalInputPer1M: 18,
      finalOutputPer1M: 24,
      priceSource: "manual",
      highestMultiplier: 6,
      requests30d: 7,
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
      finalInputPer1M: 3,
      finalOutputPer1M: 6,
      highestMultiplier: 0.25,
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
          providerType: "claude",
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

  it("includes cache creation in Claude coding scenario cost only", () => {
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
      usage: [],
      defaultGroupMultiplier: "1",
    });

    const claude = result.models.find((model) => model.model === "claude-sonnet-4-6");
    const gpt = result.models.find((model) => model.model === "gpt-5.4");

    expect(claude?.codingScenarioCostUsd).toBe(690);
    expect(gpt?.codingScenarioCostUsd).toBe(315);
  });
});

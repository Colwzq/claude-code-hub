import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getModelMarket: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mocks.getSession,
}));

vi.mock("@/repository/model-market", () => ({
  getModelMarket: mocks.getModelMarket,
}));

describe("GET /api/model-market", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when session is missing", async () => {
    mocks.getSession.mockResolvedValue(null);

    const { GET } = await import("@/app/api/model-market/route");
    const response = await GET();

    expect(response.status).toBe(401);
    expect(mocks.getSession).toHaveBeenCalledWith({ allowReadOnlyAccess: true });
    expect(mocks.getModelMarket).not.toHaveBeenCalled();
  });

  it("returns model market data for logged-in users", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 1, role: "user" }, key: {} });
    mocks.getModelMarket.mockResolvedValue({
      summary: {
        modelCount: 1,
        priceUpdatedAt: null,
        currency: "USD",
        unit: "$/1M tokens",
        pricingGroup: "default",
      },
      models: [
        {
          model: "gpt-5.4",
          displayName: "gpt-5.4",
          family: "openai",
          apiTypes: ["codex"],
          finalInputPer1M: 1,
          finalOutputPer1M: 2,
          finalCacheWritePer1M: null,
          finalCacheReadPer1M: null,
          contextTokens: null,
          maxOutputTokens: null,
          requests30d: 0,
          priceSource: "litellm",
          highestMultiplier: 1,
          codingScenarioCostUsd: 102,
        },
      ],
    });

    const { GET } = await import("@/app/api/model-market/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary.modelCount).toBe(1);
    expect(body.models[0]).not.toHaveProperty("providerKey");
    expect(body.models[0]).not.toHaveProperty("url");
  });
});

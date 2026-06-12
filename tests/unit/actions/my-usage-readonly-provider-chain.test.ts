import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  findReadonlyUsageLogsBatchForKey: vi.fn(),
  getTranslations: vi.fn(async () => (key: string) => key),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  resolveSystemTimezone: vi.fn(async () => "UTC"),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mocks.getSession,
}));

vi.mock("@/repository/usage-logs", () => ({
  findReadonlyUsageLogsBatchForKey: mocks.findReadonlyUsageLogsBatchForKey,
  findUsageLogsForKeyBatch: vi.fn(),
  findUsageLogsForKeySlim: vi.fn(),
  getDistinctEndpointsForKey: vi.fn(),
  getDistinctModelsForKey: vi.fn(),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: mocks.getTranslations,
}));

vi.mock("@/lib/utils/timezone", () => ({
  resolveSystemTimezone: mocks.resolveSystemTimezone,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));

describe("getMyUsageLogsBatchFull", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("readonly my-usage hides provider identity while keeping billing calculation fields", async () => {
    vi.resetModules();
    mocks.getSession.mockResolvedValueOnce({
      user: { id: 1 },
      key: { id: 7, key: "sk-readonly" },
    });

    mocks.findReadonlyUsageLogsBatchForKey.mockResolvedValueOnce({
      logs: [
        {
          id: 101,
          costMultiplier: "1.5",
          groupCostMultiplier: "2",
          costBreakdown: {
            input: "0.1",
            output: "0.2",
            cache_creation: "0",
            cache_read: "0",
            base_total: "0.3",
            provider_multiplier: 1.5,
            group_multiplier: 2,
            total: "0.9",
          },
          hedgeLosers: [
            {
              providerId: 42,
              providerName: "secret-provider",
              attemptNumber: 2,
              costUsd: "0.1",
              inputTokens: 10,
              outputTokens: 1,
            },
          ],
          specialSettings: [
            {
              type: "guard_intercept",
              scope: "guard",
              hit: true,
              guard: "sensitive_word",
              action: "block_request",
              statusCode: 403,
              reason: '{"matched":"secret"}',
            },
            {
              type: "provider_parameter_override",
              scope: "provider",
              providerId: 42,
              providerName: "secret-provider",
              providerType: "openai",
              hit: true,
              changed: true,
              changes: [],
            },
            {
              type: "pricing_resolution",
              scope: "billing",
              hit: true,
              modelName: "claude-sonnet",
              resolvedModelName: "claude-sonnet",
              resolvedPricingProviderKey: "secret-provider",
              source: "local_manual",
            },
          ],
          providerChain: [
            {
              id: 1,
              name: "provider-a",
              errorDetails: {
                request: {
                  headers: "authorization: Bearer secret-token",
                  body: "{}",
                },
                response: {
                  statusCode: 500,
                },
                clientError: "401 Unauthorized",
                provider: {
                  id: 1,
                  name: "provider-a",
                  statusCode: 401,
                  statusText: "Unauthorized",
                  upstreamBody: '{"error":"unauthorized"}',
                  upstreamParsed: { error: "unauthorized" },
                },
              },
            },
            {
              id: 2,
              name: "provider-b",
              rawCrossProviderFallbackEnabled: true,
              errorDetails: {
                request: {
                  headers: "authorization: Bearer raw-secret-token",
                  body: '{"model":"gpt-4.1"}',
                },
                clientError: "raw fallback leaked error",
                provider: {
                  id: 2,
                  name: "provider-b",
                  statusCode: 404,
                  statusText: "Not Found",
                  upstreamBody: '{"error":"missing"}',
                  upstreamParsed: { error: "missing" },
                },
              },
            },
            {
              id: 3,
              name: "provider-c",
              errorDetails: null,
            },
          ],
          _liveChain: {
            chain: [
              {
                id: 3,
                name: "live-provider",
                errorDetails: {
                  request: {
                    headers: "x-api-key: live-secret",
                  },
                },
              },
            ],
            phase: "provider",
            updatedAt: 123,
          },
        },
      ],
      nextCursor: null,
      hasMore: false,
    });

    const { getMyUsageLogsBatchFull } = await import("@/actions/my-usage");
    const result = await getMyUsageLogsBatchFull({ limit: 20 });

    expect(mocks.getSession).toHaveBeenCalledWith({ allowReadOnlyAccess: true });
    expect(mocks.findReadonlyUsageLogsBatchForKey).toHaveBeenCalledWith(
      expect.objectContaining({
        keyString: "sk-readonly",
        limit: 20,
      })
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        hasMore: false,
      },
    });
    const log = result.ok ? result.data.logs[0] : null;
    expect(log?.providerChain).toBeNull();
    expect(log?._liveChain).toBeNull();
    expect(log?.costMultiplier).toBe("1.5");
    expect(log?.groupCostMultiplier).toBe("2");
    expect(log?.costBreakdown).toEqual(
      expect.objectContaining({
        base_total: "0.3",
        provider_multiplier: 1.5,
        group_multiplier: 2,
        total: "0.9",
      })
    );
    expect(log?.hedgeLosers).toEqual([
      expect.objectContaining({
        providerId: 0,
        providerName: "",
        attemptNumber: 2,
        costUsd: "0.1",
      }),
    ]);
    expect(log?.specialSettings).toEqual([
      expect.objectContaining({
        type: "guard_intercept",
        reason: null,
      }),
      expect.objectContaining({
        type: "provider_parameter_override",
        providerId: null,
        providerName: null,
      }),
      expect.objectContaining({
        type: "pricing_resolution",
        resolvedPricingProviderKey: "",
      }),
    ]);
  });
});

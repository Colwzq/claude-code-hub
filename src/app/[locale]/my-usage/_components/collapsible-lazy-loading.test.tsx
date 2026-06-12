import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMyKeys: vi.fn(),
  getMyStatsSummary: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/api-client/v1/actions/my-usage", () => ({
  getMyKeys: mocks.getMyKeys,
  getMyStatsSummary: mocks.getMyStatsSummary,
}));

vi.mock("@/components/analytics/model-breakdown-column", () => ({
  ModelBreakdownColumn: () => <div data-testid="model-breakdown-column" />,
}));

vi.mock("../../dashboard/logs/_components/logs-date-range-picker", () => ({
  LogsDateRangePicker: () => <div data-testid="logs-date-range-picker" />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

import { MyKeysCard } from "./my-keys-card";
import { StatisticsSummaryCard } from "./statistics-summary-card";

function firstButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector("button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Expected button");
  }
  return button;
}

describe("my-usage collapsible sections", () => {
  test("my keys does not load until first expansion", async () => {
    mocks.getMyKeys.mockResolvedValue({ ok: true, data: [] });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<MyKeysCard />);
    });

    expect(mocks.getMyKeys).not.toHaveBeenCalled();

    await act(async () => {
      firstButton(container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.getMyKeys).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  test("statistics summary does not load until first expansion", async () => {
    mocks.getMyStatsSummary.mockResolvedValue({
      ok: true,
      data: {
        totalRequests: 0,
        totalCost: 0,
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreation5mTokens: 0,
        totalCacheCreation1hTokens: 0,
        keyModelBreakdown: [],
        userModelBreakdown: [],
        currencyCode: "USD",
      },
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<StatisticsSummaryCard />);
    });

    expect(mocks.getMyStatsSummary).not.toHaveBeenCalled();

    await act(async () => {
      firstButton(container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.getMyStatsSummary).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMyQuota: vi.fn(() => new Promise(() => {})),
  getServerTimeZone: vi.fn(() => new Promise(() => {})),
}));

vi.mock("@/lib/api-client/v1/actions/my-usage", () => ({
  getMyQuota: mocks.getMyQuota,
}));

vi.mock("@/lib/api-client/v1/actions/system-config", () => ({
  getServerTimeZone: mocks.getServerTimeZone,
}));

vi.mock("@/i18n/routing", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("./_components/my-usage-header", () => ({
  MyUsageHeader: () => <div data-testid="my-usage-header" />,
}));

vi.mock("./_components/provider-group-info", () => ({
  ProviderGroupInfo: () => <div data-testid="provider-group-info" />,
}));

vi.mock("./_components/expiration-info", () => ({
  ExpirationInfo: () => <div data-testid="expiration-info" />,
}));

vi.mock("./_components/usage-logs-section", () => ({
  UsageLogsSection: (props: { defaultOpen?: boolean }) => (
    <div
      data-layout-section="usage-logs"
      data-default-open={String(props.defaultOpen)}
      data-testid="usage-logs-section"
    />
  ),
}));

vi.mock("./_components/collapsible-quota-card", () => ({
  CollapsibleQuotaCard: () => <div data-layout-section="quota" />,
}));

vi.mock("./_components/my-keys-card", () => ({
  MyKeysCard: () => <div data-layout-section="keys" />,
}));

vi.mock("./_components/statistics-summary-card", () => ({
  StatisticsSummaryCard: () => <div data-layout-section="stats" />,
}));

import MyUsagePage from "./page";

describe("my-usage page layout", () => {
  test("puts usage logs above quota and opens logs by default", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<MyUsagePage />);
    });

    const sections = Array.from(container.querySelectorAll("[data-layout-section]")).map((node) =>
      node.getAttribute("data-layout-section")
    );

    expect(sections).toEqual(["usage-logs", "quota", "keys", "stats"]);
    expect(
      container
        .querySelector('[data-testid="usage-logs-section"]')
        ?.getAttribute("data-default-open")
    ).toBe("true");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

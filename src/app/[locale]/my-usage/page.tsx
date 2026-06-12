"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "@/i18n/routing";
import { getMyQuota, type MyUsageQuota } from "@/lib/api-client/v1/actions/my-usage";
import { getServerTimeZone } from "@/lib/api-client/v1/actions/system-config";
import { CollapsibleQuotaCard } from "./_components/collapsible-quota-card";
import { ExpirationInfo } from "./_components/expiration-info";
import { MyKeysCard } from "./_components/my-keys-card";
import { MyUsageHeader } from "./_components/my-usage-header";
import { ProviderGroupInfo } from "./_components/provider-group-info";
import { StatisticsSummaryCard } from "./_components/statistics-summary-card";
import { UsageLogsSection } from "./_components/usage-logs-section";

export default function MyUsagePage() {
  const router = useRouter();

  const [quota, setQuota] = useState<MyUsageQuota | null>(null);
  const [isQuotaLoading, setIsQuotaLoading] = useState(true);
  const [serverTimeZone, setServerTimeZone] = useState<string | undefined>(undefined);

  const loadInitial = useCallback(() => {
    setIsQuotaLoading(true);

    void getMyQuota()
      .then((quotaResult) => {
        if (quotaResult.ok) setQuota(quotaResult.data);
      })
      .finally(() => setIsQuotaLoading(false));

    void getServerTimeZone().then((tzResult) => {
      if (tzResult.ok) setServerTimeZone(tzResult.data.timeZone);
    });
  }, []);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  const keyExpiresAt = quota?.expiresAt ?? null;
  const userExpiresAt = quota?.userExpiresAt ?? null;

  return (
    <div className="space-y-6">
      <MyUsageHeader onLogout={handleLogout} keyName={quota?.keyName} userName={quota?.userName} />

      {/* Provider Group and Expiration info */}
      {quota ? (
        <div className="space-y-3">
          <ProviderGroupInfo
            keyProviderGroup={quota.keyProviderGroup}
            userProviderGroup={quota.userProviderGroup}
            userAllowedModels={quota.userAllowedModels}
            userAllowedClients={quota.userAllowedClients}
          />
          <ExpirationInfo
            keyExpiresAt={keyExpiresAt}
            userExpiresAt={userExpiresAt}
            userRpmLimit={quota.userRpmLimit}
            timezone={serverTimeZone}
          />
        </div>
      ) : null}

      <UsageLogsSection defaultOpen autoRefreshSeconds={30} serverTimeZone={serverTimeZone} />

      <CollapsibleQuotaCard quota={quota} loading={isQuotaLoading} />

      <MyKeysCard />

      <StatisticsSummaryCard serverTimeZone={serverTimeZone} />
    </div>
  );
}

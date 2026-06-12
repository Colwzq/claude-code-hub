"use client";

import { ChevronDown, Copy, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { getMyKeys, type MyKeyListItem } from "@/lib/api-client/v1/actions/my-usage";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/utils/clipboard";
import { formatDate } from "@/lib/utils/date-format";

type KeysTranslator = ReturnType<typeof useTranslations>;

function getStatusVariant(
  status: MyKeyListItem["status"]
): "default" | "secondary" | "destructive" {
  if (status === "enabled") return "default";
  if (status === "expired") return "destructive";
  return "secondary";
}

function formatKeyDate(value: Date | string | null, locale: string, fallback: string): string {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return formatDate(date, "yyyy-MM-dd HH:mm", locale);
}

function statusLabel(t: KeysTranslator, status: MyKeyListItem["status"]) {
  if (status === "enabled") return t("statusEnabled");
  if (status === "expired") return t("statusExpired");
  return t("statusDisabled");
}

interface MyKeysCardProps {
  defaultOpen?: boolean;
}

export function MyKeysCard({ defaultOpen = false }: MyKeysCardProps) {
  const t = useTranslations("myUsage.keys");
  const locale = useLocale();
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [keys, setKeys] = useState<MyKeyListItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copyingKeyId, setCopyingKeyId] = useState<number | null>(null);

  const loadKeys = useCallback(
    async (refresh = false) => {
      if (refresh) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }

      try {
        const result = await getMyKeys();
        if (!result.ok) {
          toast.error(t("loadFailed"));
          return;
        }
        setKeys(result.data);
      } finally {
        setHasLoaded(true);
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [t]
  );

  useEffect(() => {
    if (!isOpen || hasLoaded || isLoading) return;
    void loadKeys();
  }, [hasLoaded, isLoading, isOpen, loadKeys]);

  const handleCopy = useCallback(
    async (key: MyKeyListItem) => {
      if (!key.canCopy || !key.fullKey || copyingKeyId !== null) return;

      setCopyingKeyId(key.id);
      try {
        const copied = await copyTextToClipboard(key.fullKey);
        if (copied) {
          toast.success(t("copySuccess"));
        } else {
          toast.error(t("copyFailed"));
        }
      } finally {
        setCopyingKeyId(null);
      }
    },
    [copyingKeyId, t]
  );

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <section className="rounded-lg border bg-card">
        <header
          className={cn(
            "flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between",
            isOpen && "border-b"
          )}
        >
          <CollapsibleTrigger asChild>
            <button type="button" className="min-w-0 flex-1 text-left">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <h2 className="flex items-center gap-2 text-base font-semibold">
                    <KeyRound className="h-4 w-4" />
                    <span>{t("title")}</span>
                  </h2>
                  <p className="text-sm text-muted-foreground">{t("description")}</p>
                </div>
                <ChevronDown
                  className={cn(
                    "mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
                    isOpen && "rotate-180"
                  )}
                />
              </div>
            </button>
          </CollapsibleTrigger>
          {isOpen ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadKeys(true)}
              disabled={isLoading || isRefreshing}
              className="w-full sm:w-auto"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
              {t("refresh")}
            </Button>
          ) : null}
        </header>

        <CollapsibleContent>
          {isLoading ? (
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{t("loading")}</span>
            </div>
          ) : keys.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">{t("empty")}</div>
          ) : (
            <div className="divide-y">
              <div className="hidden grid-cols-[minmax(120px,1fr)_minmax(160px,1fr)_110px_90px_140px_88px] gap-3 px-4 py-2 text-xs font-medium text-muted-foreground sm:grid">
                <span>{t("name")}</span>
                <span>{t("key")}</span>
                <span>{t("purpose")}</span>
                <span>{t("status")}</span>
                <span>{t("expiresAt")}</span>
                <span className="text-right">{t("actions")}</span>
              </div>

              {keys.map((key) => {
                const isCopying = copyingKeyId === key.id;
                return (
                  <div
                    key={key.id}
                    className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(120px,1fr)_minmax(160px,1fr)_110px_90px_140px_88px] sm:items-center"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium" title={key.name}>
                        {key.name}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground sm:hidden">
                        {t("createdAt")}: {formatKeyDate(key.createdAt, locale, "-")}
                      </div>
                    </div>

                    <div className="min-w-0 font-mono text-sm">
                      <span className="block truncate" title={key.maskedKey}>
                        {key.maskedKey}
                      </span>
                    </div>

                    <div>
                      <span className="text-xs text-muted-foreground sm:hidden">
                        {t("purpose")}:{" "}
                      </span>
                      <Badge variant="outline">{key.providerGroup}</Badge>
                    </div>

                    <div>
                      <span className="text-xs text-muted-foreground sm:hidden">
                        {t("status")}:{" "}
                      </span>
                      <Badge variant={getStatusVariant(key.status)}>
                        {statusLabel(t, key.status)}
                      </Badge>
                    </div>

                    <div className="text-sm text-muted-foreground">
                      <span className="text-xs sm:hidden">{t("expiresAt")}: </span>
                      {formatKeyDate(key.expiresAt, locale, t("neverExpires"))}
                    </div>

                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleCopy(key)}
                        disabled={!key.canCopy || isCopying || copyingKeyId !== null}
                        className="w-full sm:w-auto"
                        title={key.canCopy ? t("copy") : t("copyUnavailable")}
                      >
                        {isCopying ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {isCopying ? t("copying") : t("copy")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

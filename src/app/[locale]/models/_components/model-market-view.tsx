"use client";

import { ArrowDownWideNarrow, ArrowUpWideNarrow, BarChart3, Boxes, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatTokenAmount } from "@/lib/utils";
import type { ModelMarketModel, ModelMarketResponse } from "@/types/model-market";

interface ModelMarketViewProps {
  initialData: ModelMarketResponse;
}

type SortDirection = "desc" | "asc";

const ALL_COMPANIES = "all";

function formatPrice(value: number | null): string {
  if (value === null) return "-";
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: value >= 10 ? 2 : 4,
    maximumFractionDigits: 6,
  })}`;
}

function formatDate(value: string | null, locale: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    hour12: false,
    timeStyle: "medium",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function formatPercent(value: number | null): string {
  if (value === null) return "-";
  return `${(value * 100).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function useFilteredModels(models: ModelMarketModel[], search: string, company: string) {
  return useMemo(() => {
    const query = search.trim().toLowerCase();
    return models.filter((model) => {
      const matchesSearch = !query || model.model.toLowerCase().includes(query);
      const matchesCompany = company === ALL_COMPANIES || model.company === company;
      return matchesSearch && matchesCompany;
    });
  }, [models, search, company]);
}

function SummaryCards({ data }: { data: ModelMarketResponse }) {
  const t = useTranslations("modelMarket");
  const totalRequests = data.models.reduce((sum, model) => sum + model.requests30d, 0);
  const rankedModels = data.models.filter((model) => model.averageCostPer1MTokens !== null);
  const highestAverageCost = rankedModels.reduce(
    (max, model) => Math.max(max, model.averageCostPer1MTokens ?? 0),
    0
  );

  const cards = [
    { label: t("summary.models"), value: data.summary.modelCount.toLocaleString() },
    { label: t("summary.requests30d"), value: totalRequests.toLocaleString() },
    { label: t("summary.unit"), value: data.summary.unit },
    {
      label: t("summary.rankedModels"),
      value: rankedModels.length.toLocaleString(),
    },
    { label: t("summary.highestAverageCost"), value: formatPrice(highestAverageCost || null) },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {cards.map((card) => (
        <Card key={card.label} className="rounded-lg py-4">
          <CardContent className="px-4">
            <p className="text-sm text-muted-foreground">{card.label}</p>
            <p className="mt-2 text-xl font-semibold tracking-tight">{card.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Filters({
  search,
  onSearchChange,
  company,
  onCompanyChange,
  companies,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  company: string;
  onCompanyChange: (value: string) => void;
  companies: string[];
}) {
  const t = useTranslations("modelMarket");

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="relative w-full md:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          className="pl-9"
          placeholder={t("filters.search")}
        />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select value={company} onValueChange={onCompanyChange}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_COMPANIES}>{t("filters.allCompanies")}</SelectItem>
            {companies.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function ModelTable({ models }: { models: ModelMarketModel[] }) {
  const t = useTranslations("modelMarket");

  if (models.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t("empty")}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-64">{t("columns.model")}</TableHead>
            <TableHead>{t("columns.company")}</TableHead>
            <TableHead className="text-right">{t("columns.averageCost")}</TableHead>
            <TableHead className="text-right">{t("columns.input")}</TableHead>
            <TableHead className="text-right">{t("columns.output")}</TableHead>
            <TableHead className="text-right">{t("columns.cacheWrite")}</TableHead>
            <TableHead className="text-right">{t("columns.cacheRead")}</TableHead>
            <TableHead className="text-right">{t("columns.cacheHitRate")}</TableHead>
            <TableHead className="text-right">{t("columns.context")}</TableHead>
            <TableHead className="text-right">{t("columns.requests30d")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {models.map((model) => (
            <TableRow key={model.model}>
              <TableCell className="whitespace-normal">
                <div className="space-y-1">
                  <div className="break-all font-mono text-sm font-medium text-foreground">
                    {model.model}
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{model.company}</Badge>
              </TableCell>
              <TableCell className="text-right font-mono font-semibold">
                {formatPrice(model.averageCostPer1MTokens)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatPrice(model.finalInputPer1M)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatPrice(model.finalOutputPer1M)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatPrice(model.finalCacheWritePer1M)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatPrice(model.finalCacheReadPer1M)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatPercent(model.cacheHitRate30d)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatTokenAmount(model.contextTokens)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {model.requests30d.toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RankingTable({
  models,
  direction,
  onToggleDirection,
}: {
  models: ModelMarketModel[];
  direction: SortDirection;
  onToggleDirection: () => void;
}) {
  const t = useTranslations("modelMarket");
  const sorted = useMemo(() => {
    return [...models].sort((a, b) => {
      if (a.averageCostPer1MTokens === null && b.averageCostPer1MTokens === null) {
        return b.requests30d - a.requests30d || a.model.localeCompare(b.model);
      }
      if (a.averageCostPer1MTokens === null) return 1;
      if (b.averageCostPer1MTokens === null) return -1;
      return direction === "desc"
        ? b.averageCostPer1MTokens - a.averageCostPer1MTokens
        : a.averageCostPer1MTokens - b.averageCostPer1MTokens;
    });
  }, [models, direction]);

  if (sorted.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t("empty")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>{t("ranking.noHistory")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onToggleDirection} className="w-fit gap-2">
          {direction === "desc" ? (
            <ArrowDownWideNarrow className="size-4" />
          ) : (
            <ArrowUpWideNarrow className="size-4" />
          )}
          {direction === "desc" ? t("ranking.desc") : t("ranking.asc")}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">{t("columns.rank")}</TableHead>
              <TableHead className="min-w-64">{t("columns.model")}</TableHead>
              <TableHead>{t("columns.company")}</TableHead>
              <TableHead className="text-right">{t("columns.averageCost")}</TableHead>
              <TableHead className="text-right">{t("columns.input")}</TableHead>
              <TableHead className="text-right">{t("columns.output")}</TableHead>
              <TableHead className="text-right">{t("columns.cacheRead")}</TableHead>
              <TableHead className="text-right">{t("columns.cacheWrite")}</TableHead>
              <TableHead className="text-right">{t("columns.cacheHitRate")}</TableHead>
              <TableHead className="text-right">{t("columns.requests30d")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((model, index) => (
              <TableRow key={model.model}>
                <TableCell className="font-mono text-muted-foreground">#{index + 1}</TableCell>
                <TableCell className="whitespace-normal">
                  <div className="space-y-1">
                    <div className="break-all font-mono text-sm font-medium">{model.model}</div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{model.company}</Badge>
                </TableCell>
                <TableCell className="text-right font-mono font-semibold">
                  {formatPrice(model.averageCostPer1MTokens)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatPrice(model.finalInputPer1M)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatPrice(model.finalOutputPer1M)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatPrice(model.finalCacheReadPer1M)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatPrice(model.finalCacheWritePer1M)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatPercent(model.cacheHitRate30d)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {model.requests30d.toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function ModelMarketView({ initialData }: ModelMarketViewProps) {
  const t = useTranslations("modelMarket");
  const locale = useLocale();
  const [search, setSearch] = useState("");
  const [company, setCompany] = useState(ALL_COMPANIES);
  const [rankingDirection, setRankingDirection] = useState<SortDirection>("desc");

  const companies = useMemo(
    () => Array.from(new Set(initialData.models.map((model) => model.company))).sort(),
    [initialData.models]
  );
  const filteredModels = useFilteredModels(initialData.models, search, company);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="text-sm text-muted-foreground">
          {t("updatedAt", { time: formatDate(initialData.summary.generatedAt, locale) })}
        </div>
      </div>

      <SummaryCards data={initialData} />

      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Boxes className="size-5 text-primary" />
            {t("tableTitle")}
          </CardTitle>
          <CardDescription>{t("tableDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Filters
            search={search}
            onSearchChange={setSearch}
            company={company}
            onCompanyChange={setCompany}
            companies={companies}
          />
          <Tabs defaultValue="market" className="gap-4">
            <TabsList>
              <TabsTrigger value="market" className="gap-2">
                <Boxes className="size-4" />
                {t("tabs.market")}
              </TabsTrigger>
              <TabsTrigger value="ranking" className="gap-2">
                <BarChart3 className="size-4" />
                {t("tabs.ranking")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="market">
              <ModelTable models={filteredModels} />
            </TabsContent>
            <TabsContent value="ranking">
              <RankingTable
                models={filteredModels}
                direction={rankingDirection}
                onToggleDirection={() =>
                  setRankingDirection((current) => (current === "desc" ? "asc" : "desc"))
                }
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

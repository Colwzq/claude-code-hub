import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { getModelMarket } from "@/repository/model-market";
import { DashboardHeader } from "../dashboard/_components/dashboard-header";
import { ModelMarketView } from "./_components/model-market-view";

export const dynamic = "force-dynamic";

type ModelsPageParams = { locale: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<ModelsPageParams>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "modelMarket" });

  return {
    title: t("pageTitle"),
    description: t("pageDescription"),
  };
}

export default async function ModelsPage({ params }: { params: Promise<ModelsPageParams> }) {
  const { locale } = await params;
  const session = await getSession({ allowReadOnlyAccess: true });

  if (!session) {
    return redirect({ href: "/login?from=/models", locale });
  }

  const data = await getModelMarket();
  const canUseDashboard = session.user.role === "admin" || session.key.canLoginWebUi;

  return (
    <div className="min-h-[var(--cch-viewport-height,100vh)] bg-background">
      {canUseDashboard && <DashboardHeader session={session} locale={locale} />}
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        <ModelMarketView initialData={data} />
      </main>
    </div>
  );
}

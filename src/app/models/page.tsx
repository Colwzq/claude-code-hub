import { cookies } from "next/headers";
import { defaultLocale, localeCookieName } from "@/i18n/config";
import { getLocaleFromValue } from "@/i18n/pathname";
import { redirect } from "@/i18n/routing";

export default async function ModelsShortcutPage() {
  const cookieStore = await cookies();
  const locale = getLocaleFromValue(cookieStore.get(localeCookieName)?.value) || defaultLocale;

  redirect({ href: "/models", locale });
}

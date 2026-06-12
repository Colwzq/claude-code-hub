import { normalizePathnameForLocaleNavigation } from "@/i18n/pathname";

const DEFAULT_REDIRECT_PATH = "/dashboard";
const READONLY_FALLBACK_PATH = "/my-usage";
const READONLY_ALLOWED_PATHS = ["/models", "/my-usage", "/usage-doc", "/status"];
const PROTOCOL_LIKE_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

export type LoginRedirectType = "admin" | "dashboard_user" | "readonly_user";

function getPathOnly(path: string): string {
  const suffixStart = path.search(/[?#]/);
  return suffixStart === -1 ? path : path.slice(0, suffixStart);
}

function isNestedPath(path: string, basePath: string): boolean {
  return path === basePath || path.startsWith(`${basePath}/`);
}

function canUseRedirectForLoginType(path: string, loginType: LoginRedirectType | null): boolean {
  if (loginType !== "readonly_user") {
    return true;
  }

  const pathOnly = getPathOnly(path);
  return READONLY_ALLOWED_PATHS.some((basePath) => isNestedPath(pathOnly, basePath));
}

function getSafeRedirectCandidate(value: string): string | null {
  const candidate = value.trim();

  if (!candidate) {
    return null;
  }

  if (!candidate.startsWith("/") || candidate.startsWith("//")) {
    return null;
  }

  if (PROTOCOL_LIKE_PATTERN.test(candidate) || PROTOCOL_LIKE_PATTERN.test(candidate.slice(1))) {
    return null;
  }

  return normalizePathnameForLocaleNavigation(candidate, DEFAULT_REDIRECT_PATH);
}

export function sanitizeRedirectPath(from: string): string {
  const candidate = from.trim();

  if (!candidate) {
    return DEFAULT_REDIRECT_PATH;
  }

  if (!candidate.startsWith("/")) {
    return DEFAULT_REDIRECT_PATH;
  }

  if (candidate.startsWith("//")) {
    return DEFAULT_REDIRECT_PATH;
  }

  if (PROTOCOL_LIKE_PATTERN.test(candidate)) {
    return DEFAULT_REDIRECT_PATH;
  }

  const withoutLeadingSlash = candidate.slice(1);
  if (PROTOCOL_LIKE_PATTERN.test(withoutLeadingSlash)) {
    return DEFAULT_REDIRECT_PATH;
  }

  return normalizePathnameForLocaleNavigation(candidate, DEFAULT_REDIRECT_PATH);
}

export function resolveLoginRedirectTarget(
  redirectTo: unknown,
  from: string,
  loginType: LoginRedirectType | null = null
): string {
  if (from.trim()) {
    const fromTarget = getSafeRedirectCandidate(from);
    if (fromTarget && canUseRedirectForLoginType(fromTarget, loginType)) {
      return fromTarget;
    }
  }

  if (typeof redirectTo === "string" && redirectTo.trim().length > 0) {
    const serverTarget = getSafeRedirectCandidate(redirectTo);
    if (serverTarget && canUseRedirectForLoginType(serverTarget, loginType)) {
      return serverTarget;
    }
  }

  return loginType === "readonly_user" ? READONLY_FALLBACK_PATH : DEFAULT_REDIRECT_PATH;
}

import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { keys, users } from "@/drizzle/schema";
import {
  clearAuthCookie,
  createSignedAdminAuthToken,
  detectSessionTokenKind,
  getAuthCookie,
  getAuthSessionTtlSeconds,
  getLoginRedirectTarget,
  getScopedAuthContext,
  getScopedAuthSession,
  getSession,
  getSessionTokenMigrationFlags,
  getSessionWithDualRead,
  isOpaqueSessionContract,
  isSessionTokenAccepted,
  isSessionTokenKindAccepted,
  isSignedAdminAuthToken,
  runWithAuthSession,
  setAuthCookie,
  validateAuthToken,
  validateKey,
  validateSession,
  withNoStoreHeaders,
} from "@/lib/auth";

/**
 * 说明：
 * - 本文件用于覆盖 auth.ts 的权限边界与 Cookie 行为
 * - 重点验证：allowReadOnlyAccess 白名单语义
 * - 以及 getSession/cookie 的读写一致性
 */

let currentCookieValue: string | undefined;
let currentAuthorizationValue: string | undefined;
const cookieSet = vi.fn((name: string, value: string) => {
  if (name === "auth-token") currentCookieValue = value;
});
const cookieDelete = vi.fn((name: string) => {
  if (name === "auth-token") currentCookieValue = undefined;
});

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => {
      if (name !== "auth-token") return undefined;
      return currentCookieValue ? { value: currentCookieValue } : undefined;
    },
    set: cookieSet,
    delete: cookieDelete,
    has: (name: string) => name === "auth-token" && Boolean(currentCookieValue),
  }),
  headers: () => ({
    get: (name: string) => {
      if (name.toLowerCase() !== "authorization") return null;
      return currentAuthorizationValue ?? null;
    },
  }),
}));

type TestUser = { id: number; name: string };
type TestKey = { id: number; userId: number; key: string; canLoginWebUi: boolean };

async function createTestUser(name: string): Promise<TestUser> {
  const [row] = await db
    .insert(users)
    .values({ name })
    .returning({ id: users.id, name: users.name });
  if (!row) throw new Error("创建测试用户失败：未返回插入结果");
  return row;
}

async function createTestKey(params: {
  userId: number;
  key: string;
  canLoginWebUi: boolean;
}): Promise<TestKey> {
  const [row] = await db
    .insert(keys)
    .values({
      userId: params.userId,
      key: params.key,
      name: `key-${params.key}`,
      canLoginWebUi: params.canLoginWebUi,
      dailyResetMode: "rolling",
      dailyResetTime: "00:00",
    })
    .returning({
      id: keys.id,
      userId: keys.userId,
      key: keys.key,
      canLoginWebUi: keys.canLoginWebUi,
    });

  if (!row) throw new Error("创建测试 Key 失败：未返回插入结果");
  return row;
}

describe("auth.ts：validateKey / getSession（安全边界）", () => {
  const createdUserIds: number[] = [];
  const createdKeyIds: number[] = [];

  afterAll(async () => {
    const now = new Date();
    if (createdKeyIds.length > 0) {
      await db
        .update(keys)
        .set({ deletedAt: now, updatedAt: now })
        .where(inArray(keys.id, createdKeyIds));
    }
    if (createdUserIds.length > 0) {
      await db
        .update(users)
        .set({ deletedAt: now, updatedAt: now })
        .where(inArray(users.id, createdUserIds));
    }
  });

  beforeEach(() => {
    currentCookieValue = undefined;
    currentAuthorizationValue = undefined;
    cookieSet.mockClear();
    cookieDelete.mockClear();
  });

  test("admin token：应返回 admin session（无需 DB）", async () => {
    const adminToken = process.env.ADMIN_TOKEN;
    expect(adminToken).toBeTruthy();

    const session = await validateKey(adminToken as string);
    expect(session?.user.role).toBe("admin");
    expect(session?.key.canLoginWebUi).toBe(true);
  });

  test("不存在的 key：validateKey 应返回 null", async () => {
    const session = await validateKey(`non-existent-${Date.now()}`);
    expect(session).toBeNull();
  });

  test("canLoginWebUi=false 且 allowReadOnlyAccess=false：应拒绝", async () => {
    const unique = `auth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await createTestUser(`Test ${unique}`);
    createdUserIds.push(user.id);
    const key = await createTestKey({
      userId: user.id,
      key: `test-key-${unique}`,
      canLoginWebUi: false,
    });
    createdKeyIds.push(key.id);

    const session = await validateKey(key.key, { allowReadOnlyAccess: false });
    expect(session).toBeNull();
  });

  test("allowReadOnlyAccess=true：应允许只读 key 查询自己的数据", async () => {
    const unique = `auth-ro-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await createTestUser(`Test ${unique}`);
    createdUserIds.push(user.id);
    const key = await createTestKey({
      userId: user.id,
      key: `test-ro-key-${unique}`,
      canLoginWebUi: false,
    });
    createdKeyIds.push(key.id);

    const session = await validateKey(key.key, { allowReadOnlyAccess: true });
    expect(session?.key.key).toBe(key.key);
    expect(session?.key.canLoginWebUi).toBe(false);
  });

  test("用户被软删除：validateKey 应返回 null", async () => {
    const unique = `auth-del-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await createTestUser(`Test ${unique}`);
    createdUserIds.push(user.id);
    const key = await createTestKey({
      userId: user.id,
      key: `test-key-${unique}`,
      canLoginWebUi: true,
    });
    createdKeyIds.push(key.id);

    const now = new Date();
    await db
      .update(users)
      .set({ deletedAt: now, updatedAt: now })
      .where(inArray(users.id, [user.id]));

    const session = await validateKey(key.key, { allowReadOnlyAccess: true });
    expect(session).toBeNull();
  });

  test("用户禁用或过期：validateKey 应返回 null", async () => {
    const unique = `auth-disabled-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const disabledUser = await createTestUser(`Test ${unique}-disabled`);
    const expiredUser = await createTestUser(`Test ${unique}-expired`);
    createdUserIds.push(disabledUser.id, expiredUser.id);
    const disabledKey = await createTestKey({
      userId: disabledUser.id,
      key: `test-disabled-key-${unique}`,
      canLoginWebUi: true,
    });
    const expiredKey = await createTestKey({
      userId: expiredUser.id,
      key: `test-expired-key-${unique}`,
      canLoginWebUi: true,
    });
    createdKeyIds.push(disabledKey.id, expiredKey.id);

    const now = new Date();
    await db
      .update(users)
      .set({ isEnabled: false, updatedAt: now })
      .where(inArray(users.id, [disabledUser.id]));
    await db
      .update(users)
      .set({ expiresAt: new Date(Date.now() - 1_000), updatedAt: now })
      .where(inArray(users.id, [expiredUser.id]));

    await expect(validateKey(disabledKey.key, { allowReadOnlyAccess: true })).resolves.toBeNull();
    await expect(validateKey(expiredKey.key, { allowReadOnlyAccess: true })).resolves.toBeNull();
  });

  test("getSession：无 Cookie 时返回 null；有 Cookie 时返回 session", async () => {
    const noCookie = await getSession({ allowReadOnlyAccess: true });
    expect(noCookie).toBeNull();

    const unique = `auth-sess-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await createTestUser(`Test ${unique}`);
    createdUserIds.push(user.id);
    const key = await createTestKey({
      userId: user.id,
      key: `test-key-${unique}`,
      canLoginWebUi: false,
    });
    createdKeyIds.push(key.id);

    currentCookieValue = key.key;
    const session = await getSession({ allowReadOnlyAccess: true });
    expect(session?.key.key).toBe(key.key);
  });

  test("getSession：仅 Authorization: Bearer 时也应返回 session", async () => {
    const unique = `auth-bearer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await createTestUser(`Test ${unique}`);
    createdUserIds.push(user.id);
    const key = await createTestKey({
      userId: user.id,
      key: `test-key-${unique}`,
      canLoginWebUi: false,
    });
    createdKeyIds.push(key.id);

    currentAuthorizationValue = `Bearer ${key.key}`;
    const session = await getSession({ allowReadOnlyAccess: true });
    expect(session?.key.key).toBe(key.key);
  });
});

describe("auth.ts：Cookie 工具函数与跳转目标", () => {
  beforeEach(() => {
    currentCookieValue = undefined;
    currentAuthorizationValue = undefined;
    cookieSet.mockClear();
    cookieDelete.mockClear();
  });

  test("set/get/clear auth cookie：应读写一致", async () => {
    await setAuthCookie("abc");
    expect(cookieSet).toHaveBeenCalled();

    const value = await getAuthCookie();
    expect(value).toBe("abc");

    await clearAuthCookie();
    expect(cookieDelete).toHaveBeenCalledWith("auth-token");
    expect(await getAuthCookie()).toBeUndefined();
  });

  test("getLoginRedirectTarget：应根据 role 与 canLoginWebUi 决定跳转", () => {
    const adminTarget = getLoginRedirectTarget({
      user: { role: "admin" } as any,
      key: { canLoginWebUi: false } as any,
    });
    expect(adminTarget).toBe("/dashboard");

    const webUiTarget = getLoginRedirectTarget({
      user: { role: "user" } as any,
      key: { canLoginWebUi: true } as any,
    });
    expect(webUiTarget).toBe("/dashboard");

    const readonlyTarget = getLoginRedirectTarget({
      user: { role: "user" } as any,
      key: { canLoginWebUi: false } as any,
    });
    expect(readonlyTarget).toBe("/my-usage");
  });

  test("session token helper：迁移模式、类型判定与契约校验", () => {
    expect(getAuthSessionTtlSeconds()).toBeGreaterThanOrEqual(60);

    expect(getSessionTokenMigrationFlags("legacy")).toEqual({
      dualReadWindowEnabled: false,
      hardCutoverEnabled: false,
      emergencyRollbackEnabled: true,
    });
    expect(getSessionTokenMigrationFlags("dual")).toMatchObject({ dualReadWindowEnabled: true });
    expect(getSessionTokenMigrationFlags("opaque")).toMatchObject({ hardCutoverEnabled: true });

    expect(isSessionTokenKindAccepted("dual", "legacy")).toBe(true);
    expect(isSessionTokenKindAccepted("legacy", "opaque")).toBe(false);
    expect(isSessionTokenKindAccepted("opaque", "opaque")).toBe(true);

    expect(detectSessionTokenKind(" sid_abc ")).toBe("opaque");
    expect(detectSessionTokenKind("sk-legacy")).toBe("legacy");
    expect(isSessionTokenAccepted("sid_abc", "legacy")).toBe(false);
    expect(isSessionTokenAccepted("sid_abc", "opaque")).toBe(true);

    const validContract = {
      sessionId: "sid_contract",
      keyFingerprint: "sha256:abc",
      credentialType: "user-api-key",
      createdAt: 1,
      expiresAt: 2,
      userId: 1,
      userRole: "user",
    };
    expect(isOpaqueSessionContract(validContract)).toBe(true);
    expect(isOpaqueSessionContract(null)).toBe(false);
    expect(isOpaqueSessionContract({ ...validContract, sessionId: "" })).toBe(false);
    expect(isOpaqueSessionContract({ ...validContract, expiresAt: 1 })).toBe(false);
    expect(isOpaqueSessionContract({ ...validContract, credentialType: "legacy-key" })).toBe(false);
  });

  test("withNoStoreHeaders：认证响应应禁止缓存", () => {
    const response = { headers: new Headers() };

    const returned = withNoStoreHeaders(response as any);

    expect(returned).toBe(response);
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
    expect(response.headers.get("Pragma")).toBe("no-cache");
  });

  test("scoped auth session：只允许降权，不允许只读 key 被提权", async () => {
    const previousStorage = globalThis.__cchAuthSessionStorage;
    const readonlySession = {
      user: { id: 1, role: "user", name: "Scoped User" },
      key: { id: 2, key: "scoped-key", canLoginWebUi: false },
    } as any;
    let currentStore: Parameters<NonNullable<typeof previousStorage>["run"]>[0] | undefined;

    globalThis.__cchAuthSessionStorage = undefined;
    expect(runWithAuthSession(readonlySession, () => "no-storage")).toBe("no-storage");

    globalThis.__cchAuthSessionStorage = {
      run(store, callback) {
        const previous = currentStore;
        currentStore = store;
        try {
          return callback();
        } finally {
          currentStore = previous;
        }
      },
      getStore() {
        return currentStore;
      },
    };

    try {
      expect(getScopedAuthSession()).toBeNull();

      const context = runWithAuthSession(readonlySession, () => getScopedAuthContext(), {
        allowReadOnlyAccess: true,
      });
      expect(context?.session).toBe(readonlySession);
      expect(context?.allowReadOnlyAccess).toBe(true);

      const allowed = await runWithAuthSession(
        readonlySession,
        () => getSession({ allowReadOnlyAccess: true }),
        { allowReadOnlyAccess: true }
      );
      expect(allowed).toBe(readonlySession);

      const deniedByCaller = await runWithAuthSession(
        readonlySession,
        () => getSession({ allowReadOnlyAccess: false }),
        { allowReadOnlyAccess: true }
      );
      expect(deniedByCaller).toBeNull();

      const deniedByScope = await runWithAuthSession(
        readonlySession,
        () => getSession({ allowReadOnlyAccess: true }),
        { allowReadOnlyAccess: false }
      );
      expect(deniedByScope).toBeNull();
    } finally {
      globalThis.__cchAuthSessionStorage = previousStorage;
    }
  });

  test("legacy 模式：签名 admin session token 不应作为普通 auth token 接受", async () => {
    const token = await createSignedAdminAuthToken();

    await expect(isSignedAdminAuthToken(token)).resolves.toBe(true);
    await expect(validateAuthToken(token)).resolves.toBeNull();
  });

  test("validateSession / getSessionWithDualRead：复用 getSession 读取逻辑", async () => {
    currentCookieValue = undefined;
    currentAuthorizationValue = undefined;

    await expect(getSessionWithDualRead()).resolves.toBeNull();
    await expect(validateSession()).resolves.toBeNull();
  });
});

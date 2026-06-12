import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createSignedAdminAuthToken,
  isSignedAdminAuthToken,
  toKeyFingerprint,
  validateAuthToken,
} from "@/lib/auth";

const mocks = vi.hoisted(() => {
  const originalSessionTokenMode = process.env.SESSION_TOKEN_MODE;
  process.env.SESSION_TOKEN_MODE = "dual";

  return {
    originalSessionTokenMode,
    findKeyList: vi.fn(),
    readSession: vi.fn(),
    validateApiKeyAndGetUser: vi.fn(),
  };
});

vi.mock("@/lib/auth-session-store/redis-session-store", () => ({
  RedisSessionStore: class RedisSessionStore {
    read(sessionId: string) {
      return mocks.readSession(sessionId);
    }
  },
}));

vi.mock("@/repository/key", () => ({
  findKeyList: mocks.findKeyList,
  validateApiKeyAndGetUser: mocks.validateApiKeyAndGetUser,
}));

const enabledUser = {
  id: 10,
  name: "Opaque User",
  role: "user",
  isEnabled: true,
  expiresAt: null,
};

function createKey(key: string, overrides?: { canLoginWebUi?: boolean }) {
  return {
    id: key.length,
    userId: enabledUser.id,
    name: key,
    key,
    canLoginWebUi: overrides?.canLoginWebUi ?? true,
    isEnabled: true,
  };
}

function createSessionData(params: {
  sessionId?: string;
  keyFingerprint: string;
  userId?: number;
  createdAt?: number;
  expiresAt?: number;
}) {
  return {
    sessionId: params.sessionId ?? "sid_test",
    keyFingerprint: params.keyFingerprint,
    createdAt: params.createdAt ?? Date.now() - 1_000,
    expiresAt: params.expiresAt ?? Date.now() + 60_000,
    userId: params.userId ?? enabledUser.id,
    userRole: "user",
  };
}

afterAll(() => {
  if (mocks.originalSessionTokenMode === undefined) {
    delete process.env.SESSION_TOKEN_MODE;
    return;
  }
  process.env.SESSION_TOKEN_MODE = mocks.originalSessionTokenMode;
});

beforeEach(() => {
  mocks.findKeyList.mockReset();
  mocks.readSession.mockReset();
  mocks.validateApiKeyAndGetUser.mockReset();
});

describe("auth.ts：opaque session token 转换", () => {
  test("dual 模式：session store 未命中时回退 legacy key 校验", async () => {
    const key = createKey("legacy-key");
    mocks.readSession.mockResolvedValue(null);
    mocks.validateApiKeyAndGetUser.mockResolvedValue({ user: enabledUser, key });

    const session = await validateAuthToken(key.key);

    expect(mocks.readSession).toHaveBeenCalledWith(key.key);
    expect(session?.key.key).toBe(key.key);
  });

  test("dual 模式：session store 读取失败时也回退 legacy key 校验", async () => {
    const key = createKey("legacy-key-after-redis-error");
    mocks.readSession.mockRejectedValue(new Error("redis down"));
    mocks.validateApiKeyAndGetUser.mockResolvedValue({ user: enabledUser, key });

    const session = await validateAuthToken(key.key);

    expect(session?.key.key).toBe(key.key);
  });

  test("opaque session：过期会话直接拒绝", async () => {
    const keyFingerprint = await toKeyFingerprint("expired-key");
    mocks.readSession.mockResolvedValue(
      createSessionData({
        keyFingerprint,
        createdAt: Date.now() - 2_000,
        expiresAt: Date.now() - 1_000,
      })
    );

    await expect(validateAuthToken("sid_expired")).resolves.toBeNull();
    expect(mocks.validateApiKeyAndGetUser).not.toHaveBeenCalled();
  });

  test("opaque session：admin token 指纹匹配时返回管理员会话", async () => {
    const adminToken = process.env.ADMIN_TOKEN;
    expect(adminToken).toBeTruthy();

    mocks.readSession.mockResolvedValue(
      createSessionData({
        keyFingerprint: await toKeyFingerprint(adminToken as string),
        userId: -1,
      })
    );

    const session = await validateAuthToken("sid_admin");

    expect(session?.user.role).toBe("admin");
  });

  test("opaque session：admin token 指纹不匹配时拒绝", async () => {
    mocks.readSession.mockResolvedValue(
      createSessionData({
        keyFingerprint: await toKeyFingerprint("wrong-admin-token"),
        userId: -1,
      })
    );

    await expect(validateAuthToken("sid_admin_bad")).resolves.toBeNull();
  });

  test("dual 模式：签名 admin session token 可验证为管理员会话", async () => {
    const token = await createSignedAdminAuthToken();

    await expect(isSignedAdminAuthToken(token)).resolves.toBe(true);
    const session = await validateAuthToken(token);
    expect(session?.user.role).toBe("admin");
  });

  test("opaque session：非管理员会话通过 key fingerprint 找回真实 key", async () => {
    const otherKey = createKey("other-key");
    const matchedKey = createKey("matched-key");

    mocks.readSession.mockResolvedValue(
      createSessionData({
        keyFingerprint: await toKeyFingerprint(matchedKey.key),
      })
    );
    mocks.findKeyList.mockResolvedValue([otherKey, matchedKey]);
    mocks.validateApiKeyAndGetUser.mockImplementation(async (keyString: string) =>
      keyString === matchedKey.key ? { user: enabledUser, key: matchedKey } : null
    );

    const session = await validateAuthToken("sid_user");

    expect(mocks.findKeyList).toHaveBeenCalledWith(enabledUser.id);
    expect(session?.key.key).toBe(matchedKey.key);
  });

  test("opaque session：找不到匹配 key fingerprint 时拒绝", async () => {
    mocks.readSession.mockResolvedValue(
      createSessionData({
        keyFingerprint: await toKeyFingerprint("missing-key"),
      })
    );
    mocks.findKeyList.mockResolvedValue([createKey("other-key")]);

    await expect(validateAuthToken("sid_missing")).resolves.toBeNull();
  });
});

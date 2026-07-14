import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { config } from "./config.js";
import { getOrCreateLocalAccount, getOrCreateTelegramAccount } from "./defaults.js";

export type TelegramWebAppUser = {
  id: number;
  username?: string;
  firstName?: string;
};

export class TelegramAuthError extends Error {
  constructor(message = "Telegram authorization required.") {
    super(message);
    this.name = "TelegramAuthError";
  }
}

export const MINI_APP_SESSION_COOKIE = "wb_finbot_session";
export const MINI_APP_SESSION_TTL_SECONDS = 15 * 60;

function fail(message: string): never {
  throw new TelegramAuthError(message);
}

function miniAppSessionKey() {
  return createHmac("sha256", "WBFinbotMiniAppSession").update(config.ENCRYPTION_SECRET).digest();
}

export function createMiniAppSession(telegramUserId: number, now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + MINI_APP_SESSION_TTL_SECONDS;
  const payload = Buffer.from(`${telegramUserId}.${expiresAt}`).toString("base64url");
  const signature = createHmac("sha256", miniAppSessionKey()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function validateMiniAppSession(session: string): TelegramWebAppUser {
  const [payload, signature, extra] = session.split(".");
  if (!payload || !signature || extra) {
    return fail("Invalid Mini App session.");
  }

  const expectedSignature = createHmac("sha256", miniAppSessionKey()).update(payload).digest();
  let actualSignature: Buffer;
  let decoded: string;
  try {
    actualSignature = Buffer.from(signature, "base64url");
    decoded = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return fail("Invalid Mini App session.");
  }

  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
    return fail("Invalid Mini App session.");
  }

  const [telegramIdRaw, expiresAtRaw, decodedExtra] = decoded.split(".");
  const telegramId = Number(telegramIdRaw);
  const expiresAt = Number(expiresAtRaw);
  if (
    decodedExtra ||
    !Number.isSafeInteger(telegramId) ||
    telegramId <= 0 ||
    !Number.isFinite(expiresAt) ||
    expiresAt < Math.floor(Date.now() / 1000)
  ) {
    return fail("Mini App session has expired.");
  }

  return { id: telegramId };
}

function getMiniAppSessionFromCookie(cookieHeader: string | undefined) {
  if (!cookieHeader) return "";
  const prefix = `${MINI_APP_SESSION_COOKIE}=`;
  const cookie = cookieHeader.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
  return cookie ? cookie.slice(prefix.length) : "";
}

export function validateTelegramInitData(initData: string, botToken: string): TelegramWebAppUser {
  if (!initData || !botToken) {
    return fail("Telegram authorization required.");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDateRaw = params.get("auth_date");
  const userRaw = params.get("user");

  if (!hash || !authDateRaw || !userRaw) {
    return fail("Invalid Telegram authorization data.");
  }

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest();

  let actualHash: Buffer;
  try {
    actualHash = Buffer.from(hash, "hex");
  } catch {
    return fail("Invalid Telegram authorization data.");
  }

  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
    return fail("Invalid Telegram authorization signature.");
  }

  const authDateSeconds = Number(authDateRaw);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDateSeconds;
  if (!Number.isFinite(authDateSeconds) || ageSeconds > config.TELEGRAM_AUTH_MAX_AGE_SECONDS || ageSeconds < -300) {
    return fail("Telegram authorization has expired.");
  }

  let user: { id?: unknown; username?: unknown; first_name?: unknown };
  try {
    user = JSON.parse(userRaw) as { id?: unknown; username?: unknown; first_name?: unknown };
  } catch {
    return fail("Invalid Telegram user data.");
  }

  const id = Number(user.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return fail("Invalid Telegram user data.");
  }

  return {
    id,
    username: typeof user.username === "string" ? user.username : undefined,
    firstName: typeof user.first_name === "string" ? user.first_name : undefined
  };
}

export async function getCurrentAccount(context: Context) {
  const initData = context.req.header("X-Telegram-Init-Data");
  const miniAppSession = context.req.header("X-WB-Finbot-Session") || getMiniAppSessionFromCookie(context.req.header("Cookie"));

  if (initData) {
    const user = validateTelegramInitData(initData, config.BOT_TOKEN);
    const account = await getOrCreateTelegramAccount({
      telegramId: user.id,
      username: user.username,
      firstName: user.firstName
    });
    context.set("telegramUserId", String(user.id));
    context.set("accountId", account.id);
    return account;
  }

  if (miniAppSession) {
    const user = validateMiniAppSession(miniAppSession);
    const account = await getOrCreateTelegramAccount({ telegramId: user.id });
    context.set("telegramUserId", String(user.id));
    context.set("accountId", account.id);
    return account;
  }

  if (!config.IS_PRODUCTION) {
    const account = await getOrCreateLocalAccount();
    context.set("accountId", account.id);
    return account;
  }

  throw new TelegramAuthError();
}

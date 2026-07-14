import { decryptSecret, encryptSecret } from "./crypto.js";
import { prisma } from "./db.js";
import { sanitizeWbToken, toUserWbError, WbApiError, WbClient } from "./wbClient.js";

export function tokenLast4(token: string) {
  return sanitizeWbToken(token).slice(-4);
}

export async function saveAndValidateWbToken(accountId: string, token: string) {
  const sanitizedToken = sanitizeWbToken(token);
  const encryptedApiToken = encryptSecret(sanitizedToken);
  const last4 = tokenLast4(sanitizedToken);

  await prisma.wbAccount.update({
    where: { id: accountId },
    data: {
      encryptedApiToken,
      tokenStatus: "checking",
      tokenLast4: last4,
      tokenConnectedAt: null
    }
  });

  try {
    const client = new WbClient(encryptedApiToken);
    const validation = await client.validateToken();
    const connectedAt = new Date();

    await prisma.wbAccount.update({
      where: { id: accountId },
      data: {
        tokenStatus: validation.ok ? "valid" : "invalid",
        tokenLast4: last4,
        tokenConnectedAt: validation.ok ? connectedAt : null
      }
    });

    return {
      ok: validation.ok,
      tokenStatus: validation.ok ? "valid" : "invalid",
      last4,
      connectedAt,
      warning: validation.warning,
      contentStatus: validation.contentOk ? "valid" : "unavailable"
    };
  } catch (error) {
    await prisma.wbAccount.update({
      where: { id: accountId },
      data: {
        encryptedApiToken: null,
        tokenStatus: error instanceof WbApiError ? error.code : "invalid",
        tokenLast4: null,
        tokenConnectedAt: null
      }
    });

    return {
      ok: false,
      tokenStatus: error instanceof WbApiError ? error.code : "invalid",
      last4,
      error: toUserWbError(error),
      errorCode: error instanceof WbApiError ? error.code : "invalid"
    };
  }
}

export async function debugWbToken(accountId: string) {
  const account = await prisma.wbAccount.findUnique({
    where: { id: accountId },
    select: {
      encryptedApiToken: true,
      tokenStatus: true,
      tokenLast4: true,
      tokenConnectedAt: true
    }
  });

  if (!account?.encryptedApiToken) {
    return {
      saved: false,
      decrypted: false,
      tokenStatus: account?.tokenStatus ?? "not_connected",
      last4: account?.tokenLast4 ?? null,
      connectedAt: account?.tokenConnectedAt ?? null,
      tokenLength: null,
      validation: null
    };
  }

  let decryptedToken = "";
  try {
    decryptedToken = sanitizeWbToken(decryptSecret(account.encryptedApiToken));
  } catch {
    return {
      saved: true,
      decrypted: false,
      tokenStatus: account.tokenStatus,
      last4: account.tokenLast4,
      connectedAt: account.tokenConnectedAt,
      tokenLength: null,
      validation: null
    };
  }

  const client = new WbClient(account.encryptedApiToken);
  const validation = await client.debugToken();

  return {
    saved: true,
    decrypted: true,
    tokenStatus: account.tokenStatus,
    last4: account.tokenLast4 ?? tokenLast4(decryptedToken),
    connectedAt: account.tokenConnectedAt,
    tokenLength: decryptedToken.length,
    validation
  };
}

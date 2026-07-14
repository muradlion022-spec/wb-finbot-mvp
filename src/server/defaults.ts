import { prisma } from "./db.js";

export async function getOrCreateLocalAccount() {
  const user = await prisma.user.upsert({
    where: { telegramId: "local-demo" },
    create: {
      telegramId: "local-demo",
      username: "local",
      firstName: "Demo"
    },
    update: {}
  });

  return prisma.wbAccount.upsert({
    where: {
      id: "local-demo-account"
    },
    create: {
      id: "local-demo-account",
      userId: user.id,
      name: "Демо-магазин",
      tokenStatus: "not_connected"
    },
    update: {
      userId: user.id
    }
  });
}

export async function getOrCreateTelegramAccount(input: {
  telegramId: number | string;
  username?: string;
  firstName?: string;
}) {
  const telegramId = String(input.telegramId);
  const user = await prisma.user.upsert({
    where: { telegramId },
    create: {
      telegramId,
      username: input.username,
      firstName: input.firstName
    },
    update: {
      username: input.username,
      firstName: input.firstName
    }
  });

  return prisma.wbAccount.upsert({
    where: {
      id: `telegram-${telegramId}`
    },
    create: {
      id: `telegram-${telegramId}`,
      userId: user.id,
      name: input.username ? `@${input.username}` : input.firstName || "Telegram seller",
      tokenStatus: "not_connected"
    },
    update: {
      userId: user.id,
      name: input.username ? `@${input.username}` : input.firstName || "Telegram seller"
    }
  });
}

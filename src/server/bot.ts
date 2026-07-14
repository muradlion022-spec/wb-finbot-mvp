import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import { calculateReportSummary } from "./calculations.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { bootstrapDemo } from "./demo.js";
import { getOrCreateTelegramAccount } from "./defaults.js";
import { ensureReportLoaded, listReports, ReportSyncPendingError, WbNotConnectedError } from "./reports.js";
import { createMiniAppSession } from "./telegramAuth.js";
import { toUserWbError, WbApiError } from "./wbClient.js";
import { debugWbToken, saveAndValidateWbToken } from "./wbToken.js";

const WB_TOKEN_PENDING_ACTION = "awaiting_wb_token";

function formatMoney(value: number) {
  return `${Math.round(value).toLocaleString("ru-RU")} ₽`;
}

function formatPercent(value: number | null) {
  return value === null ? "нет данных" : `${value.toLocaleString("ru-RU")} %`;
}

function mainKeyboard() {
  return new Keyboard()
    .text("Подключить WB API")
    .text("Мои отчёты")
    .row()
    .text("Себестоимость")
    .text("Операционные расходы")
    .row()
    .text("Настройки")
    .resized();
}

function isLocalMiniAppUrl(url: string) {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(url);
}

function miniAppUrl(telegramId: number, params: Record<string, string> = {}) {
  const url = isLocalMiniAppUrl(config.MINI_APP_URL)
    ? new URL(config.MINI_APP_URL)
    : new URL("/api/telegram/mini-app", config.MINI_APP_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  if (!isLocalMiniAppUrl(config.MINI_APP_URL)) {
    url.searchParams.set("session", createMiniAppSession(telegramId));
  }
  return url.toString();
}

function telegramUserId(context: Context) {
  const telegramId = context.from?.id;
  if (!telegramId) {
    throw new Error("Не удалось определить Telegram-пользователя.");
  }
  return telegramId;
}

function appKeyboard(telegramId: number, text = "Открыть WB Финбот") {
  const keyboard = new InlineKeyboard();
  const url = miniAppUrl(telegramId);
  return isLocalMiniAppUrl(url) ? keyboard.url(text, url) : keyboard.webApp(text, url);
}

function attachMiniAppButton(keyboard: InlineKeyboard, text: string, url: string) {
  return isLocalMiniAppUrl(url) ? keyboard.url(text, url) : keyboard.webApp(text, url);
}

function reportKeyboard(reportId: string, telegramId: number) {
  const keyboard = new InlineKeyboard();
  attachMiniAppButton(keyboard, "Открыть полный отчёт", miniAppUrl(telegramId, { reportId }));
  if (!isLocalMiniAppUrl(config.MINI_APP_URL)) {
    keyboard.row();
  }
  keyboard
    .text("Товары в минусе", `loss:${reportId}`)
    .text("Без себестоимости", `missing-cost:${reportId}`)
    .row()
    .text("Обновить отчёт", `refresh-report:${reportId}`)
    .row();
  attachMiniAppButton(
    keyboard,
    "Операционные расходы",
    miniAppUrl(telegramId, { reportId, tab: "expenses" })
  );
  return keyboard;
}

function reportListKeyboard(reports: Awaited<ReturnType<typeof listReports>>["reports"]) {
  const keyboard = new InlineKeyboard();
  for (const report of reports.slice(0, 8)) {
    keyboard.text(
      `${report.dateFrom.toISOString().slice(0, 10)} - ${report.dateTo.toISOString().slice(0, 10)} · ${report.reportId}`,
      `report:${report.id}`
    );
    keyboard.row();
  }
  return keyboard;
}

function renderSummary(summary: Awaited<ReturnType<typeof calculateReportSummary>>) {
  return [
    `📊 Отчёт WB за ${summary.dateFrom} - ${summary.dateTo}`,
    "",
    `Продажи: ${formatMoney(summary.revenue)}`,
    `К перечислению за товар: ${formatMoney(summary.goodsForPay)}`,
    `Комиссия WB: ${formatMoney(summary.wbCommission)}`,
    `Расходы WB: ${formatMoney(summary.wbExpenses)}`,
    `Итого к оплате: ${formatMoney(summary.forPay)}`,
    `Себестоимость продаж: ${formatMoney(summary.productCost)}`,
    `Операционные расходы: ${formatMoney(summary.operatingExpenses)}`,
    `Налог: ${formatMoney(summary.tax)}`,
    "",
    `Прибыль до операционных расходов: ${formatMoney(summary.profitBeforeOperatingExpenses)}`,
    `Прибыль до налога: ${formatMoney(summary.profitBeforeTax)}`,
    `Чистая прибыль: ${formatMoney(summary.finalProfit)}`,
    `Маржинальность: ${formatPercent(summary.margin)}`,
    `ROI: ${formatPercent(summary.roi)}`,
    "",
    `⚠️ Товаров без себестоимости: ${summary.missingCostProducts}`,
    `❌ Убыточных артикулов: ${summary.lossProducts}`,
    `💸 Крупные списания: ${summary.deductions.filter((item) => item.amount > 1000).length}`
  ].join("\n");
}

function fullReportUrl(reportId: string) {
  return `${config.MINI_APP_URL}?reportId=${reportId}`;
}

function formatConnectionDate(value: Date | null) {
  if (!value) {
    return "дата не сохранена";
  }

  return value.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDebugStatus(status?: number) {
  return typeof status === "number" ? `HTTP ${status}` : "нет HTTP-статуса";
}

function summaryMessage(summary: Awaited<ReturnType<typeof calculateReportSummary>>) {
  const base = renderSummary(summary);
  if (!isLocalMiniAppUrl(config.MINI_APP_URL)) {
    return base;
  }

  return `${base}\n\nПолный отчёт локально: ${fullReportUrl(summary.id)}`;
}

function botErrorMessage(error: unknown) {
  if (error instanceof WbApiError) return toUserWbError(error);
  if (error instanceof WbNotConnectedError) return "WB API не подключён.";
  if (error instanceof ReportSyncPendingError) {
    return error.syncStatus === "rate_limited"
      ? `Wildberries ограничил частоту запросов. Повторите через ${error.retryAfterSeconds} с.`
      : "Отчёт уже загружается. Попробуйте открыть его немного позже.";
  }
  return "Сервис временно не смог обработать запрос. Попробуйте ещё раз.";
}

function logBotCallbackError(action: string, error: unknown) {
  // Keep production diagnostics useful without ever writing user tokens or secrets to logs.
  const knownWbError = error instanceof WbApiError;
  const errorWithCode = error as { name?: unknown; code?: unknown; status?: unknown };
  console.error("[telegram-bot-callback]", {
    action,
    errorName: typeof errorWithCode.name === "string" ? errorWithCode.name : "UnknownError",
    errorCode: knownWbError ? error.code : typeof errorWithCode.code === "string" ? errorWithCode.code : undefined,
    httpStatus: knownWbError ? error.status : typeof errorWithCode.status === "number" ? errorWithCode.status : undefined
  });
}

async function acknowledgeCallback(context: Context) {
  try {
    // Telegram callbacks expire quickly. A WB request can take longer, so acknowledge first.
    await context.answerCallbackQuery();
  } catch {
    // The report action must still finish even when Telegram already closed the callback.
  }
}

export function createBot() {
  if (!config.BOT_TOKEN) {
    console.log("BOT_TOKEN is empty: Telegram bot is disabled for local MVP.");
    return undefined;
  }

  const bot = new Bot(config.BOT_TOKEN);

  async function accountFromContext(context: Context) {
    const from = context.from;
    if (!from) {
      throw new Error("Не удалось определить Telegram-пользователя.");
    }

    return getOrCreateTelegramAccount({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name
    });
  }

  async function setPendingWbToken(context: Context) {
    const account = await accountFromContext(context);
    await prisma.user.update({
      where: { id: account.userId },
      data: { pendingAction: WB_TOKEN_PENDING_ACTION }
    });
  }

  async function shouldReadWbToken(context: Context) {
    const account = await accountFromContext(context);
    const user = await prisma.user.findUnique({
      where: { id: account.userId },
      select: { pendingAction: true }
    });

    return { account, waiting: user?.pendingAction === WB_TOKEN_PENDING_ACTION };
  }

  bot.command("start", async (context) => {
    await context.reply(
      "Привет! Я помогу разобрать еженедельный отчёт WB, посчитать чистую прибыль по артикулам и показать расходы.",
      {
        reply_markup: mainKeyboard()
      }
    );
  });
  bot.command("app", async (context) => {
    await context.reply("Открой Mini App:", { reply_markup: appKeyboard(telegramUserId(context)) });
  });

  bot.command("status", async (context) => {
    const account = await accountFromContext(context);
    const connected = Boolean(account.encryptedApiToken && account.tokenStatus === "valid");
    await context.reply(
      [
        "WB Финбот работает.",
        `WB API: ${connected ? "подключён" : "не подключён"}`,
        connected ? `Токен: ****${account.tokenLast4 ?? "...."}` : `Статус токена: ${account.tokenStatus}`,
        connected ? `Подключён: ${formatConnectionDate(account.tokenConnectedAt)}` : null,
        `Mini App: ${config.MINI_APP_URL}`,
        `Демо-режим: ${config.USE_DEMO_DATA ? "включён" : "выключен"}`
      ].filter(Boolean).join("\n"),
      { reply_markup: appKeyboard(telegramUserId(context)) }
    );
  });

  bot.command("debug_wb_token", async (context) => {
    const account = await accountFromContext(context);
    const debug = await debugWbToken(account.id);
    const validation = debug.validation;

    await context.reply(
      [
        "WB token debug:",
        `сохранён: ${debug.saved ? "да" : "нет"}`,
        `расшифровался: ${debug.decrypted ? "да" : "нет"}`,
        debug.tokenLength === null ? null : `длина токена: ${debug.tokenLength}`,
        debug.last4 ? `последние 4: ${debug.last4}` : null,
        debug.connectedAt ? `подключён: ${formatConnectionDate(debug.connectedAt)}` : null,
        validation ? `Finance: ${validation.financeOk ? "доступ есть" : "нет доступа"} (${formatDebugStatus(validation.financeStatus)})` : null,
        validation?.financeError ? `Finance ошибка: ${validation.financeError}` : null,
        validation ? `Content: ${validation.contentOk ? "доступ есть" : "нет доступа"} (${formatDebugStatus(validation.contentStatus)})` : null,
        validation?.contentError ? `Content ошибка: ${validation.contentError}` : null,
        validation?.warning ? `Предупреждение: ${validation.warning}` : null
      ].filter(Boolean).join("\n")
    );
  });

  bot.command("demo", async (context) => {
    if (!config.USE_DEMO_DATA) {
      await context.reply("Демо-режим выключен. Сейчас основной сценарий работает через WB API.");
      return;
    }

    const report = await bootstrapDemo({ reset: true });
    const summary = await calculateReportSummary(report.id);
    await context.reply(summaryMessage(summary), {
      reply_markup: reportKeyboard(summary.id, telegramUserId(context))
    });
  });

  bot.hears("Мои отчёты", async (context) => {
    const account = await accountFromContext(context);
    if (!config.USE_DEMO_DATA && (!account.encryptedApiToken || account.tokenStatus !== "valid")) {
      await context.reply("Сначала нажми “Подключить WB API” и вставь персональный WB-токен с категорией Финансы и уровнем Только чтение. Контент для карточек товаров — опционально.");
      return;
    }

    try {
      const result = await listReports({ accountId: account.id, syncWb: !config.USE_DEMO_DATA });
      const reports = result.reports;
      if (result.sync.message) {
        await context.reply(result.sync.message);
      }
      if (reports.length === 0) {
        await context.reply(
          config.USE_DEMO_DATA
            ? "Отчётов пока нет. Нажми /demo, чтобы загрузить demo fallback."
            : "Реальных отчётов пока нет. Проверь период отчётов в WB или права Финансы: Только чтение у токена."
        );
        return;
      }

      await context.reply("Выбери отчёт для разбора:", { reply_markup: reportListKeyboard(reports) });
    } catch (error) {
      await context.reply(botErrorMessage(error));
    }
  });

  bot.hears("Подключить WB API", async (context) => {
    await setPendingWbToken(context);
    await context.reply(
      [
        "Безопаснее вставлять токен через Mini App в разделе «Настройки».",
        "Если используете чат, вставьте WB API-токен одним сообщением: я попробую удалить его после обработки.",
        "",
        "В WB при создании токена выберите:",
        "1. Для интеграции вручную.",
        "2. Персональный токен.",
        "3. Обязательно: категория Финансы, уровень Только чтение.",
        "4. Опционально: категория Контент, Только чтение — для названий, брендов и изображений товаров.",
        "",
        "Базовый токен и тестовый токен сейчас не используйте."
      ].join("\n")
    );
  });

  bot.on("message:text", async (context, next) => {
    const { account, waiting } = await shouldReadWbToken(context);
    if (!waiting) {
      await next();
      return;
    }

    await prisma.user.update({
      where: { id: account.userId },
      data: { pendingAction: null }
    });

    const token = context.message.text.trim();
    try {
      await context.api.deleteMessage(context.chat.id, context.message.message_id);
    } catch {
      // Deletion may be unavailable in some Telegram chat types; token processing must continue.
    }

    const result = await saveAndValidateWbToken(account.id, token);

    if (!result.ok) {
      await context.reply(`WB API не подключён. Токен не сохранён.\nПоследние 4 символа: ${result.last4}\n${result.error}`);
      return;
    }

    await context.reply(
      [
        `✅ WB API подключён. Токен сохранён, последние 4 символа: ${result.last4}`,
        result.warning || null
      ]
        .filter(Boolean)
        .join("\n")
    );
  });

  bot.hears(["Себестоимость", "Операционные расходы", "Настройки"], async (context) => {
    await context.reply("Открой Mini App:", { reply_markup: appKeyboard(telegramUserId(context)) });
  });

  bot.callbackQuery(/^report:(.+)/, async (context) => {
    const reportId = context.match[1];
    await acknowledgeCallback(context);
    try {
      const account = await accountFromContext(context);
      const loaded = await ensureReportLoaded(reportId, { accountId: account.id });
      const summary = await calculateReportSummary(loaded.report.id, account.id);
      if (loaded.sync.message) await context.reply(loaded.sync.message);
      await context.reply(summaryMessage(summary), {
        reply_markup: reportKeyboard(summary.id, telegramUserId(context))
      });
    } catch (error) {
      logBotCallbackError("report", error);
      await context.reply(botErrorMessage(error));
    }
  });

  bot.callbackQuery(/^refresh-report:(.+)/, async (context) => {
    const reportId = context.match[1];
    await acknowledgeCallback(context);
    try {
      const account = await accountFromContext(context);
      const loaded = await ensureReportLoaded(reportId, { accountId: account.id, force: true });
      const summary = await calculateReportSummary(loaded.report.id, account.id);
      if (loaded.sync.message) await context.reply(loaded.sync.message);
      await context.reply(summaryMessage(summary), {
        reply_markup: reportKeyboard(summary.id, telegramUserId(context))
      });
    } catch (error) {
      logBotCallbackError("refresh-report", error);
      await context.reply(botErrorMessage(error));
    }
  });

  bot.callbackQuery(/^loss:(.+)/, async (context) => {
    await acknowledgeCallback(context);
    try {
      const account = await accountFromContext(context);
      const loaded = await ensureReportLoaded(context.match[1], { accountId: account.id });
      const summary = await calculateReportSummary(loaded.report.id, account.id);
      const losses = summary.products
        .filter((product) => product.status === "loss")
        .map((product) => `${product.vendorCode}: ${formatMoney(product.finalProfit)}`)
        .join("\n");
      await context.reply(losses || "Убыточных артикулов нет.");
    } catch (error) {
      logBotCallbackError("loss", error);
      await context.reply(botErrorMessage(error));
    }
  });

  bot.callbackQuery(/^missing-cost:(.+)/, async (context) => {
    await acknowledgeCallback(context);
    try {
      const account = await accountFromContext(context);
      const loaded = await ensureReportLoaded(context.match[1], { accountId: account.id });
      const summary = await calculateReportSummary(loaded.report.id, account.id);
      const missing = summary.products
        .filter((product) => product.missingCost)
        .map((product) => `${product.vendorCode} · nmId ${product.nmId}`)
        .join("\n");
      await context.reply(missing || "У всех товаров указана себестоимость.");
    } catch (error) {
      logBotCallbackError("missing-cost", error);
      await context.reply(botErrorMessage(error));
    }
  });

  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    console.error(`Telegram bot error: ${message}`);
  });

  return bot;
}

let botInstance: Bot | undefined;

export function getBot() {
  if (!config.BOT_TOKEN) {
    return undefined;
  }

  botInstance ??= createBot();
  return botInstance;
}

export function startBot() {
  const bot = getBot();
  if (!bot) {
    console.log("BOT_TOKEN is empty: Telegram bot is disabled for local MVP.");
    return undefined;
  }

  bot.start({
    onStart: () => console.log("Telegram bot started in polling mode.")
  });

  return bot;
}

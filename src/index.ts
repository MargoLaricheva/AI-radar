import { Hono } from "hono";
import { serve } from "bun";
import pino from "pino";
import { loadConfig } from "./config";
import { checkDb, getDb } from "./db/client";
import { createTelegramClient } from "./tg/client";
import { loadSession, saveSession, setAccountStatus } from "./tg/session-store";
import { loginWithQr } from "./tg/login";
import { createSettingsStore } from "./settings";
import { LlmClient } from "./llm/client";
import { createFeedbackService } from "./learn/weights";
import { getAnchors } from "./learn/anchors";
import { createBotApp } from "./bot/app";
import { createNotifier } from "./notify/notifier";
import { createAnalyzer } from "./pipeline/analyze";
import { MsgQueue } from "./pipeline/queue";
import { startCollector } from "./tg/collector";
import { runCatchup } from "./tg/catchup";
import { ensureChatsBulk, insertMessages } from "./pipeline/store";
import { trackMessage } from "./pipeline/tracking";
import { startScheduler } from "./scheduler/jobs";

const config = loadConfig();
const log = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: ["session", "sessionEncrypted", "BOT_TOKEN", "LLM_API_KEY", "SESSION_KEY", "*.session_encrypted"],
    censor: "[REDACTED]",
  },
});

for (const k of ["BOT_TOKEN", "DATABASE_URL"] as const) {
  if (!config[k]) {
    log.error({ missing: k }, "нет обязательной переменной окружения");
    process.exit(1);
  }
}

const db = getDb();
const store = createSettingsStore(db);
const llm = new LlmClient(config, log);
const feedback = createFeedbackService(store);

// ---------- Telegram-клиент (userbot) ----------
let tgClient: Awaited<ReturnType<typeof createTelegramClient>> | null = null;

async function ensureSessionAndConnect(bot: Awaited<ReturnType<typeof createBotApp>>): Promise<void> {
  let session = await loadSession();
  // Миграция: если в БД пусто, пробуем локальный файл data/tg-session.txt
  if (!session) {
    const { existsSync, readFileSync } = await import("node:fs");
    if (existsSync("data/tg-session.txt")) {
      session = readFileSync("data/tg-session.txt", "utf-8").trim();
      if (session) {
        await saveSession(session);
        log.info("сессия импортирована из data/tg-session.txt");
      }
    }
  }

  tgClient = createTelegramClient(session ?? undefined);
  await tgClient.connect();

  if (!(await tgClient.isUserAuthorized())) {
    log.info("сессия не авторизована, запускаю QR-логин");
    const owner = await store.getOwnerId();
    const { InputFile } = await import("grammy");
    const newSession = await loginWithQr(tgClient, {
      onConsole: (msg) => log.info(msg),
      password: config.TG_2FA_PASSWORD ? async () => config.TG_2FA_PASSWORD : undefined,
      onQrPng: async (png) => {
        if (owner != null) {
          try {
            await bot.api.sendPhoto(owner, new InputFile(png), {
              caption: "📱 Отсканируйте QR в Telegram (Настройки → Устройства)",
            });
          } catch (err) {
            log.warn({ err: String(err) }, "не удалось отправить QR в бот");
          }
        }
      },
    });
    await saveSession(newSession);
    await tgClient.connect();
    log.info("QR-логин завершён, сессия сохранена");
  } else {
    log.info("Telegram-аккаунт подключён");
  }
  // Запоминаем TG id аккаунта: если владелец сам пишет в чатах —
  // его диалоги не считаем лидами (не присылаем самому себе)
  try {
    const me = await tgClient.getMe();
    if (me?.id != null) {
      await store.updateSettings({ self_tg_id: Number(me.id) });
    }
  } catch (err) {
    log.warn({ err: String(err) }, "не удалось получить self id");
  }
  await setAccountStatus("active");
}

// ---------- Бот ----------
const botDeps = {
  token: config.BOT_TOKEN,
  log,
  store,
  llm,
  feedback,
  cmdDeps: {
    store,
    log,
    tgClient: () => tgClient,
  },
};
const bot = createBotApp(botDeps);
const notifier = createNotifier({ bot, store, config, log });

// ---------- Конвейер ----------
const queue = new MsgQueue();
const analyzer = createAnalyzer({
  db,
  config,
  log,
  llm,
  getSettings: () => store.getSettings(),
  getWeights: () => store.getWeights(),
  getProfileEmbedding: () => store.getProfileEmbedding(),
  getAnchors: () => getAnchors(db),
  onOpportunity: (ev, opp, thread) => notifier.handleOpportunity(ev, opp, thread),
});

// Writer: очередь → БД → builder → tracking
const writer = setInterval(async () => {
  try {
    const batch = queue.drain();
    if (batch.length === 0) return;
    const chatMap = await ensureChatsBulk(batch.map((m) => ({ tgChatId: m.chatId, title: `#${m.chatId}`, username: null, type: "megagroup" as const })), db);
    const stored = await insertMessages(batch, chatMap, db);
    if (stored.length === 0) return;
    for (const m of batch) {
      const chatDbId = chatMap.get(m.chatId);
      if (chatDbId == null) continue;
      analyzer.builder.setChatDbId(m.chatId, chatDbId);
      const thread = analyzer.builder.push(m);
      void trackMessage(chatDbId, thread.id, m.isOutgoing, notifier);
    }
  } catch (err) {
    log.error({ err: String(err) }, "writer: ошибка обработки пачки");
  }
}, 3000);

// ---------- Запуск ----------
const app = new Hono();
app.get("/healthz", async (c) => {
  const dbOk = await checkDb(db);
  return c.json({ ok: dbOk, tg: tgClient != null && tgClient.connected, uptime: process.uptime() }, dbOk ? 200 : 503);
});
serve({ port: config.PORT, fetch: app.fetch });

async function main(): Promise<void> {
  await bot.init();
  await bot.api.getMe(); // проверка токена
  void bot.start({ drop_pending_updates: true }).catch((err) => {
    log.error({ err: String(err) }, "бот остановился с ошибкой");
  });
  log.info("бот запущен");

  await ensureSessionAndConnect(bot);
  // наполняем кэш сущностей граммJS: быстрый срез сразу, полный обход — через 5 минут
  // (полный обход нужен, чтобы catch-up и mini-догон видели ВСЕ включённые чаты;
  //  отложен, чтобы стартовые catch-up + mini-догон не создавали flood на GetMessages/GetDialogs)
  try {
    const { listChats, scanAllChats } = await import("./tg/dialogs");
    await listChats(tgClient!);
    setTimeout(() => {
      void scanAllChats(tgClient!, db, log).catch((err) => {
        log.warn({ err: String(err) }, "фоновый обход диалогов не удался");
      });
    }, 5 * 60_000);
  } catch (err) {
    log.warn({ err: String(err) }, "не удалось загрузить диалоги при старте");
  }
  const stopCollector = startCollector(tgClient!, { queue, log, db, capPerMin: config.CHAT_MSG_PER_MIN_CAP });
  await runCatchup(tgClient!, { queue, log, db, hours: config.CATCHUP_HOURS });
  void notifier.resendPending().catch((err) => log.warn({ err: String(err) }, "досылка карточек не удалась"));

  startScheduler({ bot, cmdDeps: botDeps.cmdDeps, config, log, builder: analyzer.builder, tgClient: () => tgClient, queue });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      log.info({ sig }, "завершение");
      clearInterval(writer);
      stopCollector();
      analyzer.dispose();
      await bot.stop().catch(() => {});
      await tgClient?.disconnect().catch(() => {});
      process.exit(0);
    });
  }
}

void main().catch((err) => {
  log.error({ err: String(err) }, "фатальная ошибка запуска");
  process.exit(1);
});

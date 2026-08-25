# AI Radar — инструкция для AI-агента

> Шаблон/обменная карточка проекта: здесь — «где что», «на каком стеке», «как подключить»,
> «как деплоить» и «что учесть при передаче в руки другому агенту/разработчику».
> Файл живёт в корне репозитория и подхватывается любым AI-агентом автоматически.
> Поведенческие правила ассистента (отвечать по-русски, не заявлять «готово» без проверок и т.д.)
> заданы глобальным `AGENTS.md`; этот файл — только техническая ориентировка по коду.

---

## 1. Что это за система

**AI Radar** — self-hosted «радар» присутствия в Telegram-сообществах. Через **личный аккаунт**
(MTProto/userbot) слушает выбранные чаты-группы, группирует поток сообщений в **разговоры**
(сегменты + долгоживущие треды), прогоняет каждый готовый разговор через **LLM**, находит
возможности — от горячих лидов до обсуждений, где уместна экспертиза, — и присылает владельцу
в личный чат Telegram-бота **карточку**: суть, тезисы, «что написать»/«что не писать», шанс на клиента.

Однопользовательское. «Человек-владелец» = владелец аккаунта-юзербота и единственный пользователь
бота. Использование личного аккаунта для автоматизированного чтения чатов — серая зона ToS Telegram;
система смягчает риск лимитами, задержками и kill switch, но не устраняет полностью.

## 2. Стек

| Слой | Технология | Зачем |
|---|---|---|
| Рантайм | **Bun ≥1.2** (TypeScript, ESM, `"type": "module"`) | дев-сервер, исполнение |
| Бот | **grammY** (не Telegraf) | команды, кнопки, инлайн-клавиатуры |
| Userbot | **telegram** (MTProto, gramjs) | чтение чатов от лица аккаунта, QR-логин |
| БД | **PostgreSQL 16** через **Drizzle ORM** + **postgres.js** | хранение всего |
| HTTP | **Hono** | единственный endpoint `/healthz` |
| Логи | **pino** | логи; секреты редуцируются через `redact` |
| Embeddings | **transformers.js** + `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (локально, q8) | дешёвый фильтр до LLM |
| LLM | OpenAI-совместимый HTTP (по умолч. opencode go `/zen/go/v1`, `deepseek-v4-flash`) | анализ диалогов |
| Валидация | **zod** | env, JSON от LLM, входы |
| Контейнер | **Docker** (`oven/bun:1.2-slim`) + docker-compose | прод-деплой |

Ключевое отличие от классического бота: данных через вебхук грамY нет — у нас вместо этого
MTProto-подписка и догоны. `useHono`, `Bun.serve` — стандартный Hono/Bun.

## 3. Карта проекта (где что)

```
src/
  index.ts             — точка входа: склейка всего (бот, tg-клиент, конвейер, планировщик)
  config.ts            — zod-схема env + parseQuietHours
  db/
    client.ts          — drizzle + postgres-синглтон getDb()
    schema.ts          — ВСЕ таблицы, типы Profile/Settings/Weights, enum'ы OpportunityType
    migrate.ts         — применяет миграции (запускается при старте контейнера)
    migrations/        — 0000..0002 .sql + meta-снапшоты
  tg/                  — MTProto-слой
    client.ts          — TelegramClient, API_ID/API_HASH, sessionToString
    login.ts           — QR-логин (base64url-токен в tg://login?token=...)
    session-store.ts   — saveSession/loadSession/wipeAccount (AES-256-GCM)
    collector.ts       — событийный поток новых сообщений → MsgQueue (O(1), без I/O)
    catchup.ts         — догон после простоя (страницы по чату)
    dialogs.ts         — сканирование списка чатов, добавление, фильтры
    flood.ts           — FloodWait-защита (бэкофф+jitter) + RateCounter
    deep-link.ts       — t.me/<username>/<id>, t.me/c/<id>/<id>
    types.ts           — TgMessage/TgChatInfo (+ интерфейс MonitorApi — cпека §20, пока не используется)
  pipeline/            — мозг системы
    queue.ts           — in-memory буфер между collector и writer
    normalizer.ts      — чистка текста (мин. длина 20, макс 2000, линки/упоминания, lang)
    builder.ts         — сегменты + треды, debounce, дрейф, переанализ (core!)
    store.ts           — ensureChat/ensureChatsBulk/insertMessages (dedup), lastMsgIdForChat
    filter.ts          — дешёвый фильтр: embeddings (профиль/якоря) + blacklist + вес чата
    embeddings.ts      — локальная модель, кэш extractor, embedOne/embedTexts/cosine
    analyze.ts         — оркестратор: ready → фильтр → LLM → scoring → opportunity → people
    score.ts           — basePriority (треки client/expertise), applyWeights, passesLevel, TYPE_LABELS
    opportunity.ts     — ensureConversation, upsertOpportunity (re-notify-политика), markCardSent
    tracking.ts        — авто-трекинг ответов владельца (new/viewed→engaged→conversation)
  llm/
    client.ts          — OpenAI-совместимый клиент, ретраи, учёт tokens/cost + LLM не в БД (llm_requests)
    prompts.ts         — buildSystemPrompt/buildUserPrompt (окно ≤15 msg/≤4000 симв.)
    schema.ts          — zod-схема AnalysisResult
  bot/                 — грамY-слой
    app.ts             — createBotApp: регистрация всех подсистем
    commands.ts        — /chats /history /card /digest /profile /stats /status /pause|resume /start
    buttons.ts         — 👍👎🗑📖 callbacks
    cards.ts           — рендер карточки (HTML), esc(), блоки <blockquote expandable>
    summary.ts         — «Сводка за день» + пагинация (считает день по МСК!)
    settings.ts        — /settings, тихие часы, уровни, kill switch
    teach.ts           — /teach (примеры-якоря)
    profile.ts         — /profile_edit (анкета)
    menu-utils.ts      — editOrReply (edit в callback, reply в команде)
  settings/index.ts    — SettingsStore: настройки, профиль, веса, владелец (дин. users-строка)
  learn/
    weights.ts         — фидбек 👍/👎 → веса тем/чатов/типов, blacklist после 2 👎
    anchors.ts         — /teach примеры (examples), addExample/getAnchors
  notify/
    notifier.ts        — решение «слать ли», тихие часы, edit in-place, досылка пропущенных
    digest.ts          — дневной дайджест
  people/index.ts      — профили участников (для дайджеста)
  retention/cleaner.ts — удаление старых данных по TTL
  scheduler/jobs.ts    — дайджест/retention/sweep треда/mini-catchup (все на setInterval)
  security/session-crypto.ts — AES-256-GCM, ключ из env или data/key.bin

tests/               — bun test (unit + интеграционные), изолированные БД-фикстуры
eval/                — golden-набор точности cheap-фильтра (bun eval/golden.ts → eval/report.md)
scripts/             — smoke.ts (healthz+счётчики), tg-smoke.ts, setup-env.sh
data/                — (не в git) key.bin, история tg-session.txt. Данные вне git.
PLAN.md              — полная спека и история замысла (49KB)
CHANGELOG.md         — журнал версий с деталями деплоя/фиксов
```

## 4. Поток данных (как реально работает)

1. **Сбор**: `collector` (подписка событий) + `catchup` (догон после старта) +
   `mini-catchup` (каждые 10 мин, scheduler) кладут нормализованные `TgMessage` во **`MsgQueue`**.
2. **Writer** (в `index.ts`, каждые 3 с): drain → `ensureChatsBulk` + `insertMessages`
   (dedup по `chat_id,tg_msg_id`) → `builder.push` → `trackMessage`. Всё это один
   всеобъемлющий `setInterval`, важно не задушить его I/O.
3. **Builder**: группирует сообщения в **сегменты** (окно по reply/времени ≤ `SEGMENT_GAP_MIN`)
   и **треды** (долгоживущий разговор, id = `tgMsgId` первого сегмента — стабилен между рестартами).
   По debounce (тишина `DEBOUNCE_QUIET_MIN` или потолок `DEBOUNCE_MAX_AGE_MIN`) вызывает
   `onReady`… поток в **analyze**.
4. **Analyze** (pipeline/analyze.ts): если `USE_LLM_FILTER=false` — сначала **дешёвый фильтр**
   (embeddings-похожесть окна на профиль/якоря × вес чата × penalty blacklist). Затем
   **пропуск, если владелец сам в диалоге** (`self_tg_id`). Потом **LLM-анализ** →
   **scoring** → `ensureConversation`/`upsertOpportunity` → запись участников (people) →
   **`onOpportunity` → notifier**.
5. **Notifier**: для `isNew` — если проходит `passesLevel` и не тихие часы → шлёт карточку и
   `markCardSent`. Для существующей — **тихий edit** in-place, без повторного пуша. Досылка
   пропущенных (`resendPending`) — при старте.
6. **Обучение**: 👍 поднимает веса темы/чата/типа; 👎 понижает, 2 👎 на тему → blacklist.
   `/teach` сохраняет пример → используется фильтром.
7. **Авто-трекинг**: владелец ответил в мониторимом чате → `engaged`; пришёл ответ → `conversation`.

## 5. Как подключить и запустить локально

Требования: Linux, **Bun ≥1.2**, **PostgreSQL 16** (или Docker). Миграции применяются в начале
`src/db/migrate.ts` — при каждом старте контейнера и вручную через `bun src/db/migrate.ts`.

```bash
cp .env.example .env
chmod 600 .env
# заполнить BOT_TOKEN (BotFather) и, желательно, LLM_API_KEY;
# DATABASE_URL по умолч. postgres://radar:radar@localhost:5432/radar

bun install
bun run check          # tsc strict, без эмита
bun test               # 69 тестов (unit + интеграционные)
bun run smoke          # healthz + счётчики БД (BASE_URL по умолч. localhost:3000)
bun run dev            # bun --watch src/index.ts

# eval точности фильтра (пишет eval/report.md):
bun eval/golden.ts
```

При первом запуске без сессии запускается **QR-логин**: бот присылает QR владельцу
(или он печатается в лог), владелец сканирует **Telegram → Настройки → Устройства**.
После этого владельцу нужно написать боту `/start` (привязка владельца), `/profile_edit`
(профиль для фильтра/промптов), `/chats` (включить чаты).

Внимание на **ключи миграций и схему**: коммит новых колонок/таблиц = новая миграция
(`bun run db:generate`), любые изменения `src/db/schema.ts` требуют генерации миграции.

## 6. Переменные окружения (что важно)

Всё задаётся через `.env` и валидируется `src/config.ts` (zod). Обязательные: `BOT_TOKEN`,
`DATABASE_URL`. Критичные семантические дефолты помечены в `.env.example`. Особые случаи:

- `SESSION_KEY` — если пусто, ключ AES-256-GCM генерируется в `data/key.bin` (0600). **Не терять**:
  без него зашифрованная сессия не расшифруется.
- `OWNER_ID` — число; пусто → владелец тот, кто первый напишет `/start`.
- `USE_LLM_FILTER=false` — дешёвый фильтр (embeddings). При падении embeddings-модели
  система переключается на LLM-фильтр автоматически (`embeddingsFailed()`).
- `TZ=Europe/Moscow` — влияет на «день» в сводке/дайджесте (в коде ещё жёстко зашит
  `MSK_OFFSET = 3h` в `summary.ts`).
- `PORT=3000`, привязка в compose только на `127.0.0.1`.

## 7. Деплой

Прод — **Docker + docker-compose** (`db` postgres:16-alpine + `app`, на базе `oven/bun:1.2-slim`).
Миграции применяются в `CMD ["sh","-c","bun src/db/migrate.ts && bun src/index.ts"]`.
Тома: `./data` (ключ, сессия) и `./cache` (модель embeddings). `pgdata` для postgres.
Healthcheck: `GET /healthz` → `{ok:true,tg:true}`.

Ориентиры ручного деплоя (прод-конфиг может частично отсутствовать в репозитории):
- На bun 1.2-slim нет `Bun.cron` — планировщик только на `setInterval`; в slim нет `wget` —
  healthcheck на `bun -e "fetch(...)"`.
- Ручной деплой: `docker compose up -d --build && docker compose logs -f app`.
- Публичный доступ — за общим HTTPS edge (Caddy), порты наружу не публикуются.

Как деплоить из репозитория: собрать образ (локально Docker обязателен; на NixOS может не быть,
тогда сборка на сервере с Docker), поднять compose с `.env` и подключёнными томами.

## 8. Проверка изменений (обязательно перед commit)

- `bun run check` — typecheck (strict, `noUncheckedIndexedAccess`, `noImplicitOverride`).
- `bun test` — полный прогон; интеграционные зависят от живой Postgres.
- `bun run smoke` — healthz + счётчики БД против запущенного сервиса.
- `bun eval/golden.ts` — если трогали `filter.ts`/`embeddings.ts`/порог: точность/полнота.
- Миграции: при изменении `schema.ts` — `bun run db:generate` и проверить применённые.

## 9. Что учесть при передаче другим (handoff-замечания по коду)

Это ответ на «есть ли моменты, которые нужно учесть в коде при передаче» — накопленные особенности
и грабли по мере написания. Применялись осознанно; менять — только понимая последствия.

1. **Грабли с `tgMsgId` как id сегмента/треда.** `builder.ts` использует `tgMsgId` первого
   сообщения как стабильный id сегмента и треда (переживает рестарт, уникален в чате).
   Раньше локальный счётчик коллизил со старыми разговорами (новые витки тихо дополняли
   вчерашние карточки). **Не заменять на автоинкремент без миграции и пере-линковки.**
2. **Данные не в git.** `data/` (ключ, сессия), `cache/`, `.env` — в `.gitignore`/`.dockerignore`.
   Никогда не коммитить сессию в репозиторий — это секрет.
3. **Секреты редуцируются в логах.** pino `redact`: session, sessionEncrypted, BOT_TOKEN,
   LLM_API_KEY, SESSION_KEY. При добавлении нового секрета — добавить в `redact.paths`.
4. **`API_ID`/`API_HASH` захардкожены** (публичные credentials Telegram Desktop, из open-source),
   в `src/tg/client.ts`. Для передачи в чужие руки стоит, вероятно, вынести их в env.
5. **Два уровня «не слать»**: `paused` и `notifications_enabled=false` (глобальный тумблер в меню).
   `notifications_enabled` — карточки копятся в сводке, но НЕ пушются. Не перепутать в notifier.
6. **День считается по МСК** (`MSK_OFFSET = 3h` в `summary.ts`) и через `TZ` env. Таймзоны —
   частая причина «почему сводка не по тому дню».
7. **Дата строкой ISO в sql-шаблоне.** В `summary.ts` сырой `Date` в sql-шаблоне падает в
   postgres.js (`Buffer.from(Date)` → TypeError) — намеренно передают `toISOString()`.
   Это фикс падения, не косметика.
8. **Владелец-участник → не лид.** `self_tg_id` (id юзербота) сохраняется при старте;
   `isOwnerInvolved()` пропускает диалоги, где `isOutgoing` или автор = self. Не убирать —
   иначе владелец будет получать свои же разговоры.
9. **Планировщик на setInterval, не `Bun.cron`.** Причина — bun 1.2-slim без `Bun.cron`.
   Если перейдёшь на cron API — проверить на образе, а не только локально.
10. **Свежие витки = новые карточки.** Жизнь треда сокращена до `THREAD_TTL_HOURS=12`;
    sweep закрывает треды в памяти и в БД. Новый виток (не reply, пауза > gap) — отдельная карточка.
11. **Локальный фильтр = recall-ориентированный.** Задача — не пропустить интересное
    (`FILTER_THRESHOLD`), переанализ — по cooldown. Не превращать в precision-фильтр без
    перепроверки на eval.
12. **`USE_LLM_FILTER` — fallback на LLM-фильтр**, если локальные embeddings упали
    (`embeddingsFailed()`), и аварийный режим. Требует ключ LLM и валидный JSON по схеме.
13. **Интеграционные тесты живут на реальной Postgres**, изолируются по данным между файлами
    (гонки — частая причина флаки). Не полагаться на порядок тестов.
14. **killswitch/wipeAccount** — `truncate ... cascade` всех важных таблиц + logout. Обратимо
    только через резервную копию. Триггерится из /settings; в коде это необратимо, не вызывать шутя.
15. **Healthcheck только на `fetch `/healthz`,** не на wget/curl (их нет в slim-образе).

## 10. Общие правила при работе в этом репозитории

- Следовать глобальному `AGENTS.md` (по-русски, итог в первом предложении, проверять перед «готово»).
- Коммиты — сфокусированные, с `git diff` до `add`; не включать `data/`, `.env`, артефакты.
- Меняя схему/миграции/фильтр/промпт LLM — обязательно прогон `check` + `test` (+ `eval` где уместно).
- Шаблон: чтобы адаптировать таблицу «Карта проекта» и раздел «Для других» под иной проект —
  заменить пункты разделов 3 и 9 на свои.
# AI Radar — Delivery Record (PLAN)

Класс: **L2** (новый проект). Состояние: `CONTRACT (заморожен) -> PLAN -> EXECUTE -> VERIFY -> AUDIT -> DONE`.
План составлен primary-агентом; дизайн согласован с пользователем в диалоге (см. Ченджлог решений). Роль delivery-planner пропущена: принятый план существует. Финальный аудит — delivery-reviewer после прохождения всех проверок.

Язык реализации/интерфейсов: русский (UI бота и тексты анализа — RU; анализ диалогов — язык диалога).

---

## 1. Контракт

### 1.1. Outcome
Self-hosted шаблон «AI Radar»: один пользователь подключает свой Telegram-аккаунт (grammJS/MTProto), ставит на мониторинг до 100 «живых» чатов, система строит разговоры (сегмент+тред), фильтрует локальными embeddings, анализирует DeepSeek flash v4, присылает в личный чат бота (grammY) карточки возможностей с кнопками. Пользователь копит лайки/дизлайки (обучение весов), учит систему через `/teach`, получает ежедневный дайджест. Установка: `docker compose up` + QR-логин.

### 1.2. Scope (v1)
- Userbot: QR-вход, шифрование session, приём событий, catch-up после простоя, flood-защита.
- Pipeline: normalizer → dedup → двухуровневый conversation builder (segment/thread, паузы) → cheap filter (локальные embeddings, fallback LLM) → DeepSeek анализ (JSON+zod) → scoring → opportunity engine → бот.
- Бот: карточки с кнопками, команды, настройки, история, дайджест, `/teach`, kill switch.
- Обучение: веса тем/чатов от 👍👎, якоря-примеры, авто-трекинг ответов пользователя.
- Retention, лимиты анализа, логирование расходов LLM, `llm_requests` + `/stats`.
- Docker Compose, `.env.example`, README, CHANGELOG.md, eval-набор + unit/integration тесты.

### 1.3. Non-goals (v1)
- Нет веб-панели/фронта. Нет мультиаккаунтности, команды, тарифов, auth (single user).
- Нет автоотправки ответов в чаты (только `suggested_message` для копирования).
- Нет вебхуков по умолчанию (long polling; Hono только `/healthz`).
- Нет pgvector (embedding-сравнения — линейный скан по десяткам якорей, не ANN), нет поиска по сообщениям.
- Нет новых источников (Discord и пр.), нет интеграций (CRM), нет реакций-фидбека (только кнопки).
- Нет мониторинга мегачатов-флуда (авто-отсев по лимиту потока).
- Backlog (не v1, из спеки): watchlist по людям/компаниям (§28), экспорт/бэкап истории, автоотправка ответов (§27), новые источники (§20).

### 1.4. Ключевые пользовательские сценарии
1. Установка: clone → `.env` → `docker compose up` → QR в терминале → сканирование → `/start` в боте (привязка владельца) → `/chats` выбрать чаты → `/profile` заполнить профиль.
2. Пришла возможность → карточка в боте → «Перейти к диалогу» (открыть пост) → ответить в Telegram → карточка сама переходит в «Ответил» и следит за развитием.
3. 👍/👎 на карточке → тема/чат получают приоритет/исключение; повторные 👎 на чат → предложение снять с мониторинга.
4. `/teach` → переслать сообщение или вставить текст → бот анализирует, сохраняет якорь, фильтр учитывает похожее в будущем.
5. Диалог «растянут» (паузы часы/сутки) → тред живёт 48ч, карточка редактируется in-place, повторный пуш только при значимом изменении.
6. Kill switch в `/settings` → подтверждение → logout, удаление session и данных.

### 1.5. Ошибочные сценарии (обязательные для обработки)
- FloodWait: экспоненциальный бэкофф (кап 300с, jitter 10%), 3+ подряд → чат в degraded, уведомление владельцу один раз.
- Отключение LLM/сеть: ретраи (2, бэкофф), после 3 неудач — пропуск анализа, счётчик, уведомление владельцу; воронка продолжает работать без LLM (окна не анализируются, не теряются: возвращаются в очередь при следующем sweep).
- Ошибка парсинга JSON LLM: retry 1 раз; повторная ошибка → анализ NOISE с причиной, без карточки.
- Рестарт: session сохраняется (зашифрована), catch-up по последним msg_id, dedup на ON CONFLICT.
- Повторный тап по кнопке: идемпотентно (answerCallbackQuery «Уже учтено»).
- Смена/потеря авторизации Telegram: `/status` показывает, уведомление «требуется повторный вход» (QR заново).
- Недоступна БД: падение на старте, healthcheck не green, docker restart policy.

### 1.6. Критерии приёмки (продуктовые)
- Установка по README с нуля на чистой машине (Docker) занимает ≤ 15 минут до первого QR.
- 100 живых чатов: сбор 10–30k msg/день без потерь, анализов ≤ 30/час, стоимость ≤ $0.5/день (в `/stats`).
- Карточка содержит: тип, шанс на клиента %, суть, тезисы, что написать, что не писать, кнопки (Перейти/Почему/👍/👎/Удалить). NOISE не приходит.
- 👍 на теме → следующая похожая приходит с более высоким приоритетом; 👎 (2+) → тема не приходит; удаление карточки скрывает её.
- `/teach` сохраняет якорь; похожий разговор в будущем проходит фильтр.
- Растянутый диалог: ответ через 3 часа → тот же тред, карточка обновлена (не дублирована).
- Рестарт контейнера: сессия жива, пропущенное догнано, дубликатов нет.
- Kill switch: session и данные удалены, карточки-уведомления отозваны сообщением.
- Точность: eval-набор ≥ 30 размеченных разговоров, отчёт precision/recall в `eval/report.md`.

### 1.7. Риски и митигации
| Риск | Митигация |
|---|---|
| Бан аккаунта (grammJS, чтение 100 чатов) | только события + catch-up с задержками 0.5–1с/чат, лимит потока на чат, предупреждение в README, kill switch |
| grammJS моложе Telethon, граничные случаи | P1 smoke до всего остального (QR, события, flood); MTProto за интерфейсом `src/tg/types.ts`; при блокере — пауза и решение (Telethon-сайдкар), не «заплатка» |
| transformers.js в Bun (native onnx) | проверка в P3 первой же; fallback `USE_LLM_FILTER=true` — фильтр дешёвой LLM-классификацией (стоимость учтена в /stats) |
| Рост стоимости LLM | воронка (1–5% до LLM), лимит 30 анализов/час, лимит 4/тред/день, учёт в llm_requests |
| Точность анализа | eval-набор, промпт со строгой JSON-схемой, обучение весами |
| Неизвестен точный id модели DeepSeek flash v4 | `LLM_MODEL` в .env (default `deepseek-chat`), при первом запуске проверить работоспособность, README-строка |

### 1.8. Откат
Git-коммит после каждого пакета; миграции drizzle-kit (up/down); старый образ в docker (tag). Rollback: `git revert` + `docker compose down && up` со старым тегом.

---

## 2. Стек и зависимости

- Runtime: **Bun** (≥1.2; Bun.cron для расписаний). Fallback: Node 22 (тот же код; Dockerfile готовит оба варианта через ARG RUNTIME=node|bun).
- Язык: TypeScript strict. Ограничения AGENTS.md: файлы ≤ 300 строк, функции ≤ 40 строк, без монолитов.
- MTProto: **grammJS** (последняя стабильная; API-имена сверить по его типам в P1).
- Бот: **grammY** + плагин `@grammyjs/conversations` (анкеты `/settings`, `/teach`).
- HTTP: **Hono** — только `GET /healthz` (Docker healthcheck).
- БД: PostgreSQL 16, драйвер **postgres.js**, ORM **Drizzle** + **drizzle-kit** (миграции).
- LLM: DeepSeek API (OpenAI-совместимый) через fetch; zod-валидация JSON.
- Embeddings: `@huggingface/transformers` + `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (q8, CPU, ленивая загрузка, кэш в volume).
- QR: `qrcode` (toBuffer PNG).
- Логи: `pino` (redact: session, token, api key).
- Валидация: `zod`. Типы: `@types/bun`, `@types/node`.

Пакеты: `grammjs grammy hono postgres drizzle-orm zod pino qrcode @huggingface/transformers @grammyjs/conversations`; dev: `drizzle-kit typescript @types/*`.

---

## 3. Структура проекта

```
ai-radar/
  PLAN.md  CHANGELOG.md  README.md
  docker-compose.yml  Dockerfile  .env.example  package.json  tsconfig.json
  src/
    index.ts              # bootstrap: config → db → tg → pipeline → bot → scheduler
    config.ts             # zod-схема .env, типы Config
    db/
      client.ts           # postgres.js + drizzle, health()
      schema.ts           # все таблицы (см. §5)
      migrate.ts          # drizzle-kit push/migrate runner
    tg/
      types.ts            # Source-абстракция: TgChat, TgMessage, MonitorApi (login/list/events/catchup)
      client.ts           # grammJS клиент, reconnect, авторизация
      login.ts            # QR-логин (консоль + PNG в бот при наличии owner)
      session-crypto.ts   # AES-256-GCM session-string
      collector.ts        # NewMessage handler → очередь, лимит потока на чат
      catchup.ts          # GetHistory backfill (задержки, flood-guard)
      flood.ts            # callWithFloodGuard, бэкофф, degraded-чаты
      dialogs.ts          # список диалогов для /chats
      deep-link.ts        # t.me/username/post | t.me/c/<id>/<post> | null
    pipeline/
      queue.ts            # in-memory канал (Buffer), backpressure
      store.ts            # batch-запись, dedup ON CONFLICT, привязка thread_id
      normalizer.ts       # чистка, язык, длина, junk-правила
      builder.ts          # сегменты+треды, debounce+потолок, дрейф, sweep
      filter.ts           # правила + embeddings-скоринг (профиль+якоря, веса)
      embeddings.ts       # transformers.js обёртка (локальная), fallback-путь
      analyze.ts          # сбор окна→промпт, вызов LLM, парсинг, ретраи
      score.ts            # приоритет по трекам, пороги уровней уведомлений
      opportunity.ts      # upsert карточки, статусы, re-notify-политика
      tracking.ts         # outgoing-сообщения пользователя → статусы engaged/conversation
    llm/
      client.ts           # fetch к DeepSeek, usage, ретраи, учёт llm_requests
      prompts.ts          # system/user промпты, сборка контекста окна
      schema.ts           # zod: AnalysisResult
    bot/
      app.ts              # grammY bootstrap, long polling, error-хук
      bind.ts             # /start привязка владельца (первый чат, если нет OWNER_ID)
      cards.ts            # рендер карточки (текст), edit/update, level-метки
      buttons.ts          # callback-хендлеры: like/dislike/delete/why/why_back
      commands.ts         # /chats /history /digest /profile /stats /status /pause /resume /card
      settings.ts         # /settings conversation: уровни, тихие часы, пороги
      teach.ts            # /teach conversation: сбор примеров, анализ, якорь
      history.ts          # постраничный список возможностей
      menus.ts            # клавиатуры: список чатов, поля профиля, пагинация
    learn/
      weights.ts          # веса тема/чат/тип: load, apply (like ×1.2, dislike ×0.8, cap)
      anchors.ts          # примеры → эмбеддинги для фильтра
    notify/
      notifier.ts         # отправка карточки, edit in-place, повторный пуш по политике
      digest.ts           # сборка и отправка дайджеста
      owner-alert.ts      # критические ошибки → владельцу
    scheduler/
      jobs.ts             # Bun.cron: digest, retention, sweep, сброс лимитов
    retention/
      cleaner.ts          # удаление старых messages/conversations/people
    people/
      index.ts            # upsert people из анализируемых окон
    security/
      keyring.ts          # ключ: data/key.bin (0600) или SESSION_KEY env
  tests/
    unit/                 # bun test: *.test.ts
    integration/          # с реальной БД (DATABASE_URL_TEST)
    fixtures/             # синтетические последовательности сообщений
  eval/
    golden.ts             # прогон фильтра+LLM(mock) по golden-набору, отчёт
    golden-set.json       # ≥30 размеченных разговоров (тип, сигнал, оценки-ориентиры)
    report.md             # генерируется: precision/recall/стоимость
  scripts/
    smoke.ts              # healthz + getMe + счётчики БД
    setup-env.sh          # генерация .env с ключами (chmod 600)
  data/                   # (gitignored) key.bin, кэш моделей, сессии
```

---

## 4. Конфигурация (.env)

| Переменная | Default | Назначение |
|---|---|---|
| `BOT_TOKEN` | — | токен BotFather (обязателен) |
| `OWNER_ID` | пусто | Telegram user_id владельца; если пусто — привязка первым `/start` |
| `DATABASE_URL` | `postgres://radar:radar@db:5432/radar` | |
| `LLM_API_KEY` | — | DeepSeek ключ |
| `LLM_MODEL` | `deepseek-chat` | id модели (flash v4 — вписать актуальный; проверить при первом запуске) |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI-совместимый |
| `SESSION_KEY` | пусто | если пусто — генерируется в `data/key.bin` (0600) |
| `MONITOR_CHAT_LIMIT` | `100` | максимум включённых чатов |
| `CHAT_MSG_PER_MIN_CAP` | `60` | лимит потока на чат (флуд-отсев) |
| `CATCHUP_HOURS` | `6` | глубина догона после простоя |
| `ANALYSIS_PER_HOUR` | `30` | лимит LLM-анализов/час |
| `THREAD_ANALYSES_PER_DAY` | `4` | лимит переанализов треда/день |
| `SEGMENT_GAP_MIN` | `45` | пауза для склейки сегмента (мин) |
| `DEBOUNCE_QUIET_MIN` | `5` | тишина до анализа |
| `DEBOUNCE_MAX_AGE_MIN` | `20` | потолок возраста сегмента |
| `THREAD_TTL_HOURS` | `48` | жизнь треда без активности |
| `FILTER_THRESHOLD` | `0.45` | порог embeddings-схожести (recall-настройка) |
| `RETENTION_DAYS` | `30` | срок хранения messages |
| `QUIET_HOURS` | `23:00-09:00` | тихие часы уведомлений |
| `NOTIFY_LEVEL` | `opportunities` | critical\|important\|opportunities |
| `DIGEST_TIME` | `09:00` | время дайджеста (TZ контейнера) |
| `USE_LLM_FILTER` | `false` | принудительный fallback фильтра |
| `LOG_LEVEL` | `info` | pino |
| `PORT` | `3000` | healthz |
| `TZ` | `Europe/Moscow` | часовой пояс контейнера |

---

## 5. Схема БД (Drizzle)

```ts
users:            id serial pk, profile jsonb (default {}), settings jsonb (default {}), created_at
tg_accounts:      id pk, user_id fk, session_encrypted text, status text('active'|'needs_auth'|'disabled'), last_sync_at, created_at
chats:            id pk, tg_chat_id bigint unique, title text, username text null, type text('group'|'supergroup'|'channel'|'megagroup'),
                  enabled bool default false, priority int default 0, category text null,
                  watch_weight real default 1.0, msg_cap_exceeded bool default false, created_at
messages:         id bigint pk (identity), chat_id fk, tg_msg_id bigint, author_id bigint, author_name text,
                  text text, lang text, ts timestamptz, is_outgoing bool default false,
                  reply_to_tg_msg_id bigint null, thread_id fk null, raw jsonb, unique(chat_id, tg_msg_id)
conversations:    id pk, chat_id fk, kind text('segment'|'thread'), root_msg_id bigint,
                  state text('open'|'closed') default 'open', first_ts, last_ts, msg_count int,
                  topic text null, last_analyzed_at null, analyses_today int default 0,
                  closed_at null, unique(chat_id, kind, root_msg_id)
opportunities:    id pk, conversation_id fk unique, chat_id fk, type text, signal_track text('client'|'expertise'),
                  relatedness text('direct'|'adjacent'|'contextual'), stage text, topic text,
                  scores jsonb, client_probability real, priority real,
                  summary text, reasoning jsonb, talking_points jsonb, avoid jsonb,
                  recommended_action text, suggested_message text,
                  status text default 'new',      // new|viewed|engaged|conversation|lead|client|deleted|closed
                  tg_card_msg_id bigint null,     // сообщение-карточка в боте
                  last_activity_ts, last_notified_at null, notify_count int default 0,
                  created_at, updated_at
ai_analyses:      id pk, opportunity_id fk, conversation_id fk, model text, tokens_in int, tokens_out int,
                  cost_usd real, raw jsonb, created_at
llm_requests:     id pk, stage text, model text, tokens_in int, tokens_out int, cost_usd real, ms int, created_at
feedback:         id pk, opportunity_id fk, chat_id fk, kind text('like'|'dislike'|'delete'|'resolved'),
                  topic text, created_at, unique(opportunity_id, kind)
examples:         id pk, user_text text, source text, topic text, note text,
                  embedding real[] null, enabled bool default true, created_at
people:           id pk, tg_user_id bigint unique, name text, topics jsonb default '[]',
                  relevant_discussions int default 0, last_seen_ts, created_at
notifications:    id pk, opportunity_id fk, tg_card_msg_id bigint, kind text('card'|'update'|'digest'), ts
```

Индексы: `messages(chat_id, ts)`, `messages(chat_id, tg_msg_id)` unique, `conversations(chat_id, state)`, `opportunities(status, created_at)`, `feedback(opportunity_id)`.
Расходы LLM: `llm_requests` накопительно; `/stats` = SUM за сутки.
settings.jsonb пользователя: `{notify_level, quiet_hours:{start,end}, thresholds:{...}, digest_time, retention_days, analysis_per_hour, thread_analyses_per_day}`.
profile.jsonb: `{what_i_do, services, products, niches, audience, geography, min_check, preferred_check, topics, disliked_topics, competitors, expertise, opportunity_types, style}`.

---

## 6. Пайплайн (детально)

### 6.1. Приём и запись
- `collector.ts`: граммJS `NewMessage` handler. Для каждого события: `normalize-lite` (текст, автор, reply_to, out-флаг, ts) → `queue.push`. Обработчик O(1), никакого I/O.
- Лимит потока: счётчик msg/мин на чат; превышение `CHAT_MSG_PER_MIN_CAP` → чат `msg_cap_exceeded=true`, сообщения не пишутся, в `/chats` метка «флуд», фильтр исключает чат (владелец может поднять лимит).
- `store.ts`: drain каждые 2–5с или 500 шт: batch INSERT … ON CONFLICT (chat_id, tg_msg_id) DO NOTHING RETURNING id → вернувшиеся id идут в builder. Пропущенные по конфликту — дубликаты (catch-up overlap).
- Сообщения собственного аккаунта (`is_outgoing=true`) пишутся тоже — нужны для трекинга и контекста.

### 6.2. Conversation Builder (двухуровневый)
- Память: `Map<chatId, Window>` — rolling ~200 последних сообщений + map reply-связей.
- **Сегмент**: сообщение входит в сегмент, если (reply_to ∈ сегмента) ИЛИ (пауза от последнего сообщения ≤ `SEGMENT_GAP_MIN`=45). Иначе — новый сегмент. Одиночное сообщение — сегмент из 1 (анализ только при strong-схожести, порог ×1.25).
- **Тред**: сегменты связываются в тред, если (reply-цепочка продолжается) ИЛИ (общие участники + перекрытие темы). Тред живёт `THREAD_TTL_HOURS`=48 после `last_ts`, затем `closed`.
- **Debounce**: анализ сегмента/треда при тишине 5 мин ИЛИ возрасте ≥ 20 мин (потолок для медленных чатов).
- **Дрейф**: новые сообщения в открытом треде после анализа → переанализ, если прошёл cooldown 30 мин И `analyses_today < THREAD_ANALYSES_PER_DAY` И тред не `closed`. Sweep каждые 15 мин — страховка от потерянных событий.
- Привязка: `messages.thread_id`, `conversations` (segment/thread, `root_msg_id`), открытые треды закрываются по TTL в sweep.

### 6.3. Cheap Filter
Порядок (дешёвое → дорогое):
1. Правила-отсев (нормализовано): системные сообщения, рекламные паттерны (частые ссылки/упоминания @), слишком короткое (<20 симв.), слишком длинное (>2000), пустые. Сегмент из 1 сообщения: требует higher threshold.
2. Embeddings (локально, `embeddings.ts`): представитель окна = mean-pool последних ≤5 текстовых сообщений. Схожесть: `max(cos(win, profile_emb), max over anchors(cos(win, anchor_emb))) × chat.watch_weight × topic_weight`; проход при ≥ `FILTER_THRESHOLD`.
3. Профиль-эмбеддинг: из `profile.what_i_do + services + niches + topics` (кэшируется, пересчёт при изменении профиля).
4. Fallback (`USE_LLM_FILTER=true` или ошибка загрузки модели — авто-фолбэк с одним уведомлением владельцу): дешёвая классификация окна DeepSeek: `relevant: bool, reason` (учёт в llm_requests).
5. Анти-дубль возможностей: у треда уже есть opportunity со статусом ≠ deleted/closed → не создаём новую, только переанализ (§6.5).

Цель: до LLM-анализа доходит 1–5% окон (recall-настроен фильтр, точность — у LLM).

### 6.4. LLM-анализ (`llm/`)
- Контекст окна: последние ≤15 сообщений / ≤4000 симв.: `#{i} [имя, HH:MM] текст` + reply-стрелки; при переанализе добавляется «Предыдущий анализ: type/priority» + новые сообщения.
- Conversation memory (спека §18): если у участников окна есть история в `people` — добавлять в контекст строку «Автор: темы за 30 дней: …» (cap 2 участника, ≤200 симв.), чтобы переписка недельной давности повышала confidence.
- Промпт (RU): системный — роль эксперта-аналитика чатов; правила: оценивать ДИАЛОГ, не сообщение; определять трек (client/expertise), связанность (direct/adjacent/contextual), траекторию и дрейф; NOISE — если ценности нет; `suggested_message` — на языке диалога, 2–4 предложения, естественно, учитывать динамику (кто кого поддерживает); запреты из профиля (style, disliked_topics) и глобальные («не агрессивно», «не предлагать услуги» в suggested_message).
- Ответ — строгий JSON (схема `llm/schema.ts`, zod). Поля: `relevance, purchase_intent, engagement_opportunity, future_potential, urgency, client_probability, type, signal_track, relatedness, stage, trajectory, topic, summary, reasoning[], talking_points[], avoid[], recommended_action, suggested_message`. NOISE: заполняются только `type=NOISE`, `summary`, `reasoning` — остальные null.
- Ретраи: ошибка сети/5xx — 2 повтора с бэкоффом; невалидный JSON — 1 повтор с подсказкой «верни только JSON».
- Учёт: `llm_requests` (stage=analyze|filter|teach|digest, tokens из usage, cost из формулы $/MTok env `LLM_COST_IN`, `LLM_COST_OUT`, default по модели).

### 6.5. Scoring и Opportunity Engine
- База по треку: client: `0.4×intent + 0.3×relevance + 0.2×urgency + 0.1×engagement`; expertise: `0.4×engagement + 0.3×future + 0.2×relevance + 0.1×intent`. `client_probability` — от LLM (сквозной).
- Итог: `priority = base × chat_weight × topic_weight × type_weight` (веса из learn/weights.ts, дефолт 1.0).
- Уровни уведомлений (по `settings.notify_level`): critical → только HOT_LEAD при priority ≥ 80; important → HOT/WARM при ≥ 65; opportunities (default) → все типы кроме NOISE/INFORMATION при ≥ 55. Ниже порога: opportunity сохраняется, карточка не шлётся.
- **Upsert**: по `conversation_id`. Новый: insert + карточка. Существующий: обновление полей; если `Δpriority ≥ 10` ИЛИ сменился `type` → повторный пуш (edit + уведомление по уровню); иначе — тихий edit карточки (строка «+N сообщений, 87% → 93%»).
- Статусы: `new → viewed (открыл Почему?) → engaged (ответил сам) → conversation (ответили ему) → lead/client (вручную? нет — по фидбеку)`. Закрытие: 👎2+ на тему/«🗑 Удалить» → deleted; по TTL треда — closed через 48ч.
- `tracking.ts`: outgoing-сообщения пользователя сопоставляются с открытыми opportunities чата (по thread_id): первое → engaged, последующий ответ собеседника → conversation; карточка редактируется (галочка «вы ответили ✓»).

### 6.6. People (для дайджеста)
При каждом анализе окна (type ≠ NOISE): upsert участников — `relevant_discussions++`, `topics` (cap 20, добавить topic окна), `last_seen_ts`. Только данные публичного общения, без «досье».

---

## 7. Бот (grammY)

### 7.1. Карточка (точный шаблон)

```
🧠 Обсуждение · шанс на клиента: 15%
Чат: AI-разработчики

📌 Суть: спор «Claude vs GPT» для кодинга; большинство поддерживает Codex.

💡 Тезисы: • У большинства опыт с Codex • Возражения остаются без аргументов

💬 Можно написать:
«У меня тоже есть опыт с Codex — после перехода код стал заметно чище, а инструкции выполняются точнее…»

🚫 Не писать: не спорить агрессивно · не предлагать услуги

[🔗 Перейти к диалогу] [📖 Почему?]
[👍] [👎] [🗑 Удалить]
```

Метки типов: HOT_LEAD=🔥 Горячий лид, WARM_LEAD=🟢 Тёплый лид, DISCUSSION=🟡 Обсуждение, EXPERTISE=🧠 Экспертиза, NETWORKING=🤝 Нетворкинг, FUTURE=🔵 На будущее, INFORMATION=ℹ️ Информация. NOISE не отправляется.
«Почему?» — edit той же карточки: reasoning[], recommended_action, trajectory/drift, расчёт оценок; кнопка «← Назад».

### 7.2. Кнопки (callback data)
`cb:like:{id}`, `cb:dislike:{id}`, `cb:delete:{id}`, `cb:why:{id}`, `cb:why_back:{id}`, история `cb:hist:{page}`, чаты `cb:chat:{tgChatId}:{0|1}`, пагинация/меню — по схеме `cb:{ns}:{value}`. Идемпотентность: фидбек like/dislike — unique(opportunity_id, kind), повторный тап → `answerCallbackQuery('Уже учтено')`.

Семантика:
- 👍 → `topic_weight` темы ×1.2 (cap 3.0), `chat_weight` ×1.1, feedback like;
- 👎 → тема ×0.8; при 2-м 👎 по теме — тема в blacklist (weight 0.05) — «такую тему больше не присылаем»; при 3-х 👎 на чат — предложение убрать чат (inline-кнопка подтверждения);
- 🗑 Удалить → deleteMessage карточки, status=deleted, feedback delete;
- 🔗 Перейти к диалогу — URL: публичный `https://t.me/{username}/{msgId}`; приватный супергруппа/канал `https://t.me/c/{id без -100}/{msgId}`; basic group или нет данных → кнопки нет, в карточке подпись «чат: {title}».

### 7.3. Команды
`/start` (привязка владельца: если OWNER_ID пуст — первый чат становится владельцем; иначе только OWNER_ID; ответ — меню команд) ·
`/chats` (список с пагинацией, кнопки вкл/выкл, метки приоритета/флуд) ·
`/history` (последние 10, пагинация; каждая: статус, приоритет, суть; кнопка «Открыть» → карточка) ·
`/card {id}` (переоткрыть карточку по id) ·
`/digest` (дайджест сейчас) ·
`/profile` (просмотр; кнопки редактирования полей: what_i_do, services, niches, topics, style — conversation-анкета; остальные поля — через `data/profile.json`, перечитывается при рестарте) ·
`/settings` (уровень уведомлений, тихие часы, порог фильтра, лимиты, «Отключить аккаунт» — kill switch с подтверждением) ·
`/pause` `/resume` (пауза уведомлений) ·
`/stats` (сегодня: анализов, расход $, возможностей, топ-чаты) ·
`/status` (состояние: аккаунт, сессия, чатов включено, очередь, LLM-линки) ·
`/teach` (см. §8).

### 7.4. Обработка ошибок бота
`bot.catch` → pino error + owner-alert (не чаще 1/час). При «бот заблокирован» — попытка рестарта long polling с бэкоффом.

---

## 8. Обучение

### 8.1. Веса (`learn/weights.ts`)
- Хранятся в profile/настройках (jsonb users.settings.weights: `{topics:{topic: w}, chats:{chatId: w}, types:{type: w}}`), применяются в фильтре и скорринге. Загрузка в память при старте, сохранение при изменении.
- Формулы: 👍 topic ×1.2 (cap 3.0), chat ×1.1 (cap 2.0); 👎 topic ×0.8 (floor 0.05 = blacklist), после 2 👎 — 0.05; type-weight: HOT/WARM +0.1 на 👍 (cap +0.3), NOISE-типы от 👎.

### 8.2. `/teach` (примеры-якоря)
Flow (conversation plugin):
1. «Пришлите текст обсуждения или перешлите сообщения (до 10)»;
2. Приём: текст / forwarded (граммY `on('message:forward')` собирает текст цепочки) / опциональный комментарий;
3. Анализ DeepSeek (stage=teach): `{topic, relevance_explanation, should_track: bool}`; если should_track=false → «Похоже, это не под тематику — сохранить всё равно?» (кнопки);
4. Сохранение `examples`: user_text, topic, note, embedding (локальный);
5. Ответ: «Понял, сохранил: тема — {topic}. Буду учитывать похожее»;
6. Фильтр: схожесть окна с anchors = max(cos с примерами) — буст в формулу фильтра (см. 6.3.2).
Ограничение: ссылки на приватные посты бот открыть не может — только текст/пересылка (написано в подсказке flow).

---

## 9. Расписания (Bun.cron, `scheduler/jobs.ts`)

| Cron | Действие |
|---|---|
| `DIGEST_TIME` ежедневно | дайджест: найдено N (🔥2 🟢5 🟡6 🔵4), топ-3 по priority, люди для наблюдения (топ-3 по relevant_discussions за 7 дней) |
| 04:00 ежедневно | retention: messages старше `RETENTION_DAYS` удалить; conversations closed старше 90 дней; opportunities deleted старше 90 дней; people без активности 180 дней |
| каждые 15 мин | sweep builder: закрыть треды по TTL, переанализ «дозревших» (страховка после рестарта) |
| каждый час | сброс in-memory счётчика анализов/час |

---

## 10. Безопасность

- Session-строка grammJS шифруется AES-256-GCM (random IV на каждое сохранение) ключом из `data/key.bin` (0600) или `SESSION_KEY` env. В БД — только шифротекст.
- pino redact: `session`, `BOT_TOKEN`, `LLM_API_KEY`, `SESSION_KEY`, `authorization`.
- Никаких секретов в текстах карточек и логах; уведомление владельцу не содержит session/токенов.
- Kill switch (`/settings → Отключить аккаунт → Да, отключить и стереть`): `client.logOut()`, delete tg_accounts + messages + conversations + opportunities + ai_analyses + feedback + notifications (транзакция), status=disabled, подтверждение владельцу.
- Telegram-защита: catch-up 0.5–1с между чатами, batch ≤ 50, flood-бэкофф (кап 300с, jitter), лимит потока на чат, не логировать raw-контент приватного.

---

## 11. Docker и установка

`docker-compose.yml`: сервис `db` (postgres:16-alpine, healthcheck pg_isready, volume pgdata) + сервис `app` (build ., env_file .env, depends_on db healthy, volumes: `./data:/app/data`, `./cache:/app/cache` (кэш моделей), ports: 3000, restart unless-stopped, healthcheck curl /healthz).
`Dockerfile`: `oven/bun:1` → copy package.json + bun.lock → `bun install --frozen-lockfile --production` → copy src → `CMD ["bun", "src/index.ts"]`. ARG RUNTIME=node для fallback (`npm ci --omit=dev`, `CMD node src/index.ts`).
`scripts/setup-env.sh`: генерация `.env` из `.env.example` с случайными SESSION_KEY, DB-паролем; chmod 600.
README: требования (Linux, Docker), установка за 7 шагов, первый запуск (QR), команды бота, настройка, устранение проблем (flood, «требуется повторный вход», LLM 401), предупреждение о риске бана аккаунта, лимиты.

---

## 12. Пакеты реализации (порядок и проверки)

### P0 — Каркас и БД
Файлы: package.json, tsconfig, docker-compose, Dockerfile, .env.example, setup-env.sh, src/config.ts, src/db/*, src/index.ts (заглушка bootstrap: config→db→healthz), scripts/smoke.ts.
Acceptance: `bun install` ок; `bun run check` (tsc --noEmit) чист; `docker compose up -d db` → миграции apply (drizzle-kit migrate) → `/healthz` 200 → smoke.ts показывает 0 строк.
Проверки: typecheck, миграция up/down, healthcheck, smoke.

### P1 — MTProto smoke (самый рискованный)
Файлы: src/tg/{types,client,login,session-crypto,flood,dialogs,deep-link}.ts.
Acceptance: QR-логин в консоли работает; сессия сохраняется зашифрованной и переживает рестарт; список диалогов отдаётся (граммJS: имена методов сверить с типами пакета — зафиксировать в коде); FloodWait-бэкофф юнит-тестом (mock); deep-link для публичного/приватного/basic-group.
Проверки: юнит (crypto round-trip, flood-логика, deep-link), ручной smoke с реальным аккаунтом пользователя (нужна помощь пользователя: сканировать QR), рестарт без повторного входа.
**Блокер-гейт**: если grammJS не проходит smoke (логин/события) — пауза, решение с пользователем (Telethon-сайдкар), без «заплаток».

### P2 — Коллектор и хранение
Файлы: src/pipeline/{queue,store,normalizer}.ts, tg/catchup.ts.
Acceptance: события из живого чата → строки в messages (текст, автор, reply, out); dedup на повторном catch-up; лимит потока на чат работает; batch-запись без блокировки event-loop.
Проверки: юнит (normalizer, queue), integration (вставка+конфликт на тестовой БД), ручной: сообщение в тестовом чате → строка.

### P3 — Builder + фильтр (embeddings-гейт)
Файлы: src/pipeline/{builder,filter,embeddings}.ts.
Acceptance: синтетические последовательности (паузы 5м/2ч/26ч, reply-цепочки, дрейф темы) группируются верно (юнит-фикстуры); debounce+потолок; тред-мерж; embeddings загружаются в Bun (первый прогон скачивает модель, кэш); фильтр пропускает релевантное и режет флуд; fallback-путь компилируется.
Проверки: юнит на фикстурах (включая границы: 45 мин ±, TTL 48ч, одиночное сообщение), eval-замер схожести на 10 окнах из fixtures, ручной прогон на реальном чате.

### P4 — LLM-анализ, scoring, opportunity engine + eval v1
Файлы: src/llm/*, src/pipeline/{analyze,score,opportunity}.ts, eval/*, src/people/index.ts.
Acceptance: промпт+схема валидны; парсинг JSON с retry (фикстуры: валидный/невалидный/NOISE); scoring-формулы юнит; upsert opportunity и re-notify-политика (Δ≥10 или тип сменился); учёт llm_requests; история участников из people попадает в контекст промпта; golden-set ≥30 → отчёт precision/recall в eval/report.md (LLM mock).
Проверки: юнит (score, opportunity, парсинг), integration (upsert, статусы), eval-прогон, /stats считает расход.

### P5 — Бот
Файлы: src/bot/*, src/notify/notifier.ts.
Acceptance: привязка владельца (/start); карточка по шаблону §7.1; все кнопки работают и идемпотентны; команды /chats /history /card /digest /pause /resume /stats /status; /settings-анкета (уровни, тихие часы, kill switch с подтверждением); тихие часы реально гасят отправку.
Проверки: юнит (рендер карточки, callback-обработка, deep-link), ручной walkthrough пользователя (чек-лист в README), проверка edit in-place при переанализе.

### P6 — Обучение и трекинг
Файлы: src/learn/*, src/bot/teach.ts, src/pipeline/tracking.ts.
Acceptance: 👍/👎 меняют веса (юнит); blacklist темы после 2 👎; /teach сохраняет якорь с embedding, фильтр учитывает (юнит на фикстуре: окно, похожее на пример, проходит); авто-трекинг: собственное сообщение → engaged, ответ → conversation (юнит по фикстурам).
Проверки: юнит весов/трекинга/teach-flow (mock LLM), ручной e2e: лайк → приоритет растёт; ответ в чате → карточка обновляется.

### P7 — Хардненинг, документация, аудит
Файлы: README.md, CHANGELOG.md (0.1.0), retention/cleaner.ts, owner-alert, финальные проверки.
Acceptance: README полный (7 шагов установки); CHANGELOG 0.1.0; retention чистит по TTL (integration-тест); все тесты зелёные: `bun test`, `bun run check`; docker compose up с нуля по README (чистая машина, сухие данные); smoke.ts ок.
Проверки: полный прогон тестов, typecheck, docker build, ручная установка по README, отчёт по ошибочным сценариям §1.5 (чек-лист).
Затем: delivery-reviewer (финальный аудит L2) с контрактом, диффом, evidence; MUST_FIX → один пакет исправлений + повторный аудит дельты.

---

## 13. Тесты и eval

- Юнит (`tests/unit`, bun test): session-crypto, normalizer, builder (фикстуры: паузы/replies/дрейф/одиночные), filter-правила, score, weights, cards (шаблон), prompts-parse (валидный/невалидный JSON), deep-link, flood-логика, retention-запрос.
- Интеграция (`tests/integration`, реальная Postgres `DATABASE_URL_TEST`): dedup-вставка, upsert opportunity, статусы, веса в БД, kill-switch-транзакция.
- LLM в тестах — mock (загрузка fixtures-ответов); сетевые вызовы — только в ручных проверках.
- Eval (`eval/golden.ts`): golden-set.json ≥30 размеченных (тип, track, бинарная «ценность»), прогон filter(локально)+score+mock-LLM → precision/recall по «ценности», стоимость (токены mock), отчёт в eval/report.md; перезапуск при изменениях фильтра/скорринга.
- Ручной чек-лист (README, раздел «Проверка после установки»): QR, карточка, кнопки, /teach, kill switch, рестарт, тихие часы.

---

## 14. Ченджлог решений

- **v0 (2026-08-12)** — исходная спека ChatGPT (36 разделов, SaaS-ориентированная, web-панель, Celery, Python).
- **v1.0** — финальная спецификация, согласована в диалоге:
  - Цель: self-hosted шаблон для одного пользователя (не SaaS; без auth/тарифов/команд).
  - Без веб-панели; весь UX — Telegram-бот (решение после сравнения канал/группа/Избранное: бот даёт гарантированный push + кнопки + управление).
  - Мониторинг: свой основной аккаунт (MTProto), до 100 «живых» чатов; риск бана принят, mitigation: лимиты, flood-бэкофф, kill switch.
  - LLM: DeepSeek flash v4 (env `LLM_MODEL`); локальные embeddings (fallback: дешёвая LLM-классификация).
  - Стек: TS + Bun + grammJS + grammY + Hono(health) + PostgreSQL + Drizzle (вместо Python/FastAPI/Telethon/Celery).
  - Анализ — диалог, не сообщение: двухуровневая группировка сегмент+тред (паузы до 48 ч), debounce 5/20 мин, детекция дрейфа, переанализ с cooldown и лимитами.
  - Два трека сигналов: 🎯 client (запуск/хостинг/разработка — intent-взвешивание) и 🧠 expertise (споры об инструментах — engagement/future-взвешивание); разные рекомендации.
  - Карточка: тип, шанс на клиента %, суть, тезисы, «что написать» (готовый текст под динамику диалога), «что не писать»; кнопки 🔗/📖/👍/👎/🗑.
  - Обучение: веса тем/чатов из 👍👎 (фильтр и скорринг), `/teach` с примерами-якорями, авто-трекинг ответов пользователя.
  - Дайджест, retention 30 дней, шифрование session AES-256-GCM, kill switch, учёт расходов LLM.

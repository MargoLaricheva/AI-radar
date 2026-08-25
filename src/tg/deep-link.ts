// Построение deep-link на сообщение в Telegram

/**
 * Публичные чаты: https://t.me/<username>/<msgId>
 * Супергруппы/каналы: https://t.me/c/<id>/<msgId>
 *   — id может быть отрицательным peer (-100xxxxxxxxxx) или положительным Channel.id из entity
 * Basic groups: ссылки нет (null) — карточка покажет только название чата.
 */
export function buildMessageLink(
  chat: { username?: string | null; tgChatId: number },
  tgMsgId: number,
): string | null {
  if (chat.username) return `https://t.me/${chat.username}/${tgMsgId}`;
  const id = chat.tgChatId;
  if (id < 0) {
    const abs = -id;
    if (abs >= 1_000_000_000_000) {
      return `https://t.me/c/${abs - 1_000_000_000_000}/${tgMsgId}`;
    }
    return null; // basic group
  }
  if (id > 0) {
    // положительный Channel.id (супергруппа/канал из entity) — c-ссылка
    return `https://t.me/c/${id}/${tgMsgId}`;
  }
  return null;
}

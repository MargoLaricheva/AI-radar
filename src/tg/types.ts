// Source-абстракция (спека §20): единый интерфейс источника, реализация — Telegram

export interface TgChatInfo {
  tgChatId: number;
  title: string;
  username: string | null;
  type: "group" | "supergroup" | "channel" | "megagroup";
  participantsCount?: number;
  lastActivityAt?: Date;
}

export interface TgMessage {
  chatId: number;
  tgMsgId: number;
  authorId: number | null;
  authorName: string | null;
  text: string;
  lang: string;
  ts: Date;
  isOutgoing: boolean;
  replyToTgMsgId: number | null;
}

export interface MonitorApi {
  getMe(): Promise<{ id: number; firstName?: string; username?: string }>;
  listChats(): Promise<TgChatInfo[]>;
  fetchHistory(chatId: number, opts: { offsetId?: number; limit?: number }): Promise<TgMessage[]>;
  /** подписка на новые сообщения; возвращает функцию отписки */
  onMessage(handler: (msg: TgMessage) => void): () => void;
  isAuthorized(): Promise<boolean>;
  disconnect(): Promise<void>;
}

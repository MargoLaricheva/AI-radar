import type { TgMessage } from "../tg/types";

// In-memory буфер сообщений между collector и writer/builder.
// Обработчик события только кладёт сообщение сюда (O(1)), drain вызывается по таймеру.

export class MsgQueue {
  private items: TgMessage[] = [];
  private size = 0;

  push(msg: TgMessage): void {
    this.items.push(msg);
    this.size++;
  }

  drain(): TgMessage[] {
    if (this.size === 0) return [];
    const out = this.items;
    this.items = [];
    this.size = 0;
    return out;
  }

  get length(): number {
    return this.size;
  }
}

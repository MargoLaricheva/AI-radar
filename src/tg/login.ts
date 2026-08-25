import { TelegramClient } from "telegram";
import { signInUserWithQrCode } from "telegram/client/auth.js";
import QRCode from "qrcode";
import { API_ID, API_HASH } from "./client";

export interface QrCallbacks {
  /** получить PNG-код (buffer) для отправки владельцу */
  onQrPng: (png: Buffer, expiresIn: number) => Promise<void> | void;
  onConsole?: (text: string) => void;
  /** пароль 2FA (облачный пароль аккаунта), если включён */
  password?: () => Promise<string>;
}

/**
 * QR-логин нового аккаунта. Возвращает строку session после сканирования.
 * Токен от Telegram — это tg://login?token=..., QR-код строится по https://t.me/<token>.
 */
export async function loginWithQr(client: TelegramClient, cb: QrCallbacks): Promise<string> {
  await client.connect();
  const qrLogin = signInUserWithQrCode(client, { apiId: API_ID, apiHash: API_HASH }, {
    qrCode: async ({ token, expires }) => {
      // token — бинарные байты; Telegram ожидает их в base64url внутри tg://login?token=...
      const tokenStr = Buffer.from(token as Uint8Array).toString("base64url");
      const url = `tg://login?token=${tokenStr}`;
      cb.onConsole?.(`Отсканируйте QR в Telegram: Настройки → Устройства → Сканировать QR (действует ${expires}с)`);
      const png = await QRCode.toBuffer(url, { width: 512, margin: 2 });
      await cb.onQrPng(png, expires);
    },
    onError: (err: Error) => {
      throw err;
    },
    password: cb.password ? async (hint?: string) => {
      cb.onConsole?.(hint ? `2FA: подсказка — «${hint}»` : "2FA: запрашиваю пароль");
      return cb.password!();
    } : undefined,
  });
  await qrLogin;
  const session = client.session.save() as unknown as string;
  return session;
}

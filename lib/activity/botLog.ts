// «Большой брат» — журнал исходящих сообщений бота «Аналитик» (миграция 297, bot_message_log).
// Вызывается из lib/bitrix/notify.ts. Строка заводится ДО отправки; её id попадает в ссылки Монолитики внутри
// сообщения (?src=bot&m=<id>) — трекер кладёт src/m в первый просмотр. Текст сообщения не храним (ПДн).
// Ничто здесь не бросает: сбой журнала не должен мешать отправке.
import { systemDb } from '@/lib/db/clients';

export type BotMessageMeta = { kind?: string | null; entityType?: string | null; entityId?: string | number | null };

const origin = () => (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.ru').replace(/\/$/, '');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Пометить ссылки на страницы Монолитики (не /api/) меткой src=bot&m=<id>. Ссылки на Битрикс и картинки не трогает. */
export function tagBotLinks(message: string, id: number): { text: string; links: number } {
  let links = 0;
  const re = new RegExp(`${esc(origin())}(/[^\\s\\]\\["'<>]*)?`, 'g');
  const text = message.replace(re, (raw, path: string | undefined) => {
    // хвостовая пунктуация голой ссылки («…/profile,») — не часть адреса
    const tail = raw.match(/[.,;:!?)]+$/)?.[0] ?? '';
    const url = tail ? raw.slice(0, -tail.length) : raw;
    if ((path ?? '').startsWith('/api/') || /[?&]src=bot(&|$)/.test(url)) return raw;
    const hashAt = url.indexOf('#');
    const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const hash = hashAt >= 0 ? url.slice(hashAt) : '';
    links++;
    return `${base}${base.includes('?') ? '&' : '?'}src=bot&m=${id}${hash}${tail}`;
  });
  return { text, links };
}

/** Завести строку журнала. null — журнал недоступен (до миграции 297 и т.п.). */
export async function openBotMessage(channel: string, recipient: string, meta: BotMessageMeta | undefined, hasImage: boolean, status = 'pending'): Promise<number | null> {
  try {
    const r = await systemDb().query<{ id: string }>(
      `INSERT INTO bot_message_log (channel, recipient_bitrix_id, kind, entity_type, entity_id, has_image, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [channel, String(recipient).slice(0, 40), meta?.kind ?? channel, meta?.entityType ?? null,
       meta?.entityId != null ? String(meta.entityId).slice(0, 80) : null, hasImage, status],
    );
    return Number(r.rows[0]?.id) || null;
  } catch (err) {
    console.warn('[bot-log] не записалось:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function closeBotMessage(id: number | null, p: { status: 'sent' | 'failed'; bitrixMessageId?: number; links?: number }): Promise<void> {
  if (!id) return;
  try {
    await systemDb().query(
      `UPDATE bot_message_log SET status = $2, bitrix_message_id = $3, links = $4 WHERE id = $1`,
      [id, p.status, p.bitrixMessageId || null, p.links ?? 0],
    );
  } catch (err) {
    console.warn('[bot-log] не обновилось:', err instanceof Error ? err.message : err);
  }
}

/** Обёртка отправки: журнал + метки ссылок. send получает уже помеченный текст. */
export async function withBotLog(
  channel: string, recipient: string, message: string, hasImage: boolean, meta: BotMessageMeta | undefined,
  send: (text: string) => Promise<number>,
): Promise<number> {
  const id = await openBotMessage(channel, recipient, meta, hasImage);
  const tagged = id ? tagBotLinks(message, id) : { text: message, links: 0 };
  try {
    const msgId = await send(tagged.text);
    await closeBotMessage(id, { status: msgId ? 'sent' : 'failed', bitrixMessageId: msgId, links: tagged.links });
    return msgId;
  } catch (e) {
    await closeBotMessage(id, { status: 'failed', links: tagged.links });
    throw e;
  }
}

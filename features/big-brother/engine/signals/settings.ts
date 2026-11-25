// «Большой брат», поток G — настройки еженедельного дайджеста директору. Отдельной таблицы нет: строка
// bot_channels.key = 'big_brother_digest' (миграция 298) — enabled = вкл/выкл функции (видно и в «Настройки → Боты →
// Аналитик»), config = { mode, recipients, previewTo, hour } (types.ts::DigestSettings). По умолчанию выключен,
// режим «предпросмотр» — уходит только previewTo (владелец, 2098).
import { systemDb } from '@/lib/db/clients';
import { invalidateBotChannelCache } from '@/lib/bitrix/notify';
import { DIGEST_DEFAULTS, type DigestSettings } from './types';

export const DIGEST_CHANNEL = 'big_brother_digest' as const;

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map(String).map(s => s.trim()).filter(s => /^\d{1,10}$/.test(s)))] : [];

export function normalizeDigest(raw: Partial<DigestSettings> & Record<string, unknown>, enabled: boolean): DigestSettings {
  const hour = Number(raw.hour);
  const prev = String(raw.previewTo ?? '').trim();
  return {
    enabled,
    mode: raw.mode === 'live' ? 'live' : 'preview',
    recipients: ids(raw.recipients),
    previewTo: /^\d{1,10}$/.test(prev) ? prev : DIGEST_DEFAULTS.previewTo,
    hour: Number.isInteger(hour) && hour >= 6 && hour <= 14 ? hour : DIGEST_DEFAULTS.hour,
  };
}

/** installed = false — миграции 298 ещё нет (строки в bot_channels нет): настройки не сохранить, дайджест молчит. */
export async function loadDigestSettings(): Promise<DigestSettings & { installed: boolean }> {
  const r = await systemDb().query<{ enabled: boolean; config: Record<string, unknown> | null }>(
    `SELECT enabled, config FROM bot_channels WHERE key = $1`, [DIGEST_CHANNEL],
  ).catch(() => ({ rows: [] as { enabled: boolean; config: Record<string, unknown> | null }[] }));
  const row = r.rows[0];
  if (!row) return { ...DIGEST_DEFAULTS, installed: false };
  return { ...normalizeDigest(row.config ?? {}, !!row.enabled), installed: true };
}

export async function saveDigestSettings(input: Partial<DigestSettings>): Promise<DigestSettings> {
  const cur = await loadDigestSettings();
  if (!cur.installed) throw new Error('Нет строки big_brother_digest в bot_channels — накатите миграцию 298');
  const next = normalizeDigest({ ...cur, ...input }, input.enabled ?? cur.enabled);
  const { enabled, ...config } = next;
  await systemDb().query(
    `UPDATE bot_channels SET enabled = $2, config = $3::jsonb WHERE key = $1`, [DIGEST_CHANNEL, enabled, JSON.stringify(config)],
  );
  invalidateBotChannelCache();
  return next;
}

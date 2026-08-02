// Имена клиентов (контакты/компании) для «Моих заказчиков»: в sa-БД имён нет
// вообще, поэтому — ленивый кэш поверх Битрикса, тот же паттерн, что
// lib/bitrix/managerAvatar.ts (кэш в system DB, миграция 122, TTL 30 дней;
// неудача тоже штампует synced_at). Битрикс дёргается ТОЛЬКО на промахи кэша и
// в объёме текущей страницы (<= ~50 id за раз, батчем через filter[@ID]).
// ПДн: запрашиваются только NAME/LAST_NAME/SECOND_NAME (контакт) и TITLE
// (компания) — телефоны не читаются и нигде не появляются.

import { systemDb } from '@/lib/db/clients';
import { bx } from '@/lib/bitrix/notify';

const SYNC_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface BxContact { ID: string; NAME?: string; LAST_NAME?: string; SECOND_NAME?: string }
interface BxCompany { ID: string; TITLE?: string }

async function fetchFromBitrix(keys: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const webhook = process.env.BITRIX_WEBHOOK_URL || '';
  if (!webhook) return out;

  // 'x' — юр-сделка без карточки компании (company_id=0), фолбэк-ключ по
  // contact_id (задача 2776, фикс склейки «k0» — owners-inbox/
  // customers-k0-merge-issue.md). Резолвится ТЕМ ЖЕ crm.contact.list, что и
  // обычный 'c'-контакт — сущность в Bitrix одна и та же (контакт), разница
  // только в намеренно разделённом префиксе ключа (не склеивать с личной
  // B2C-историей того же человека под 'c'-ключом).
  const contactKeys = keys.filter(k => k.startsWith('c') || k.startsWith('x'));
  const companyIds = keys.filter(k => k.startsWith('k')).map(k => k.slice(1));
  const contactIds = [...new Set(contactKeys.map(k => k.slice(1)))];

  if (contactIds.length > 0) {
    try {
      const body = await bx(webhook, 'crm.contact.list', {
        filter: { '@ID': contactIds },
        select: ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME'],
      });
      for (const c of (body?.result ?? []) as BxContact[]) {
        const name = [c.LAST_NAME, c.NAME, c.SECOND_NAME].filter(Boolean).join(' ').trim();
        // Пишем под КАЖДЫМ префиксом, который реально запрашивался для этого
        // ID (обычно ровно один — оба сразу, только если у контакта есть и
        // личная B2C-история, и k0-фолбэк-сделки).
        if (keys.includes(`c${c.ID}`)) out.set(`c${c.ID}`, name || null);
        if (keys.includes(`x${c.ID}`)) out.set(`x${c.ID}`, name || null);
      }
    } catch (e) {
      console.warn('[clientNames] crm.contact.list не удался:', e instanceof Error ? e.message : e);
    }
  }
  if (companyIds.length > 0) {
    try {
      const body = await bx(webhook, 'crm.company.list', {
        filter: { '@ID': companyIds },
        select: ['ID', 'TITLE'],
      });
      for (const c of (body?.result ?? []) as BxCompany[]) {
        out.set(`k${c.ID}`, (c.TITLE ?? '').trim() || null);
      }
    } catch (e) {
      console.warn('[clientNames] crm.company.list не удался:', e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/** Имена из КЭША, без походов в Битрикс (для поиска по всему списку менеджера). */
export async function getCachedClientNames(keys: string[]): Promise<Map<string, string | null>> {
  if (keys.length === 0) return new Map();
  try {
    const res = await systemDb().query<{ client_key: string; name: string | null }>(
      'SELECT client_key, name FROM client_names WHERE client_key = ANY($1)', [keys],
    );
    return new Map(res.rows.map(r => [r.client_key, r.name]));
  } catch (e) {
    // До наката миграции 122 таблицы нет — список работает без имён.
    console.warn('[clientNames] кэш недоступен:', e instanceof Error ? e.message : e);
    return new Map();
  }
}

/** Имена для страницы списка: кэш + ленивый добор промахов из Битрикса. */
export async function resolveClientNames(keys: string[]): Promise<Map<string, string | null>> {
  if (keys.length === 0) return new Map();
  const db = systemDb();
  const out = new Map<string, string | null>();
  let stale: string[] = keys;
  try {
    const res = await db.query<{ client_key: string; name: string | null; synced_at: string }>(
      'SELECT client_key, name, synced_at FROM client_names WHERE client_key = ANY($1)', [keys],
    );
    const now = Date.now();
    const fresh = new Set<string>();
    for (const r of res.rows) {
      out.set(r.client_key, r.name);
      if (now - new Date(r.synced_at).getTime() < SYNC_TTL_MS) fresh.add(r.client_key);
    }
    stale = keys.filter(k => !fresh.has(k));
  } catch (e) {
    console.warn('[clientNames] кэш недоступен:', e instanceof Error ? e.message : e);
    return out; // без таблицы в Битрикс не ходим — нечем гасить повторные промахи
  }

  if (stale.length === 0) return out;
  const fetched = await fetchFromBitrix(stale);
  try {
    for (const key of stale) {
      // Не найден в CRM / не удалось — штампуем существующее значение (или NULL),
      // чтобы не ретраить на каждое открытие страницы до истечения TTL.
      const name = fetched.has(key) ? fetched.get(key)! : (out.get(key) ?? null);
      out.set(key, name);
      await db.query(
        `INSERT INTO client_names (client_key, name, synced_at) VALUES ($1, $2, now())
         ON CONFLICT (client_key) DO UPDATE SET name = EXCLUDED.name, synced_at = now()`,
        [key, name],
      );
    }
  } catch (e) {
    console.warn('[clientNames] запись кэша не удалась:', e instanceof Error ? e.message : e);
  }
  return out;
}

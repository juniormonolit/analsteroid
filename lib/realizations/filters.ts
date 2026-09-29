// Фильтры раздела «Реализация»: регион / логист / статус поверх выборки периода.
import { regionOf, REGIONS, type Region } from './region';
import type { ReqRow } from './metrics';

export interface RealizationFilters {
  from: string;            // YYYY-MM-DD, плановая дата отгрузки
  to: string;
  region: Region | null;
  logist: string | null;   // users_1c.id; '__none' — без логиста
  status: string | null;   // код статуса 1С или группа 'grp:shipped' | 'grp:cancelled' | 'grp:in_work'
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Дефолтный период — последние 30 дней по МСК, включая сегодня. */
export function defaultPeriod(now = new Date()): { from: string; to: string } {
  const msk = new Date(now.getTime() + 3 * 3600_000);
  const to = msk.toISOString().slice(0, 10);
  const from = new Date(msk.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

export function parseFilters(sp: URLSearchParams, now = new Date()): RealizationFilters | { error: string } {
  const def = defaultPeriod(now);
  const from = sp.get('from') || def.from;
  const to = sp.get('to') || def.to;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return { error: 'Период: даты в формате ГГГГ-ММ-ДД' };
  if (from > to) return { error: 'Период: дата начала позже даты конца' };
  if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) return { error: 'Период не длиннее года' };
  const regionRaw = sp.get('region');
  const region = (REGIONS as string[]).includes(regionRaw ?? '') ? (regionRaw as Region) : null;
  const logistRaw = sp.get('logist');
  const logist = logistRaw && (/^[0-9a-f-]{36}$/i.test(logistRaw) || logistRaw === '__none') ? logistRaw : null;
  const status = sp.get('status')?.trim() || null;
  return { from, to, region, logist, status: status && status.length <= 80 ? status : null };
}

export function matchRow(r: Pick<ReqRow, 'logist_id' | 'logist' | 'status' | 'grp'>, f: Pick<RealizationFilters, 'region' | 'logist' | 'status'>): boolean {
  if (f.region && regionOf(r.logist) !== f.region) return false;
  if (f.logist && (f.logist === '__none' ? r.logist_id !== null : r.logist_id !== f.logist)) return false;
  if (f.status) {
    if (f.status.startsWith('grp:')) { if (r.grp !== f.status.slice(4)) return false; }
    else if (r.status !== f.status) return false;
  }
  return true;
}

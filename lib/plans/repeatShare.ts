// Доля повторных продаж в плане отдела (задача владельца 23.11, миграция 284).
//
// «План по повторным продажам считается коэффициентом от общего плана, который задаётся
// на каждый отдел: МСК ОС — 40 %, план 100 → план (повт.) 40».
//
// Отдел — пара «филиал:категория» ('МСК:ОС'), тот же ключ, что у годовых планов
// отделов (plan_targets_year.scope='department') и резолвера lib/org/deptCategories.ts.
// Отдельных «планов отдела» в БД нет: план отдела = сумма планов его менеджеров
// (manager_plans). Поэтому доля применяется к плану КАЖДОГО менеджера отдела —
// сумма по отделу даёт ровно «план отдела × доля», а строки менеджеров получают свой
// план (повт.) без отдельной настройки.
//
// Доли нет → план (повт.) не считается вовсе (null/пусто), дефолт не выдумываем.

import { systemDb } from '@/lib/db/clients';
import { ANCESTOR_ANCHORS, EXACT_ANCHORS, CATEGORY_ORDER, getManagerOrgMap } from '@/lib/org/deptCategories';

export interface DeptRepeatShare {
  deptKey: string;          // 'МСК:ОС'
  branch: string;           // 'МСК'
  category: string;         // 'ОС'
  sharePct: number | null;  // 40 → 40 %; null — не задана
  updatedAt: string | null;
  updatedBy: string | null;
}

const BRANCH_ORDER = ['СПБ', 'МСК', 'КРД'];

/** Все отделы, которые умеет резолвить lib/org/deptCategories (в порядке филиал → категория). */
export function listDeptKeys(): { deptKey: string; branch: string; category: string }[] {
  const seen = new Map<string, { deptKey: string; branch: string; category: string }>();
  for (const a of [...ANCESTOR_ANCHORS, ...EXACT_ANCHORS]) {
    const deptKey = `${a.branch}:${a.category}`;
    if (!seen.has(deptKey)) seen.set(deptKey, { deptKey, branch: a.branch, category: a.category });
  }
  const rank = (arr: string[], v: string) => { const i = arr.indexOf(v); return i < 0 ? arr.length : i; };
  return [...seen.values()].sort((x, y) =>
    rank(BRANCH_ORDER, x.branch) - rank(BRANCH_ORDER, y.branch)
    || rank(CATEGORY_ORDER, x.category) - rank(CATEGORY_ORDER, y.category),
  );
}

export function isKnownDeptKey(deptKey: string): boolean {
  return listDeptKeys().some(d => d.deptKey === deptKey);
}

/** dept_key → доля в процентах. Таблица ещё не накатана → пустая карта (план (повт.) просто не считается). */
export async function loadRepeatShares(): Promise<Map<string, { pct: number; updatedAt: string; updatedBy: string | null }>> {
  const out = new Map<string, { pct: number; updatedAt: string; updatedBy: string | null }>();
  try {
    const res = await systemDb().query<{ dept_key: string; repeat_share_pct: string; updated_at: string; updated_by: string | null }>(
      `SELECT dept_key, repeat_share_pct, updated_at::text, updated_by FROM dept_repeat_plan_share`,
    );
    for (const r of res.rows) out.set(r.dept_key, { pct: Number(r.repeat_share_pct), updatedAt: r.updated_at, updatedBy: r.updated_by });
  } catch {
    /* миграция 284 ещё не накатана — долей нет */
  }
  return out;
}

export async function listDeptRepeatShares(): Promise<DeptRepeatShare[]> {
  const shares = await loadRepeatShares();
  return listDeptKeys().map(d => {
    const s = shares.get(d.deptKey);
    return { ...d, sharePct: s?.pct ?? null, updatedAt: s?.updatedAt ?? null, updatedBy: s?.updatedBy ?? null };
  });
}

/**
 * bitrix id менеджера → доля повторных (дробь 0..1) его отдела. В карте только менеджеры,
 * чей отдел резолвится и у отдела задана доля. Пустая карта, если долей нет вообще
 * (тогда оргструктуру не читаем — лишний запрос в отчёты без долей не добавляется).
 */
export async function getRepeatShareByManagerId(): Promise<Map<string, number>> {
  const shares = await loadRepeatShares();
  const out = new Map<string, number>();
  if (shares.size === 0) return out;
  const orgMap = await getManagerOrgMap();
  for (const [managerId, info] of orgMap) {
    if (!info.category) continue;
    const s = shares.get(`${info.branch}:${info.category}`);
    if (s) out.set(managerId, s.pct / 100);
  }
  return out;
}

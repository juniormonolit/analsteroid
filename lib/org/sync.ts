// Синк оргструктуры и сотрудников из Битрикса в схему sa (Мишина БД).
// Отвязывает приложение от system(YC): departments/org_resolved_hierarchy тянем
// напрямую из Битрикса в sa. Задача Серёги 13.07.
//
// Это перенос логики scripts/org-sync.mjs в приложение: та же самая (сверенная
// 1-в-1 с system) резолвинг-логика, но пишем через пул analyticsDb() (sa) и
// фетчим Битрикс через BITRIX_ORG_WEBHOOK. Вызывается:
//  - кнопкой «Синхронизировать» в настройках → POST /api/admin/org-sync;
//  - ночным cron 04:00 МСК (systemd timer + curl того же роута).
//
// Резолвер: manager_name = ФИО | 'User '+id; short_login = /^manager(\d+)$/i → '#'+d
// иначе LOGIN; department по UF_DEPARTMENT[0]; branch по дереву (москва/краснодар/
// екатеринбург иначе СПб); rop = ближайший предок с UF_HEAD, кроме Дирекции(1) и
// владельца(6). Смена имени → sa.employee_name_history (SCD2).

import type { PoolClient } from 'pg';
import { analyticsDb } from '@/lib/db/clients';

const OWNER_UID = '6';          // владелец — не РОП
const DIRECTORATE_DEPT = '1';   // Дирекция — выше неё rop не поднимаем

interface BxDept { ID: string | number; NAME: string; PARENT?: string | number; UF_HEAD?: string | number }
interface BxManager {
  ID: string | number; NAME?: string; LAST_NAME?: string; LOGIN?: string;
  ACTIVE?: string | boolean; UF_DEPARTMENT?: (string | number)[]; WORK_POSITION?: string;
}

export interface OrgSyncResult { ok: true; departments: number; managers: number; backfilledHeads: number; renamed: number; ms: number }

function webhookBase(): string {
  const bx = process.env.BITRIX_ORG_WEBHOOK;
  if (!bx) throw new Error('BITRIX_ORG_WEBHOOK не задан');
  return bx.replace(/\/+$/, '');
}

async function bxCall(method: string, params: Record<string, string> = {}): Promise<{ result?: unknown; next?: number; error?: string; error_description?: string }> {
  const qs = new URLSearchParams(params).toString();
  const url = `${webhookBase()}/${method}.json${qs ? `?${qs}` : ''}`;
  const r = await fetch(url);
  return r.json();
}

/** department.get с пагинацией по 50. */
async function bxAll(method: string): Promise<BxDept[]> {
  let out: BxDept[] = [];
  let start = 0;
  for (;;) {
    const d = await bxCall(method, { start: String(start) });
    if (d.error) throw new Error(`${method}: ${d.error_description ?? d.error}`);
    out = out.concat((d.result as BxDept[]) ?? []);
    if (d.next === undefined || d.next === null) break;
    start = d.next;
  }
  return out;
}

/**
 * user.get?ID=<id> → одна запись в форме BxManager (или null, если пусто).
 * Нужен для добора глав отделов, которых mlt.managers.list не возвращает
 * (владельцы/системные исключены из выгрузки, но остаются главами по UF_HEAD).
 */
async function bxUser(id: string): Promise<BxManager | null> {
  const d = await bxCall('user.get', { ID: id });
  if (d.error) throw new Error(`user.get ID=${id}: ${d.error_description ?? d.error}`);
  const arr = (d.result as Record<string, unknown>[]) ?? [];
  const u = arr[0];
  if (!u) return null;
  const dept = u.UF_DEPARTMENT;
  return {
    ID: u.ID as string | number,
    NAME: u.NAME as string | undefined,
    LAST_NAME: u.LAST_NAME as string | undefined,
    LOGIN: u.LOGIN as string | undefined,
    ACTIVE: u.ACTIVE as string | boolean | undefined,
    UF_DEPARTMENT: Array.isArray(dept) ? (dept as (string | number)[]) : (dept != null ? [dept as string | number] : undefined),
    WORK_POSITION: u.WORK_POSITION as string | undefined,
  };
}

const shortLogin = (l?: string): string | null => {
  const m = /^manager(\d+)$/i.exec(l ?? '');
  return m ? '#' + m[1] : (l || null);
};
const managerName = (m: BxManager): string => {
  const fio = ((m.NAME ?? '') + ' ' + (m.LAST_NAME ?? '')).trim();
  return fio || ('User ' + m.ID);
};
const branchOf = (chain: BxDept[]): string => {
  for (const d of chain) {
    if (/москва|московск/i.test(d.NAME)) return 'Москва/МО';
    if (/краснодар/i.test(d.NAME)) return 'Краснодар';
    if (/екатеринбург/i.test(d.NAME)) return 'Екатеринбург';
  }
  return 'СПб';
};
const ropOf = (chain: BxDept[], self: string): string | null => {
  for (const d of chain) {
    if (String(d.ID) === DIRECTORATE_DEPT) break;
    const h = d.UF_HEAD ? String(d.UF_HEAD) : '';
    if (h && h !== '0' && h !== OWNER_UID && h !== String(self)) return h;
  }
  return null;
};

/**
 * Полный прогон синка. Идемпотентен (upsert по естественным ключам, uuid отделов
 * стабилен по bitrix_department_id). Пишет в транзакции.
 */
export async function runOrgSync(): Promise<OrgSyncResult> {
  const t0 = Date.now();
  const pool = analyticsDb();
  const client: PoolClient = await pool.connect();
  try {
    // 1. Битрикс
    const bxdep = await bxAll('department.get');
    const mgrRes = await bxCall('mlt.managers.list');
    if (mgrRes.error) throw new Error(`mlt.managers.list: ${mgrRes.error_description ?? mgrRes.error}`);
    const mgr = (mgrRes.result as BxManager[]) ?? [];

    // 1b. Добор глав отделов, отсутствующих в mlt.managers.list.
    // Кейс: глава отдела (UF_HEAD в дереве) исключён из выгрузки как владелец/системный
    // (напр. Bitrix ID 6 — Авдейчик, глава отдела 34 «МСК НЦ»). Без него отдел теряет
    // главу и в sa.org_resolved_hierarchy для него не появляется строка. Добираем
    // отдельными user.get и вливаем в mgr ПЕРЕД циклом резолва (дедуп по ID).
    const mgrIds = new Set(mgr.map(m => String(m.ID)));
    const headIds = new Set<string>();
    for (const d of bxdep) {
      const h = d.UF_HEAD ? String(d.UF_HEAD) : '';
      if (h && h !== '0') headIds.add(h);
    }
    const missingHeads = [...headIds].filter(id => !mgrIds.has(id));
    let backfilledHeads = 0;
    for (const id of missingHeads) {
      try {
        const u = await bxUser(id);
        if (!u) { console.warn(`[org-sync] глава ${id}: user.get вернул пусто — пропуск`); continue; }
        if (mgrIds.has(String(u.ID))) continue; // дедуп (на всякий случай)
        mgr.push(u);
        mgrIds.add(String(u.ID));
        backfilledHeads++;
      } catch (e) {
        console.warn(`[org-sync] глава ${id}: user.get ошибка — пропуск:`, e instanceof Error ? e.message : e);
      }
    }

    const bxById = new Map(bxdep.map(d => [String(d.ID), d]));
    const chainOf = (id: string | number): BxDept[] => {
      const out: BxDept[] = [];
      let cur = bxById.get(String(id));
      let g = 0;
      while (cur && g++ < 20) { out.push(cur); cur = cur.PARENT ? bxById.get(String(cur.PARENT)) : undefined; }
      return out;
    };

    // ручные оверрайды филиала (менеджеры на удалённых/неоднозначных отделах) + карта филиалов
    const brOverride = new Map(
      (await client.query<{ bitrix_user_id: string; branch: string }>('SELECT bitrix_user_id, branch FROM sa.manager_branch_override')).rows
        .map(r => [String(r.bitrix_user_id), r.branch]),
    );
    const branchToCode = new Map(
      (await client.query<{ raw_label: string; code: string }>('SELECT raw_label, code FROM sa.branches')).rows
        .map(r => [r.raw_label, r.code]),
    );

    await client.query('BEGIN');

    // 2. departments upsert (uuid стабилен по bitrix_department_id)
    for (const d of bxdep) {
      await client.query(
        `INSERT INTO sa.departments(bitrix_department_id,name,parent_bitrix_department_id,head_bitrix_user_id,is_active,updated_at)
         VALUES($1,$2,$3,$4,true,now())
         ON CONFLICT (bitrix_department_id) DO UPDATE SET name=EXCLUDED.name,
           parent_bitrix_department_id=EXCLUDED.parent_bitrix_department_id,
           head_bitrix_user_id=EXCLUDED.head_bitrix_user_id, is_active=true, updated_at=now()`,
        [String(d.ID), d.NAME, d.PARENT ? String(d.PARENT) : null, d.UF_HEAD ? String(d.UF_HEAD) : null],
      );
    }
    // отделы, пропавшие из Битрикса → is_active=false
    const liveIds = bxdep.map(d => String(d.ID));
    await client.query('UPDATE sa.departments SET is_active=false, updated_at=now() WHERE NOT (bitrix_department_id = ANY($1))', [liveIds]);
    const depIdByBx = new Map(
      (await client.query<{ id: string; bitrix_department_id: string }>('SELECT id, bitrix_department_id FROM sa.departments')).rows
        .map(r => [String(r.bitrix_department_id), r.id]),
    );

    // 3. org_resolved_hierarchy + детект смены имени
    const now = new Date();
    let renamed = 0;
    const seen: string[] = [];
    for (const m of mgr) {
      const uid = String(m.ID);
      const name = managerName(m);
      const ufDept = Array.isArray(m.UF_DEPARTMENT) && m.UF_DEPARTMENT.length ? String(m.UF_DEPARTMENT[0]) : null;
      const chain = ufDept ? chainOf(ufDept) : [];
      // Оверрайд > дерево > дефолт 'СПб' (как в system/deptCategories для нерезолвимых).
      const branch = brOverride.get(uid) || (chain.length ? branchOf(chain) : 'СПб');
      const departmentId = ufDept ? (depIdByBx.get(ufDept) ?? null) : null;
      const departmentName = ufDept && bxById.get(ufDept) ? bxById.get(ufDept)!.NAME : null;
      const ropId = chain.length ? ropOf(chain, uid) : null;
      const ropM = ropId ? mgr.find(x => String(x.ID) === ropId) : null;
      const ropName = ropM ? managerName(ropM) : null;
      const resolvedPath = JSON.stringify(chain.map(d => ({ id: d.ID, name: d.NAME })));
      const isActive = m.ACTIVE === 'Y' || m.ACTIVE === true;
      const login = shortLogin(m.LOGIN);
      const branchCode = branch ? (branchToCode.get(branch) ?? null) : null;

      // смена имени (SCD2)
      const cur = await client.query<{ name: string }>(
        'SELECT name FROM sa.employee_name_history WHERE bitrix_user_id=$1 AND valid_to IS NULL', [uid],
      );
      if (cur.rows.length === 0) {
        await client.query('INSERT INTO sa.employee_name_history(bitrix_user_id,name,valid_from) VALUES($1,$2,$3)', [uid, name, now]);
      } else if (cur.rows[0].name !== name) {
        await client.query('UPDATE sa.employee_name_history SET valid_to=$1 WHERE bitrix_user_id=$2 AND valid_to IS NULL', [now, uid]);
        await client.query('INSERT INTO sa.employee_name_history(bitrix_user_id,name,valid_from) VALUES($1,$2,$3)', [uid, name, now]);
        renamed++;
      }

      await client.query(
        `INSERT INTO sa.org_resolved_hierarchy(manager_bitrix_user_id,manager_name,department_id,department_name,
           rop_bitrix_user_id,rop_name,resolved_path,is_active,resolved_at,source_snapshot_at,short_login,branch,branch_code)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12)
         ON CONFLICT (manager_bitrix_user_id) DO UPDATE SET manager_name=EXCLUDED.manager_name,
           department_id=EXCLUDED.department_id, department_name=EXCLUDED.department_name,
           rop_bitrix_user_id=EXCLUDED.rop_bitrix_user_id, rop_name=EXCLUDED.rop_name,
           resolved_path=EXCLUDED.resolved_path, is_active=EXCLUDED.is_active, resolved_at=EXCLUDED.resolved_at,
           source_snapshot_at=EXCLUDED.source_snapshot_at, short_login=EXCLUDED.short_login,
           branch=EXCLUDED.branch, branch_code=EXCLUDED.branch_code`,
        [uid, name, departmentId, departmentName, ropId, ropName, resolvedPath, isActive, now, login, branch, branchCode],
      );
      seen.push(uid);
    }
    // менеджеры, пропавшие из выгрузки → is_active=false
    await client.query('UPDATE sa.org_resolved_hierarchy SET is_active=false WHERE NOT (manager_bitrix_user_id = ANY($1))', [seen]);

    await client.query('COMMIT');
    return { ok: true, departments: bxdep.length, managers: mgr.length, backfilledHeads, renamed, ms: Date.now() - t0 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Синк оргструктуры и сотрудников из Битрикса в схему sa (Мишина БД).
// Отвязывает приложение от system(YC): раньше departments/org_resolved_hierarchy
// синкались в system, теперь тянем напрямую из Битрикса в sa. Задача Серёги 13.07.
//
// Запуск: node scripts/org-sync.mjs   (env: SA_PG_* с правом записи на sa.*,
// BITRIX_ORG_WEBHOOK=https://td.monolit-crm.ru/rest/<id>/<key>)
// Дёргается ночным cron 04:00 МСК и кнопкой «Синхронизировать» в настройках.
//
// Резолвер восстановлен 1-в-1 по текущему system.org_resolved_hierarchy
// (см. project_analsteroid_org_sync): manager_name=ФИО|'User '+id;
// short_login=/^manager(\d+)$/i→'#'+d иначе LOGIN; department по UF_DEPARTMENT[0];
// branch по дереву (москва/краснодар/екатеринбург иначе СПб); rop=ближайший
// предок с UF_HEAD, кроме Дирекции(1) и владельца(6). Смена имени → history.

import pg from 'pg';
import fs from 'fs';
import https from 'https';

const BX = process.env.BITRIX_ORG_WEBHOOK;
if (!BX) { console.error('BITRIX_ORG_WEBHOOK не задан'); process.exit(1); }

const OWNER_UID = '6';          // владелец — не РОП
const DIRECTORATE_DEPT = '1';   // Дирекция — выше неё rop не поднимаем

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
async function bxAll(method) {          // department.get с пагинацией по 50
  let out = [], start = 0;
  for (;;) {
    const d = await get(`${BX}/${method}.json?start=${start}`);
    if (d.error) throw new Error(`${method}: ${d.error_description}`);
    out = out.concat(d.result || []);
    if (d.next === undefined || d.next === null) break;
    start = d.next;
  }
  return out;
}

const shortLogin = l => { const m = /^manager(\d+)$/i.exec(l || ''); return m ? '#' + m[1] : (l || null); };
const managerName = m => { const fio = ((m.NAME || '') + ' ' + (m.LAST_NAME || '')).trim(); return fio || ('User ' + m.ID); };
const branchOf = chain => {
  for (const d of chain) {
    if (/москва|московск/i.test(d.NAME)) return 'Москва/МО';
    if (/краснодар/i.test(d.NAME)) return 'Краснодар';
    if (/екатеринбург/i.test(d.NAME)) return 'Екатеринбург';
  }
  return 'СПб';
};
const ropOf = (chain, self) => {
  for (const d of chain) {
    if (String(d.ID) === DIRECTORATE_DEPT) break;
    const h = d.UF_HEAD ? String(d.UF_HEAD) : '';
    if (h && h !== '0' && h !== OWNER_UID && h !== String(self)) return h;
  }
  return null;
};

async function main() {
  const client = new pg.Client({
    host: process.env.SA_PG_HOST, port: +process.env.SA_PG_PORT, user: process.env.SA_PG_USER,
    password: process.env.SA_PG_PASSWORD, database: process.env.SA_PG_DATABASE || 'postgres', ssl: false,
  });
  await client.connect();
  const t0 = Date.now();

  // 1. Битрикс
  const bxdep = await bxAll('department.get');
  const mgrRes = await get(`${BX}/mlt.managers.list.json`);
  if (mgrRes.error) throw new Error(`mlt.managers.list: ${mgrRes.error_description}`);
  const mgr = mgrRes.result || [];
  const bxById = new Map(bxdep.map(d => [String(d.ID), d]));
  const chainOf = id => { const out = []; let cur = bxById.get(String(id)); let g = 0; while (cur && g++ < 20) { out.push(cur); cur = cur.PARENT ? bxById.get(String(cur.PARENT)) : null; } return out; };

  // ручные оверрайды филиала для менеджеров на удалённых/неоднозначных отделах
  const brOverride = new Map((await client.query('SELECT bitrix_user_id, branch FROM sa.manager_branch_override')).rows.map(r => [String(r.bitrix_user_id), r.branch]));
  const branchToCode = new Map((await client.query('SELECT raw_label, code FROM sa.branches')).rows.map(r => [r.raw_label, r.code]));

  await client.query('BEGIN');

  // 2. departments upsert (uuid стабилен по bitrix_department_id)
  for (const d of bxdep) {
    await client.query(
      `INSERT INTO sa.departments(bitrix_department_id,name,parent_bitrix_department_id,head_bitrix_user_id,is_active,updated_at)
       VALUES($1,$2,$3,$4,true,now())
       ON CONFLICT (bitrix_department_id) DO UPDATE SET name=EXCLUDED.name,
         parent_bitrix_department_id=EXCLUDED.parent_bitrix_department_id,
         head_bitrix_user_id=EXCLUDED.head_bitrix_user_id, is_active=true, updated_at=now()`,
      [String(d.ID), d.NAME, d.PARENT ? String(d.PARENT) : null, d.UF_HEAD ? String(d.UF_HEAD) : null]);
  }
  // отделы, пропавшие из Битрикса → is_active=false
  const liveIds = bxdep.map(d => String(d.ID));
  await client.query(`UPDATE sa.departments SET is_active=false, updated_at=now() WHERE NOT (bitrix_department_id = ANY($1))`, [liveIds]);
  const depIdByBx = new Map((await client.query('SELECT id, bitrix_department_id FROM sa.departments')).rows.map(r => [String(r.bitrix_department_id), r.id]));

  // 3. org_resolved_hierarchy + детект смены имени
  const now = new Date();
  let renamed = 0;
  const seen = [];
  for (const m of mgr) {
    const uid = String(m.ID);
    const name = managerName(m);
    const ufDept = Array.isArray(m.UF_DEPARTMENT) && m.UF_DEPARTMENT.length ? String(m.UF_DEPARTMENT[0]) : null;
    const chain = ufDept ? chainOf(ufDept) : [];
    // Оверрайд > дерево > дефолт 'СПб' (как в system/deptCategories для нерезолвимых).
    const branch = brOverride.get(uid) || (chain.length ? branchOf(chain) : 'СПб');
    const orh = {
      manager_bitrix_user_id: uid, manager_name: name,
      department_id: ufDept ? (depIdByBx.get(ufDept) || null) : null,
      department_name: ufDept && bxById.get(ufDept) ? bxById.get(ufDept).NAME : null,
      rop_bitrix_user_id: chain.length ? ropOf(chain, uid) : null,
      resolved_path: JSON.stringify(chain.map(d => ({ id: d.ID, name: d.NAME }))),
      is_active: m.ACTIVE === 'Y' || m.ACTIVE === true,
      short_login: shortLogin(m.LOGIN), branch, branch_code: branch ? (branchToCode.get(branch) || null) : null,
    };
    // rop_name из карты менеджеров
    const ropM = orh.rop_bitrix_user_id ? mgr.find(x => String(x.ID) === orh.rop_bitrix_user_id) : null;
    orh.rop_name = ropM ? managerName(ropM) : null;

    // смена имени
    const cur = await client.query('SELECT name FROM sa.employee_name_history WHERE bitrix_user_id=$1 AND valid_to IS NULL', [uid]);
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
      [uid, orh.manager_name, orh.department_id, orh.department_name, orh.rop_bitrix_user_id, orh.rop_name,
       orh.resolved_path, orh.is_active, now, orh.short_login, orh.branch, orh.branch_code]);
    seen.push(uid);
  }
  // менеджеры, пропавшие из выгрузки → is_active=false
  await client.query(`UPDATE sa.org_resolved_hierarchy SET is_active=false WHERE NOT (manager_bitrix_user_id = ANY($1))`, [seen]);

  await client.query('COMMIT');
  console.log(JSON.stringify({ ok: true, departments: bxdep.length, managers: mgr.length, renamed, ms: Date.now() - t0 }));
  await client.end();
}
main().catch(e => { console.error('SYNC FAILED:', e.message); process.exit(1); });

/**
 * Сверка TS-порта «Ответов на запросы» (lib/supplyPanel) с эталоном Python (Панель снабжения): побитово.
 *   SUPPLY_PANEL_SOURCE=sqlite:<panel.db> SUPPLY_PANEL_REF=<каталог эталона> npm run verify:supply-panel
 * Каталог эталона: facts.json, deals.json (calc.py / domcalc.py по тому же panel.db), cases.json и expected.json
 * (дамп metrics.py — scratchpad/supply/scripts/gen_ref.py <panel.db> <каталог эталона>; «сейчас» для «Без ответа» зафиксировано в cases.json). Сравниваются facts, deals и все срезы/списки/деревья.
 * Код выхода 1 при любом расхождении. Ничего не пишет в БД и не ходит по сети (источник — только sqlite).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot, loadSnapshot, saveSnapshot } from '../lib/supplyPanel/snapshot.ts';
import { ts } from '../lib/supplyPanel/calc.ts';
import { aggregate, domDealsList, domTree, goodsTasks, goodsTree, listTasks, parseDt } from '../lib/supplyPanel/metrics.ts';
import type { Filter } from '../lib/supplyPanel/metrics.ts';

const source = process.env.SUPPLY_PANEL_SOURCE || '';
const refDir = process.env.SUPPLY_PANEL_REF || '';
if (!source.startsWith('sqlite:') || !refDir) {
  console.error('Нужны SUPPLY_PANEL_SOURCE=sqlite:<panel.db> и SUPPLY_PANEL_REF=<каталог с facts.json, deals.json, cases.json, expected.json>');
  process.exit(2);
}
const readJson = (name: string) => JSON.parse(readFileSync(path.join(refDir, name), 'utf8'));

let checks = 0, failures = 0;
const MAX_SHOWN = 8;

function diff(a: unknown, b: unknown, at: string, out: string[]): void {
  if (out.length >= MAX_SHOWN) return;
  if (a === b) return;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    out.push(`${at}: ts=${JSON.stringify(a)} py=${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${at}: разные типы (массив/объект)`); return; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${at}: длина ts=${a.length} py=${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < MAX_SHOWN; i++) diff(a[i], b[i], `${at}[${i}]`, out);
    return;
  }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  for (const k of Object.keys(x)) {
    if (!(k in y)) out.push(`${at}.${k}: есть только в ts`);
    else diff(x[k], y[k], `${at}.${k}`, out);
  }
  for (const k of Object.keys(y)) if (!(k in x)) out.push(`${at}.${k}: есть только в py`);
}

function check(label: string, ts: unknown, py: unknown): void {
  checks++;
  const out: string[] = [];
  diff(JSON.parse(JSON.stringify(ts)), py, label, out);
  if (out.length) {
    failures++;
    console.error(`FAIL ${label}`);
    for (const l of out) console.error(`   ${l}`);
  }
}

const norm = (f: Record<string, unknown> | undefined): Filter => {
  const r: Filter = { ...(f as Filter) };
  return r;
};
type Per = [string, string];
const dt = (p: Per) => [parseDt(p[0]), parseDt(p[1])] as const;

async function main() {
  const t0 = Date.now();
  const snap = await buildSnapshot();
  const buildMs = Date.now() - t0;
  console.log(`buildSnapshot: ${(buildMs / 1000).toFixed(1)} с, задач ${snap.facts.tasks.length}, сделок ${snap.deals.deals.length}`);

  const facts = readJson('facts.json'), deals = readJson('deals.json');
  const { built_at: _b1, ...factsTs } = snap.facts as unknown as Record<string, unknown>;
  const { built_at: _b2, ...factsPy } = facts;
  void _b1; void _b2;
  // facts по частям: так расхождение сразу видно по разделу
  for (const k of Object.keys({ ...factsPy, ...factsTs })) check(`facts.${k}`, factsTs[k], factsPy[k]);
  const { built_at: _d1, ...dealsTs } = snap.deals as unknown as Record<string, unknown>;
  const { built_at: _d2, ...dealsPy } = deals;
  void _d1; void _d2;
  for (const k of Object.keys({ ...dealsPy, ...dealsTs })) check(`deals.${k}`, dealsTs[k], dealsPy[k]);

  const cases = readJson('cases.json'), exp = readJson('expected.json');
  snap.deals.built_at = deals.built_at; // dom_tree отдаёт built_at из deals.json — время сборки не сравниваем
  const now = ts(cases.now)!; // «сейчас» эталона: от него считается ожидание запросов без ответа
  const t1 = Date.now();
  for (const c of cases.agg) check(`aggregate ${c.id}`, aggregate(snap.facts, ...dt(c.period), norm(c.filter), now), exp.agg[c.id]);
  for (const c of cases.list) check(`list_tasks ${c.id}`, listTasks(snap.facts, ...dt(c.period), c.metric, norm(c.filter), now), exp.list[c.id]);
  for (const c of cases.goods) check(`goods_tree ${c.id}`, goodsTree(snap.facts, ...dt(c.period), norm(c.filter)), exp.goods[c.id]);
  for (const c of cases.goods_tasks) check(`goods_tasks ${c.id}`, [...goodsTasks(snap.facts, c.path)].sort((a, b) => a - b), exp.goods_tasks[c.id]);
  for (const c of cases.dom) check(`dom_tree ${c.id}`, domTree(snap.deals, ...dt(c.period), c.region), exp.dom[c.id]);
  for (const c of cases.dom_deals) check(`dom_deals ${c.id}`, domDealsList(snap.deals, ...dt(c.period), c.node, c.kind, c.region), exp.dom_deals[c.id]);
  console.log(`метрики: ${checks} проверок, ${((Date.now() - t1) / 1000).toFixed(1)} с`);

  // справочно: те же цифры печатает report.py за сентябрь (на зеркале 14.10 — 5942 / 9440 / 4.01 / 773 / 19.3;
  // цифры 5951 / 9447 / 781 / 19.4 — с боевых данных на момент ТЗ, зеркало с тех пор изменилось). Эталон — expected.json.
  const sep = aggregate(snap.facts, parseDt('2026-09-01'), parseDt('2026-10-01')).total;
  console.log(`сентябрь: новых ${sep.new}, ответов ${sep.answers}, первый ответ ${sep.answer_h} раб. ч, продаж ${sep.sales}, конверсия ${sep.conversion_pct} %`);

  // сохранение и чтение снимка (gzip, атомарно)
  const dir = mkdtempSync(path.join(os.tmpdir(), 'supply-panel-verify-'));
  process.env.SUPPLY_PANEL_DIR = dir;
  try {
    const t2 = Date.now();
    const { bytes } = await saveSnapshot(snap);
    const back = await loadSnapshot();
    console.log(`gzip-снимок: ${(bytes / 1048576).toFixed(2)} МБ, запись ${Date.now() - t2} мс`);
    check('снимок: запись → чтение', back, JSON.parse(JSON.stringify(snap)));
    checks++;
    if ((await loadSnapshot()) !== back) { failures++; console.error('FAIL кэш loadSnapshot не сработал'); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures ? `\nРАСХОЖДЕНИЙ: ${failures} из ${checks}` : `\nOK: ${checks} проверок, 0 расхождений`);
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

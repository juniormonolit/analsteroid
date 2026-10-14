/**
 * Снимок данных раздела «Ответы на запросы» (Панель снабжения): источник → calc + domcalc → gzip JSON на диске.
 * Каталог — env SUPPLY_PANEL_DIR (по умолчанию <tmp>/supply-panel), файл snapshot.json.gz, запись атомарная.
 * Персональные данные (title задач) в логи не пишем.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { buildDeals, buildFacts, nowMsk } from './calc';
import type { DealsData, Facts } from './calc';
import { loadTables, openSource } from './source';
import type { Source, Tables } from './source';

const gzipP = promisify(gzip);
const gunzipP = promisify(gunzip);

/** Названия статусов задач (app.py STATUS). */
export const STATUS: Record<number, string> = { 1: 'Новая', 2: 'Новые', 3: 'Выполняются', 4: 'Сделаны', 5: 'Завершены', 6: 'Отложена', 7: 'Отклонена' };

/**
 * Что app.py подмешивает в списки задач из БД: только для задач facts (по ним строятся списки).
 *  tasks[task_id] = [title, status, stage_id, created_by]; stages[stage_id] = название стадии;
 *  amounts[deal_id] = сумма сделки (таблица deals, как есть); portal — хост Bitrix24 для ссылок.
 */
export interface TaskInfo {
  portal: string;
  tasks: Record<string, [string | null, number | null, number | null, number | null]>;
  stages: Record<string, string | null>;
  amounts: Record<string, number | null>;
}

export interface Snapshot {
  builtAt: string;
  pulledAt: string | null;
  catalogAt: string | null;
  facts: Facts;
  deals: DealsData;
  taskInfo: TaskInfo;
}

export const DEFAULT_PORTAL = 'td.monolit-crm.ru';

export function buildTaskInfo(t: Tables, facts: Facts): TaskInfo {
  const ids = new Set(facts.tasks.map(x => x.id));
  const tasks: TaskInfo['tasks'] = {};
  for (const r of t.tasks) {
    if (ids.has(r.task_id as number)) tasks[String(r.task_id)] = [r.title as string | null, r.status as number | null, r.stage_id as number | null, r.created_by as number | null];
  }
  const dealIds = new Set<number>();
  for (const x of facts.tasks) if (x.deal) dealIds.add(x.deal);
  const amounts: TaskInfo['amounts'] = {};
  for (const r of t.deals) if (dealIds.has(r.deal_id as number)) amounts[String(r.deal_id)] = r.amount as number | null;
  const stages: TaskInfo['stages'] = {};
  for (const r of t.stages) stages[String(r.stage_id)] = r.title as string | null;
  return { portal: process.env.SUPPLY_PANEL_PORTAL || DEFAULT_PORTAL, tasks, stages, amounts };
}

/** Собирает снимок из источника (SUPPLY_PANEL_SOURCE). Ничего не пишет на диск. */
export async function buildSnapshot(src: Source = openSource()): Promise<Snapshot> {
  const tables = await loadTables(src);
  const now = new Date();
  const facts = buildFacts(tables, now);
  const deals = buildDeals(tables, now);
  return {
    builtAt: nowMsk(now), pulledAt: facts.pulled_at, catalogAt: facts.catalog_at,
    facts, deals, taskInfo: buildTaskInfo(tables, facts),
  };
}

export function snapshotDir(): string {
  return process.env.SUPPLY_PANEL_DIR || path.join(os.tmpdir(), 'supply-panel');
}
export const snapshotFile = (): string => path.join(snapshotDir(), 'snapshot.json.gz');

/** gzip JSON → <dir>/snapshot.json.gz атомарно (tmp + rename). Возвращает путь и размер файла. */
export async function saveSnapshot(snap: Snapshot): Promise<{ file: string; bytes: number }> {
  const dir = snapshotDir();
  await fs.mkdir(dir, { recursive: true });
  const file = snapshotFile();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const buf = await gzipP(Buffer.from(JSON.stringify(snap), 'utf8'));
  try {
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return { file, bytes: buf.length };
}

interface Cached { file: string; mtimeMs: number; snap: Snapshot }
const g = globalThis as unknown as { __supplyPanelSnapshot?: Cached };

/** Читает снимок с диска; кэш в globalThis, пока не изменился mtime файла. null — снимка ещё нет. */
export async function loadSnapshot(): Promise<Snapshot | null> {
  const file = snapshotFile();
  let st;
  try { st = await fs.stat(file); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const c = g.__supplyPanelSnapshot;
  if (c && c.file === file && c.mtimeMs === st.mtimeMs) return c.snap;
  const snap = JSON.parse((await gunzipP(await fs.readFile(file))).toString('utf8')) as Snapshot;
  g.__supplyPanelSnapshot = { file, mtimeMs: st.mtimeMs, snap };
  return snap;
}

/** Собрать и сохранить; в лог — только счётчики. */
export async function refreshSnapshot(): Promise<{ builtAt: string; tasks: number; bytes: number; ms: number }> {
  const t0 = Date.now();
  const snap = await buildSnapshot();
  const { bytes } = await saveSnapshot(snap);
  g.__supplyPanelSnapshot = undefined;
  return { builtAt: snap.builtAt, tasks: snap.facts.tasks.length, bytes, ms: Date.now() - t0 };
}

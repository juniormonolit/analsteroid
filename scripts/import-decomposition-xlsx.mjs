// Импорт файла «2026 Декомпозиция (Основная).xlsx» → features/decomposition/data/decomposition-<год>.json
// для раздела «ССП тест» (план/факт по листам отделов, товарным группам и менеджерам).
//   node scripts/import-decomposition-xlsx.mjs "/path/2026 Декомпозиция (Основная).xlsx" [2026]
//
// Листы отделов («СПБ (ОС)», «МСК (НЦ ЖБИ)», …) — 18 блоков показателей, в каждом строки
// товарных групп + строка-итог блока; первые 8 блоков имеют ещё разбивку
// «Первичные продажи» / «Повторные продажи» (по 12 месяцев после пропуска-колонки).
// Раскладка колонок у листов разная (КРД (ОС) начинается с колонки A, у ЖБИ-листов
// вставлены лишние колонки) — поэтому ничего не захардкожено: месяцы ищем по
// строке с «Январь», колонку меток — по строке «Сумма отгрузок», годовую сумму —
// как ячейку между меткой и январём, ближайшую к сумме месяцев.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const [, , filePath, yearArg] = process.argv;
if (!filePath) { console.error('usage: import-decomposition-xlsx.mjs <file.xlsx> [year]'); process.exit(1); }
const year = Number(yearArg ?? 2026);

// Блоки — в порядке листа; kind: sum — суммируемые (план к дате = сумма месяцев),
// ratio — отношения/средние (план к дате = среднее по прошедшим месяцам).
export const BLOCKS = [
  { key: 'ship_sum',        label: 'Сумма отгрузок',                    kind: 'sum',   unit: 'money' },
  { key: 'sales_sum',       label: 'Сумма продаж',                      kind: 'sum',   unit: 'money' },
  { key: 'avg_check',       label: 'Средний чек (продажи и отгрузки)',   kind: 'ratio', unit: 'money' },
  { key: 'ship_cnt',        label: 'Кол-во отгрузок',                   kind: 'sum',   unit: 'count' },
  { key: 'sales_cnt',       label: 'Кол-во продаж',                     kind: 'sum',   unit: 'count' },
  { key: 'sales_per_day',   label: 'Кол-во продаж/день',                kind: 'ratio', unit: 'count1' },
  { key: 'lost_cnt',        label: 'Кол-во отказов',                    kind: 'sum',   unit: 'count' },
  { key: 'deals_cnt',       label: 'Кол-во сделок (первичных)',         kind: 'sum',   unit: 'count' },
  { key: 'deals_per_day',   label: 'Кол-во сделок / день (первичных)',  kind: 'ratio', unit: 'count1' },
  { key: 'mops',            label: 'Кол-во МОПов',                      kind: 'ratio', unit: 'count1' },
  { key: 'leads',           label: 'Кол-во лидов / звонков',            kind: 'sum',   unit: 'count' },
  { key: 'leads_per_day',   label: 'Кол-во лидов / звонков (день)',     kind: 'ratio', unit: 'count1' },
  { key: 'site_visits',     label: 'Кол-во заходов / переходов на сайт', kind: 'sum',   unit: 'count' },
  { key: 'cv_deal_sale',    label: 'Конверсия сделка/продажа',          kind: 'ratio', unit: 'pct' },
  { key: 'cv_sale_ship',    label: 'Конверсия продажа/отгрузка',        kind: 'ratio', unit: 'pct' },
  { key: 'cv_deal_ship',    label: 'Конверсия сделка/отгрузка',         kind: 'ratio', unit: 'pct' },
  { key: 'cv_ship_closed',  label: 'Верная конверсия сделка/отгрузка',  kind: 'ratio', unit: 'pct' },
  { key: 'churn_pct',       label: '% слета',                           kind: 'ratio', unit: 'pct' },
];
const BLOCK_BY_LABEL = new Map(BLOCKS.map(b => [b.label, b]));

const wb = XLSX.readFile(filePath);
const sheetRows = name => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, blankrows: false, defval: null });
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const take12 = (row, from) => Array.from({ length: 12 }, (_, i) => num(row[from + i]) ?? 0);
const isMonthHeader = row => row.some(v => v === 'Январь');

function parseDeptSheet(name) {
  const rows = sheetRows(name);
  const header = rows.find(isMonthHeader);
  if (!header) throw new Error(`${name}: нет строки месяцев`);
  const janCols = header.map((v, i) => (v === 'Январь' ? i : -1)).filter(i => i >= 0);
  const [mCol, pCol, rCol] = janCols; // все / первичные / повторные
  const firstBlockRow = rows.find(r => r.includes('Сумма отгрузок'));
  if (!firstBlockRow) throw new Error(`${name}: нет блока «Сумма отгрузок»`);
  const labelCol = firstBlockRow.indexOf('Сумма отгрузок');
  const wdRow = rows.find(r => r.includes('Рабочие дни'));
  const workingDays = wdRow ? take12(wdRow, mCol) : null;

  // Годовая ячейка: среди ячеек между меткой и январём — ближайшая к сумме месяцев
  // (для ratio-блоков — первая числовая после метки).
  const yearOf = (row, months, kind) => {
    const cands = [];
    for (let c = labelCol + 1; c < mCol; c++) { const v = num(row[c]); if (v !== null) cands.push(v); }
    if (!cands.length) return null;
    if (kind !== 'sum') return cands[0];
    const s = months.reduce((a, b) => a + b, 0);
    return cands.reduce((best, v) => (Math.abs(v - s) < Math.abs(best - s) ? v : best), cands[0]);
  };

  const blocks = [];
  let cur = null;
  for (const row of rows) {
    const label = row[labelCol];
    if (typeof label !== 'string') continue;
    const def = BLOCK_BY_LABEL.get(label.trim());
    if (def) {
      const hasSplit = row.length > mCol + 13 && pCol !== undefined && num(row[pCol]) !== null;
      cur = { key: def.key, label: def.label, kind: def.kind, unit: def.unit, hasSplit, total: null, rows: [] };
      cur.total = mkRow(row, 'ИТОГО', def.kind, hasSplit);
      blocks.push(cur);
      continue;
    }
    if (!cur) continue; // строки до первого блока («План», шапка)
    if (label.trim() === '' || label === '#REF!') continue;
    cur.rows.push(mkRow(row, label.trim().replace(/\s+/g, ' '), cur.kind, cur.hasSplit));
  }
  function mkRow(row, label, kind, hasSplit) {
    const months = take12(row, mCol);
    const out = { label, year: yearOf(row, months, kind), months };
    if (hasSplit && pCol !== undefined && rCol !== undefined) {
      out.primary = take12(row, pCol);
      out.repeat = take12(row, rCol);
    }
    return out;
  }
  return { name, workingDays, blocks };
}

function parseManagers() {
  const rows = sheetRows('Менеджеры');
  const header = rows.find(isMonthHeader);
  const janCols = header.map((v, i) => (v === 'Январь' ? i : -1)).filter(i => i >= 0);
  const [mCol, pCol, rCol] = janCols;
  // Справочник менеджеров: ManagerN → bitrix id + scope.
  const ref = sheetRows('Справочники');
  const refHead = ref.findIndex(r => r[9] === 'label');
  const dict = new Map();
  for (const r of ref.slice(refHead + 1)) if (typeof r[9] === 'string' && r[9].startsWith('Manager')) dict.set(r[9], { bitrixId: String(r[10]), scope: r[12] ?? null });

  const blocks = [];
  let cur = null;
  for (const row of rows) {
    if (row[0] === true && typeof row[1] === 'string') {
      const def = row[1] === 'Сумма отгрузок' ? 'ship_sum' : row[1] === 'Сумма продаж' ? 'sales_sum' : null;
      if (!def) { cur = null; continue; }
      cur = { key: def, label: row[1], total: { months: take12(row, mCol), primary: take12(row, pCol), repeat: take12(row, rCol) }, managers: [] };
      blocks.push(cur);
      continue;
    }
    if (!cur) continue;
    const mk = row[1];
    if (typeof mk !== 'string' || !mk.startsWith('Manager')) continue;
    const d = dict.get(mk);
    cur.managers.push({
      key: mk, bitrixId: d?.bitrixId ?? null, scope: d?.scope ?? null, name: typeof row[2] === 'string' ? row[2] : null,
      year: num(row[3]), months: take12(row, mCol), primary: take12(row, pCol), repeat: take12(row, rCol),
    });
  }
  return { blocks };
}

const deptNames = wb.SheetNames.filter(n => /^(СПБ|МСК|КРД) \(/.test(n));
const sheets = deptNames.map(parseDeptSheet);
const managers = parseManagers();

const out = { year, sourceFile: path.basename(filePath), importedAt: new Date().toISOString(), blocks: BLOCKS, sheets, managers };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(__dirname, '..', 'features', 'decomposition', 'data', `decomposition-${year}.json`);
fs.writeFileSync(target, JSON.stringify(out));
console.log(`OK → ${path.relative(process.cwd(), target)} (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
for (const s of sheets) {
  const b0 = s.blocks[0];
  console.log(`  ${s.name.padEnd(16)} blocks=${s.blocks.length} rows=${b0?.rows.length} split=${b0?.hasSplit} wd=${s.workingDays ? 'yes' : 'no'} ship_year=${b0?.total.year} sumMonths=${Math.round(b0?.total.months.reduce((a, b) => a + b, 0))} rowsSum=${Math.round(b0?.rows.reduce((a, r) => a + r.months.reduce((x, y) => x + y, 0), 0))}`);
  const bad = s.blocks.filter(b => b.rows.length !== b0.rows.length).map(b => `${b.key}:${b.rows.length}`);
  if (bad.length) console.log(`     rows differ: ${bad.join(' ')}`);
}
console.log(`  Менеджеры: ${managers.blocks.map(b => `${b.key}=${b.managers.length} (с id: ${b.managers.filter(m => m.bitrixId).length})`).join(', ')}`);

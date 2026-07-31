// Чистые функции реестра сотрудников (без импорта pg — используются и на
// сервере, и в клиентском бандле страницы «Сотрудники»).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateManualStartDate(value: string | null): string | null {
  if (value === null) return null; // очистка — валидно
  if (!DATE_RE.test(value)) return 'Дата должна быть в формате ГГГГ-ММ-ДД';
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return 'Некорректная дата';
  const todayMsk = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  if (value > todayMsk) return 'Дата начала не может быть в будущем';
  if (value < '1990-01-01') return 'Слишком ранняя дата';
  return null;
}

// Стаж «X лет Y мес» от даты начала до сегодня (по МСК).
export function tenureLabel(startDateIso: string | null, today = new Date()): string | null {
  if (!startDateIso || !DATE_RE.test(startDateIso)) return null;
  const [y, m, d] = startDateIso.split('-').map(Number);
  const todayIso = today.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  const [ty, tm, td] = todayIso.split('-').map(Number);
  let months = (ty - y) * 12 + (tm - m) - (td < d ? 1 : 0);
  if (months < 0) months = 0;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years === 0 && rest === 0) return 'меньше месяца';
  if (years === 0) return `${rest} мес`;
  if (rest === 0) return `${years} ${yearsWord(years)}`;
  return `${years} ${yearsWord(years)} ${rest} мес`;
}

function yearsWord(n: number): string {
  const mod10 = n % 10; const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'год';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'года';
  return 'лет';
}

export interface RenameOp {
  kind: 'seed' | 'rename' | 'skip-flip';
  bitrixId: string;
  name: string;
  prevName?: string;
}

export function normalizeName(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

// Чистая логика (покрыта assert-скриптом scripts/assert-employee-rename-detect.ts,
// sa.employees при проверке не мутируется — БД тут вообще не нужна).
//
// ВАЖНО (урок первого прогона на проде 31.07): sa.employees.full_name у многих —
// ЛОГИН («askulikov»), а org-sync пишет в историю настоящее ФИО из Битрикса
// («Александр Куликов»). Наивное сравнение зафиксировало 105 ложных
// «переименований» (откачено). Поэтому для логинов, покрытых org-sync
// (orgManaged — есть в sa.org_resolved_hierarchy), имена авторитетно ведёт
// ТОЛЬКО org-sync (суточный, со своим детектом renamed) — мы их не трогаем.
// Наш детект дополняет его только для сотрудников ВНЕ оргструктуры Битрикса.
export function planRenameOps(
  current: Map<string, string>,               // bitrix_id -> employees.full_name
  openHistory: Map<string, string>,           // bitrix_id -> имя открытой SCD2-строки
  lastClosed: Map<string, string>,            // bitrix_id -> имя последней закрытой строки
  orgManaged: Set<string> = new Set(),        // bitrix_id, которых ведёт org-sync
): RenameOp[] {
  const ops: RenameOp[] = [];
  for (const [bitrixId, rawName] of current) {
    const name = normalizeName(rawName);
    if (!name) continue;
    const open = openHistory.get(bitrixId);
    if (open === undefined) {
      ops.push({ kind: 'seed', bitrixId, name });
      continue;
    }
    if (normalizeName(open) === name) continue;
    if (orgManaged.has(bitrixId)) continue; // имя этого логина авторитетно ведёт org-sync
    const prevClosed = lastClosed.get(bitrixId);
    if (prevClosed !== undefined && normalizeName(prevClosed) === name) {
      // Возврат к только что закрытому имени — почти наверняка расхождение форматов
      // между синком employees и org-sync, а не реальное переименование слота.
      ops.push({ kind: 'skip-flip', bitrixId, name, prevName: open });
      continue;
    }
    ops.push({ kind: 'rename', bitrixId, name, prevName: open });
  }
  return ops;
}

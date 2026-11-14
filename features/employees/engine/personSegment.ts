// «Человек на учётке» (задача #11110, план Маркуса 28.10, одобрено Серёгой «Делай на деве»).
//
// Учётка Битрикса (bitrix_id) — это СЛОТ: на ней сменяются люди, а при уходе
// человека слот переименовывают в заглушку (manager68, User 2045, Caller13…).
// Стаж, XP и диагностика «новичок» должны считаться по ЧЕЛОВЕКУ, т.е. по отрезку
// текущего ФИО в sa.employee_name_history (SCD2, ведёт org-sync, история с 13.07.2026).
//
// Чистые функции без pg — используются и на сервере, и в клиентском бандле.

const MSK = 'Europe/Moscow';

/** Строка истории имён (valid_from/valid_to — ISO-таймстемпы). */
export interface NameHistoryRow { name: string; validFrom: string; validTo: string | null }

// Заглушки, проверено по проду 28.10 (1029 строк, 435 учёток): managerN, ManagerN,
// «Менеджер N», User N, CallerN, studentosN, studentncN, logistN, LogistN,
// ЛогистБухN, RHN, ROPNKN, ROPOSN, ROPYLN, ropN, SDDN, SDRN, OKN, ProgerN, testuserN,
// склейки вида «manager2929 manager2929» / «Логист301 Логист301».
// Общий признак: каждое слово — буквы + номер. В настоящих ФИО цифр нет.
const STUB_TOKEN = /^[a-zа-яё]+ ?\d+$/i;
// Служебные имена без номера.
const STUB_EXACT = new Set(['удалить', 'rosnc', 'mltadmin', 'ai']);

export function isPlaceholderName(raw: string | null | undefined): boolean {
  const s = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return true;
  if (STUB_EXACT.has(s.toLowerCase())) return true;
  // «User 1891», «manager 307», «Менеджер 142» — слово и номер через пробел.
  if (/^[a-zа-яё]+ \d+$/i.test(s)) return true;
  return s.split(' ').every(t => STUB_TOKEN.test(t));
}

/** Ключ сравнения «тот же человек»: регистр, ё/е, ударения, пометки в скобках
 *  («Вячеслав Скворцов (РОПМСКНЦ)» = «Вячеслав Скворцов (МСК 2013)»). */
export function personKey(raw: string | null | undefined): string {
  return (raw ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC')
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase().replace(/ё/g, 'е')
    .trim().replace(/\s+/g, ' ');
}

/** Тот же человек? Ключи совпали, либо слова одного ФИО целиком входят в другое
 *  (пометки вне скобок: «Алексей В ОТПУСКЕ Исаковский», «Алина Малаева Вне Зоны
 *  Доступа»). Смену фамилии (замужество) так не поймать — это РОП правит руками. */
export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = personKey(a), kb = personKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const ta = ka.split(' '), tb = kb.split(' ');
  const [small, big] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return small.length >= 2 && small.every(t => big.has(t));
}

export function mskDate(iso: string): string {
  return new Date(iso).toLocaleDateString('sv-SE', { timeZone: MSK });
}

export interface PersonSegment {
  /** На учётке сейчас заглушка — человека нет. */
  vacant: boolean;
  /** ФИО текущего человека (null при вакансии). */
  name: string | null;
  /** Начало отрезка (ISO-таймстемп) — первая строка непрерывной серии текущего ФИО
   *  (или текущей вакансии). */
  startAt: string;
  /** То же, дата МСК YYYY-MM-DD. */
  startDate: string;
  /** false — отрезок начинается с ПЕРВОЙ строки истории учётки (засевка 13.07.2026
   *  или первое появление учётки в синке, напр. добор глав отделов 30.07): человек
   *  мог сидеть на учётке и раньше, настоящее начало неизвестно. */
  knownStart: boolean;
}

/**
 * Отрезок текущего человека. Начало известно, только если ему предшествует смена
 * ФИО (другой человек или заглушка). Возвращает null, если истории по учётке нет.
 */
export function currentPersonSegment(rows: NameHistoryRow[]): PersonSegment | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  // Текущая строка — открытая (valid_to IS NULL); на всякий случай — самая поздняя.
  let idx = sorted.length - 1;
  for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i].validTo === null) { idx = i; break; }
  const cur = sorted[idx];
  const vacant = isPlaceholderName(cur.name);
  let first = idx;
  // Серия «тот же человек» (или вакансия подряд — manager68 → User 2045 → manager68)
  // идёт назад без разрывов. Возврат человека после заглушки — новый отрезок.
  while (first > 0) {
    const prev = sorted[first - 1];
    const same = vacant ? isPlaceholderName(prev.name) : (!isPlaceholderName(prev.name) && samePerson(prev.name, cur.name));
    if (!same) break;
    first--;
  }
  const startAt = sorted[first].validFrom;
  const startDate = mskDate(startAt);
  const knownStart = first > 0;
  return { vacant, name: vacant ? null : cur.name, startAt, startDate, knownStart };
}

export interface TenureResolution {
  /** Дата начала, которую показываем как стаж (null = «не заполнено»). */
  startDate: string | null;
  source: 'manual' | 'segment' | null;
  /** Ручная дата есть, но поставлена при другом ФИО (или до смены человека). */
  manualStale: boolean;
  vacant: boolean;
  segment: PersonSegment | null;
}

/**
 * Ручная дата действует, только если поставлена при текущем ФИО.
 * `manualStartName` — ФИО, при котором её внесли (sa.employee_registry.manual_start_name).
 * `fallbackToSegment` — если ручной даты нет/устарела, взять начало отрезка
 * (только если оно известно): профиль ЛК — да, реестр «Сотрудники» — нет
 * (там РОП должен увидеть «не заполнено» и проставить).
 */
export function resolveTenure(
  manualStartDate: string | null, manualStartName: string | null,
  segment: PersonSegment | null, fallbackToSegment: boolean,
): TenureResolution {
  const vacant = !!segment?.vacant;
  let manualValid = false;
  if (manualStartDate && !vacant) {
    if (!segment) manualValid = true;                       // истории нет — сверять не с чем
    else if (manualStartName) manualValid = samePerson(manualStartName, segment.name);
    else manualValid = !segment.knownStart;                 // старая строка без ФИО: верим, если человек не менялся
  }
  const manualStale = !!manualStartDate && !manualValid;
  if (manualValid) return { startDate: manualStartDate, source: 'manual', manualStale, vacant, segment };
  if (fallbackToSegment && segment && !vacant && segment.knownStart) {
    return { startDate: segment.startDate, source: 'segment', manualStale, vacant, segment };
  }
  return { startDate: null, source: null, manualStale, vacant, segment };
}

/**
 * Граница XP «с какого дня сделки — этого человека» (план п.3): более поздняя из
 * (ручная дата, начало текущего ФИО). Начало отрезка с первой строки истории (засевка
 * 13.07, первое появление учётки) границей не считается (иначе всем срезало бы ретро). Вакансия — граница = начало вакансии
 * (XP предшественника заморожен). null — границы нет.
 */
export function xpPersonBoundary(manualStartDate: string | null, segment: PersonSegment | null): string | null {
  const cands: string[] = [];
  if (manualStartDate && !segment?.vacant) cands.push(manualStartDate);
  if (segment && (segment.knownStart || segment.vacant)) cands.push(segment.startDate);
  if (!cands.length) return null;
  return cands.sort().at(-1)!;
}

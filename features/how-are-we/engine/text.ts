import { BRANCH_LABEL, type HowAreWeFacts, type UnitFact, type DeptFact, type ManagerFact, type PaceLine } from './facts';
import { phraseVariants, type PhraseOverrides } from './phrases';

// ── Дайджест «Как дела?» — текст ─────────────────────────────────────────────
//
// Разметка — bbcode чата Битрикса, проверенный на живом чате набор (15.09):
// [B] [I] [U] [S] [COLOR] [SIZE] [URL] [USER] [BR]. НЕ работают: [QUOTE] [LIST]
// [TABLE] [H1] [ICON]; [CODE] рисует блок, но не моноширинный — колонки не
// выровнять, поэтому никаких псевдотаблиц, только фразы. Эмодзи — любые.
//
// Пороговые решения (кто «лидер», что «аномалия») — здесь, а не во фразах:
// владелец правит слова, не математику.

const GREEN = '#2e7d32';
const RED = '#c62828';
const GREY = '#8a8a8a';

const AHEAD = 1.15;
const BEHIND = 0.85;

// Детерминированный генератор (mulberry32): сид — дата и час выпуска.
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fmtMoney(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1).replace('.', ',')} млн`;
  if (a >= 1e3) return `${Math.round(v / 1e3)} тыс.`;
  return `${Math.round(v)} ₽`;
}
const pct = (v: number) => `${Math.round(v)}`;
const int = (v: number) => `${Math.round(v)}`;
const surname = (name: string) => name.trim().split(/\s+/).pop() ?? name;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** «73 сделки», «5 сделок», «1 сделка» — для усреднённых значений округляем. */
export function dealsWord(n: number): string {
  const v = Math.round(n); const m10 = v % 10; const m100 = v % 100;
  const w = m10 === 1 && m100 !== 11 ? 'сделка' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'сделки' : 'сделок';
  return `${v} ${w}`;
}
const user = (m: { id: string; name: string }) => `[USER=${m.id}]${surname(m.name)}[/USER]`;
const color = (c: string, s: string) => `[COLOR=${c}]${s}[/COLOR]`;

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const HOUR_WORDS: Record<number, string> = { 10: 'десяти утра', 11: 'одиннадцати', 12: 'полудню', 13: 'часу дня', 14: 'двум часам', 15: 'трём часам', 16: 'четырём часам', 17: 'пяти часам', 18: 'шести вечера', 19: 'семи вечера' };

function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}

/** Отношение факта к обычному; null — сравнивать не с чем (обычно ≈ 0). */
function ratio(fact: number, usual: number): number | null { return usual > 1e4 ? fact / usual : null; }
function trendOf(u: UnitFact): 'ahead' | 'behind' | 'normal' {
  const r = ratio(u.sales.amt, u.usual.amt);
  if (r == null) return 'normal';
  return r >= AHEAD ? 'ahead' : r <= BEHIND ? 'behind' : 'normal';
}

export interface BuildOptions {
  overrides?: PhraseOverrides;
  /** Часы выпусков — для подписи «следующая сводка в …». */
  hours?: number[];
  /** Базовый адрес приложения — для ссылок на отчёт. */
  baseUrl?: string;
}

const DOT = { ahead: '🟢', behind: '🔴', normal: '⚪' } as const;

export function buildHowAreWeMessage(f: HowAreWeFacts, opts: BuildOptions = {}): string {
  const overrides = opts.overrides ?? {};
  const rand = rng(`${f.dateStr}:${f.cutHour}`);
  const pick = (key: string, vars: Record<string, string> = {}): string => {
    const vs = phraseVariants(key, overrides);
    if (!vs.length) return '';
    return fill(vs[Math.floor(rand() * vs.length)], vars);
  };
  const hours = (opts.hours?.length ? opts.hours : [12, 15, 18]).slice().sort((a, b) => a - b);
  const baseUrl = opts.baseUrl ?? 'https://monolitika.mlt-it.com';

  const d = new Date(`${f.dateStr}T00:00:00Z`);
  const time = `${String(f.cutHour).padStart(2, '0')}:00`;
  const out: string[] = [];

  // Заголовок.
  out.push(`[SIZE=16][B]${pick('title', {
    weekday: WEEKDAYS[d.getUTCDay()], date: `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]}`, time,
  })}[/B][/SIZE]`);
  out.push('');

  // Компания: цифра — отдельной строкой, оценка — отдельной, воронка — отдельной.
  const c = f.company;
  const cPct = c.plan ? pct(c.sales.amt / c.plan * 100) : '—';
  out.push(`[B]${fmtMoney(c.sales.amt)} из ${c.plan ? fmtMoney(c.plan) : '—'}[/B] — ${cPct} % плана дня`);
  out.push(pick(`company_${trendOf(c)}`, {
    time_words: HOUR_WORDS[f.cutHour] ?? `${f.cutHour}:00`,
    fact: fmtMoney(c.sales.amt), plan: c.plan ? fmtMoney(c.plan) : '—', pct: cPct, usual: fmtMoney(c.usual.amt),
    deals: int(c.sales.n), usual_deals: int(c.usual.n), deals_w: dealsWord(c.sales.n), usual_deals_w: dealsWord(c.usual.n),
  }));
  const br = c.usualBooks.n > 0 ? c.books.n / c.usualBooks.n : 1;
  out.push(pick(br < 0.8 ? 'funnel_weak' : br > 1.2 ? 'funnel_strong' : 'funnel_ok',
    { books: int(c.books.n), usual_books: int(c.usualBooks.n), created: int(c.created.n), usual_created: int(c.usualCreated.n) }));
  out.push('');

  // Филиалы — лучший первым: порядок в сообщении задаёт результат, а не алфавит.
  // Под филиалом — все его команды строками, по выполнению дневного плана; метка
  // цветом относительно темпа компании (правка владельца 15.09: «филиалы на
  // команды разделить структурно, чтобы считывалось, кто как идёт»).
  const companyPct = c.plan ? c.sales.amt / c.plan : null;
  const withPct = f.branches.map(b => ({ b, p: b.plan ? b.sales.amt / b.plan : 0 }));
  withPct.sort((x, y) => y.p - x.p);
  for (const { b, p } of withPct) {
    if (!b.plan && b.sales.n === 0 && b.usual.n === 0) continue;
    const trend = trendOf(b);
    out.push(`${DOT[trend]} [B]${b.name}[/B] — ${fmtPair(b.sales.amt, b.plan)} · [B]${b.plan ? pct(p * 100) : '—'} %[/B]`);
    const intro = pick(`branch_${trend}`, { name: b.name, fact: fmtMoney(b.sales.amt), usual: fmtMoney(b.usual.amt), pct: b.plan ? pct(p * 100) : '—', gap: fmtMoney(Math.max(0, b.usual.amt - b.sales.amt)) });
    if (intro) out.push(color(GREY, intro));
    for (const line of departmentLines(f, b.key, companyPct)) out.push(line);
    out.push('');
  }

  // Люди — по строке на человека.
  const heroes = f.managers
    .filter(m => m.sales.amt >= 5e5)
    .sort((a, b) => b.sales.amt - a.sales.amt).slice(0, 3);
  if (heroes.length) {
    out.push(pick('heroes'));
    for (const m of heroes) {
      const k = m.plan && m.plan >= 3e5 ? m.sales.amt / m.plan : null;
      const tail = k && k >= 1.5 && k <= 5 ? ` · ×${k.toFixed(1).replace('.', ',')} к плану дня` : '';
      out.push(`${user(m)} (${shortBranch(m.branch)}, ${shortDept(m.dept)}) — ${fmtMoney(m.sales.amt)}${m.sales.n > 1 ? `, ${dealsWord(m.sales.n)}` : ''}${tail}`);
    }
    out.push('');
  }

  // Вечер: темп месяца.
  if (f.month) {
    out.push('📅 [B]Месяц[/B]');
    out.push(paceLine('продажам', f.month.company.sales, f.month.workdayNum, f.month.workdaysInMonth, pick));
    out.push(paceLine('отгрузкам', f.month.company.shipments, f.month.workdayNum, f.month.workdaysInMonth, pick));
    const parts = f.month.branches
      .filter(b => b.sales.plan > 0 && b.sales.share != null)
      .map(b => `${b.name} ${pct(b.sales.share! * 100)} %${b.sales.typicalShare ? ` (обычно ${pct(b.sales.typicalShare * 100)})` : ''}`);
    if (parts.length) out.push(color(GREY, `Продажи по филиалам: ${parts.join(' · ')}`));
    out.push('');
  }

  // Подпись.
  const next = hours.find(h => h > f.cutHour);
  const footer = next
    ? pick('footer_next', { next_time: `${String(next).padStart(2, '0')}:00` })
    : pick('footer_evening', { next_time: `${String(hours[0] ?? 12).padStart(2, '0')}:00` });
  if (footer) out.push(`[I]${footer}[/I]`);

  // Сокращения «сд.»/«тыс.» на стыке с точкой шаблона дают «..» — схлопываем.
  return out.join('\n').replace(/\.\./g, '.').replace(/\n{3,}/g, '\n\n').trim();
}

/** Названия команд — как в оргструктуре: «Команда Ухановой» без первого слова
 *  остаётся в родительном падеже, сокращать нельзя. */
function shortDept(dept: string): string { return dept; }

function shortBranch(branch: string): string {
  return branch === 'СПб' ? 'СПб' : branch === 'Москва/МО' ? 'Москва' : BRANCH_LABEL[branch] ?? branch;
}

type Pick = (key: string, vars?: Record<string, string>) => string;

/** «3,6 из 4,3 млн» — единица измерения один раз, когда обе суммы в миллионах. */
export function fmtPair(fact: number, plan: number | null): string {
  if (!plan) return fmtMoney(fact);
  if (fact >= 1e6 && plan >= 1e6) return `${(fact / 1e6).toFixed(1).replace('.', ',')} из ${fmtMoney(plan)}`;
  if (fact === 0) return `0 из ${fmtMoney(plan)}`;
  return `${fmtMoney(fact)} из ${fmtMoney(plan)}`;
}

/** Метка команды относительно темпа компании по дневному плану. */
function deptDot(p: number | null, companyPct: number | null, sales: number): string {
  if (sales === 0) return '⚫';
  if (p == null) return '⚪';
  const ref = companyPct && companyPct > 0.05 ? companyPct : 0.4;
  return p >= ref * 1.25 ? '🟢' : p <= ref * 0.6 ? '🔴' : '⚪';
}

function departmentLines(f: HowAreWeFacts, branch: string, companyPct: number | null): string[] {
  // Существенные команды: план дня или обычный уровень от 300 тыс.
  const depts = f.departments.filter(d => d.branch === branch && ((d.plan ?? 0) >= 3e5 || d.usual.amt >= 3e5));
  if (!depts.length) return [];
  const rows = depts
    .map(d => ({ d, p: d.plan ? d.sales.amt / d.plan : null }))
    .sort((a, b) => (b.p ?? -1) - (a.p ?? -1) || b.d.sales.amt - a.d.sales.amt);
  return rows.map(({ d, p }) => {
    // Хвост строки — одно уточнение: у лидеров кто тащит, у провалов — что обычно.
    let tail = '';
    if (p != null && p >= 0.5) {
      const top = f.managers.filter(m => m.branch === branch && m.dept === d.name && m.sales.amt >= 3e5)
        .sort((a, b) => b.sales.amt - a.sales.amt)[0];
      if (top) tail = ` · ${surname(top.name)} ${fmtMoney(top.sales.amt)}`;
    } else if (d.usual.amt >= 5e5 && d.sales.amt / d.usual.amt < 0.4) {
      tail = ` · обычно ${fmtMoney(d.usual.amt)}`;
    }
    return `${deptDot(p, companyPct, d.sales.n)} ${shortDept(d.name)} — ${fmtPair(d.sales.amt, d.plan)}${p != null && d.sales.n > 0 ? ` · ${pct(p * 100)} %` : ''}${tail}`;
  });
}

function paceLine(kind: string, p: PaceLine, day: number, days: number, pick: Pick): string {
  if (!p.plan || p.share == null) return color(GREY, `По ${kind} план месяца не задан.`);
  const state = p.typicalShare == null ? 'ontrack'
    : p.share - p.typicalShare > 0.03 ? 'ahead' : p.typicalShare - p.share > 0.03 ? 'behind' : 'ontrack';
  const mark = state === 'ahead' ? color(GREEN, '↑') : state === 'behind' ? color(RED, '↓') : color(GREY, '→');
  return `${mark} ${pick(`pace_${state}`, {
    kind, kind_cap: cap(kind), mtd: fmtMoney(p.mtd), plan: fmtMoney(p.plan), share: pct(p.share * 100),
    typical: p.typicalShare != null ? pct(p.typicalShare * 100) : '—', forecast: p.forecast != null ? fmtMoney(p.forecast) : '—',
    need: p.needPerDay != null ? fmtMoney(p.needPerDay) : '—', day: String(day), days: String(days),
  })}`;
}

export { surname as managerSurname };
export type { ManagerFact, DeptFact };

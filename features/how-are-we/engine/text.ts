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
  /** Ссылка на картинку — на телефоне превью вложения не кликается, даём явную. */
  imageUrl?: string | null;
  overrides?: PhraseOverrides;
  /** Часы выпусков — для подписи «следующая сводка в …». */
  hours?: number[];
  /** Базовый адрес приложения — для ссылок на отчёт. */
  baseUrl?: string;
}


type Pick = (key: string, vars?: Record<string, string>) => string;

function makePick(f: HowAreWeFacts, overrides: PhraseOverrides, salt = ''): Pick {
  const rand = rng(`${f.dateStr}:${f.cutHour}${salt}`);
  return (key, vars = {}) => {
    const vs = phraseVariants(key, overrides);
    if (!vs.length) return '';
    return fill(vs[Math.floor(rand() * vs.length)], vars);
  };
}

function header(f: HowAreWeFacts, pick: Pick): string {
  const d = new Date(`${f.dateStr}T00:00:00Z`);
  return `[SIZE=16][B]${pick('title', {
    weekday: WEEKDAYS[d.getUTCDay()], date: `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]}`, time: `${String(f.cutHour).padStart(2, '0')}:00`,
  })}[/B][/SIZE]`;
}

function finish(out: string[]): string {
  // Сокращения «сд.»/«тыс.» на стыке с точкой шаблона дают «..» — схлопываем.
  return out.join('\n').replace(/\.\./g, '.').replace(/\n{3,}/g, '\n\n').trim();
}

/** Короткое сообщение — то, что приходит по расписанию (читается с телефона):
 *  компания, по строке на филиал человеческим языком, герои, кнопка «Детально». */
export function buildHowAreWeMessage(f: HowAreWeFacts, opts: BuildOptions = {}): string {
  const overrides = opts.overrides ?? {};
  const pick = makePick(f, overrides);
  const hours = (opts.hours?.length ? opts.hours : [12, 15, 18]).slice().sort((a, b) => a - b);
  const out: string[] = [header(f, pick), ''];

  // Компания: цифра, оценка против обычного, воронка — три короткие строки.
  const c = f.company;
  const companyPct = c.plan ? c.sales.amt / c.plan : null;
  out.push(`[B]${companyPct != null ? `${pct(companyPct * 100)} % плана дня` : fmtMoney(c.sales.amt)}[/B] — ${fmtPair(c.sales.amt, c.plan)}`);
  out.push(pick(`company_${trendOf(c)}`, {
    time_words: HOUR_WORDS[f.cutHour] ?? `${f.cutHour}:00`,
    fact: fmtMoney(c.sales.amt), plan: c.plan ? fmtMoney(c.plan) : '—', pct: companyPct != null ? pct(companyPct * 100) : '—', usual: fmtMoney(c.usual.amt),
    deals: int(c.sales.n), usual_deals: int(c.usual.n), deals_w: dealsWord(c.sales.n), usual_deals_w: dealsWord(c.usual.n),
  }));
  const br = c.usualBooks.n > 0 ? c.books.n / c.usualBooks.n : 1;
  out.push(pick(br < 0.8 ? 'funnel_weak' : br > 1.2 ? 'funnel_strong' : 'funnel_ok',
    { books: int(c.books.n), usual_books: int(c.usualBooks.n), created: int(c.created.n), usual_created: int(c.usualCreated.n) }));
  out.push('');

  // Филиалы — по строке, лучший первым.
  const withPct = f.branches.map(b => ({ b, p: b.plan ? b.sales.amt / b.plan : null }));
  withPct.sort((x, y) => (y.p ?? -1) - (x.p ?? -1));
  for (const { b, p } of withPct) {
    if (!b.plan && b.sales.n === 0 && b.usual.n === 0) continue;
    out.push(`[B]${b.name}[/B] — [B]${coloredPct(p, companyPct, b.sales.n)}[/B]. ${branchSummary(f, b.key, companyPct, pick)}`);
  }
  out.push('');

  // Герои — по строке на человека.
  const heroes = f.managers.filter(m => m.sales.amt >= 5e5).sort((a, b) => b.sales.amt - a.sales.amt).slice(0, 3);
  if (heroes.length) {
    out.push(pick('heroes'));
    for (const m of heroes) {
      const k = m.plan && m.plan >= 3e5 ? m.sales.amt / m.plan : null;
      const tail = k && k >= 1.5 && k <= 5 ? ` · ×${k.toFixed(1).replace('.', ',')} к плану дня` : '';
      out.push(`${user(m)} (${shortBranch(m.branch)}, ${shortDept(m.dept)}) — ${fmtMoney(m.sales.amt)}${m.sales.n > 1 ? `, ${dealsWord(m.sales.n)}` : ''}${tail}`);
    }
    out.push('');
  }

  // Вечер: темп месяца — коротко, по строке на продажи и отгрузки.
  if (f.month) {
    out.push('📅 [B]Месяц[/B]');
    out.push(paceLine('продажам', f.month.company.sales, f.month.workdayNum, f.month.workdaysInMonth, pick));
    out.push(paceLine('отгрузкам', f.month.company.shipments, f.month.workdayNum, f.month.workdaysInMonth, pick));
    out.push('');
  }

  if (opts.imageUrl) out.push(`🖼 [URL=${opts.imageUrl}]Открыть график[/URL]`);
  const next = hours.find(h => h > f.cutHour);
  const footer = next
    ? pick('footer_next', { next_time: `${String(next).padStart(2, '0')}:00` })
    : pick('footer_evening', { next_time: `${String(hours[0] ?? 12).padStart(2, '0')}:00` });
  out.push(color(GREY, `${pick('details_hint')} ${footer}`));
  return finish(out);
}

/** Строка про филиал человеческим языком: кто тащит, кто филонит, кто по нулям. */
function branchSummary(f: HowAreWeFacts, branch: string, companyPct: number | null, pick: Pick): string {
  const depts = f.departments.filter(d => d.branch === branch && ((d.plan ?? 0) >= 3e5 || d.usual.amt >= 3e5));
  const withP = depts.map(d => ({ d, p: d.plan ? d.sales.amt / d.plan : null }));
  const ref = companyPct && companyPct > 0.05 ? companyPct : 0.4;
  const parts: string[] = [];

  const leader = withP.filter(x => x.p != null && x.p >= Math.max(0.5, ref * 1.25)).sort((a, b) => b.p! - a.p!)[0];
  if (leader) {
    const top = f.managers.filter(m => m.branch === branch && m.dept === leader.d.name && m.sales.amt >= 5e5)
      .sort((a, b) => b.sales.amt - a.sales.amt)[0];
    parts.push(pick('branch_leader', { team: shortTeam(leader.d.name), pct: pct(leader.p! * 100), top: top ? `, ${surname(top.name)} ${fmtMoney(top.sales.amt)}` : '' }));
  }
  const laggards = withP.filter(x => x.d !== leader?.d && x.p != null && x.p < 0.25 && x.d.sales.n > 0 && (x.d.plan ?? 0) >= 5e5).sort((a, b) => a.p! - b.p!);
  if (laggards.length) {
    const names = laggards.slice(0, 3).map(x => shortTeam(x.d.name));
    const list = laggards.length > 3 ? `${names.join(', ')} и ещё ${laggards.length - 3}` : names.join(', ');
    parts.push(pick('branch_laggards', { list, n: String(laggards.length) }));
  }
  const zeros = withP.filter(x => x.d.sales.n === 0 && (x.d.plan ?? 0) >= 5e5);
  if (zeros.length) parts.push(pick('branch_zero', { list: zeros.slice(0, 2).map(x => shortTeam(x.d.name)).join(', ') }));
  if (!parts.length) return pick('branch_stagnant', { pct: companyPct != null ? pct(companyPct * 100) : '—' }) + '.';
  return cap(parts.join('; ')) + '.';
}

/** Короткое имя команды для сводки: «Команда Осипов» → «Осипов», «Отдел ЖБИ» → «ЖБИ».
 *  В деталях команды идут полными именами (см. shortDept). */
function shortTeam(name: string): string {
  const short = name.replace(/^(Команда|Отдел)\s+/i, '');
  // «Команда Зианбетовой» → «Зианбетовой» — родительный падеж без опоры; такие
  // оставляем целиком. Мужские («Осипов», «Руденко») и аббревиатуры («ЖБИ») режем.
  return /(ой|ей|ого|его|ых|их)$/i.test(short) ? name : short;
}

/** Детали по кнопке: филиалы → департаменты → команды, всё с процентами. */
export function buildHowAreWeDetails(f: HowAreWeFacts, opts: BuildOptions = {}): string {
  const overrides = opts.overrides ?? {};
  const pick = makePick(f, overrides, ':details');
  const c = f.company;
  const companyPct = c.plan ? c.sales.amt / c.plan : null;
  const out: string[] = [`[B]Детально · ${String(f.cutHour).padStart(2, '0')}:00[/B]`, ''];
  const withPct = f.branches.map(b => ({ b, p: b.plan ? b.sales.amt / b.plan : null }));
  withPct.sort((x, y) => (y.p ?? -1) - (x.p ?? -1));
  for (const { b, p } of withPct) {
    if (!b.plan && b.sales.n === 0 && b.usual.n === 0) continue;
    const trend = trendOf(b);
    out.push(`[B]${b.name}[/B] — ${fmtPair(b.sales.amt, b.plan)} · [B]${coloredPct(p, companyPct, b.sales.n)}[/B]`);
    const intro = pick(`branch_${trend}`, { name: b.name, fact: fmtMoney(b.sales.amt), usual: fmtMoney(b.usual.amt), pct: p != null ? pct(p * 100) : '—', gap: fmtMoney(Math.max(0, b.usual.amt - b.sales.amt)) });
    if (intro) out.push(color(GREY, intro));
    for (const line of departmentLines(f, b.key, companyPct)) out.push(line);
    out.push('');
  }
  if (f.month) {
    const parts = f.month.branches
      .filter(x => x.sales.plan > 0 && x.sales.share != null)
      .map(x => `${x.name} ${pct(x.sales.share! * 100)} %${x.sales.typicalShare ? ` (обычно ${pct(x.sales.typicalShare * 100)})` : ''}`);
    if (parts.length) { out.push(color(GREY, `Продажи месяца по филиалам: ${parts.join(' · ')}`)); out.push(''); }
  }
  return finish(out);
}

/** Названия команд — как в оргструктуре: «Команда Ухановой» без первого слова
 *  остаётся в родительном падеже, сокращать нельзя. */
function shortDept(dept: string): string { return dept; }
function shortBranch(branch: string): string {
  return branch === 'СПб' ? 'СПб' : branch === 'Москва/МО' ? 'Москва' : BRANCH_LABEL[branch] ?? branch;
}

/** «3,6 из 4,3 млн» — единица измерения один раз, когда обе суммы в миллионах. */
export function fmtPair(fact: number, plan: number | null): string {
  if (!plan) return fmtMoney(fact);
  if (fact >= 1e6 && plan >= 1e6) return `${(fact / 1e6).toFixed(1).replace('.', ',')} из ${fmtMoney(plan)}`;
  if (fact === 0) return `0 из ${fmtMoney(plan)}`;
  return `${fmtMoney(fact)} из ${fmtMoney(plan)}`;
}

/** Процент плана, окрашенный относительно темпа компании: зелёный — заметно выше,
 *  красный — заметно ниже или ноль, обычный — без цвета. */
function coloredPct(p: number | null, companyPct: number | null, sales: number): string {
  if (p == null) return '—';
  const txt = `${pct(p * 100)} %`;
  if (sales === 0) return color(RED, txt);
  const ref = companyPct && companyPct > 0.05 ? companyPct : 0.4;
  return p >= ref * 1.25 ? color(GREEN, txt) : p <= ref * 0.6 ? color(RED, txt) : txt;
}

const INDENT = '\u00A0\u00A0\u00A0\u00A0';

function sumUnits(name: string, list: DeptFact[]): UnitFact {
  const z = { n: 0, amt: 0 };
  const acc: UnitFact = { key: name, name, sales: { ...z }, usual: { ...z }, plan: null, books: { ...z }, usualBooks: { ...z }, created: { ...z }, usualCreated: { ...z } };
  for (const d of list) {
    acc.sales.n += d.sales.n; acc.sales.amt += d.sales.amt; acc.usual.n += d.usual.n; acc.usual.amt += d.usual.amt;
    if (d.plan != null) acc.plan = (acc.plan ?? 0) + d.plan;
  }
  return acc;
}

function teamLine(f: HowAreWeFacts, d: DeptFact, companyPct: number | null, indent: string): string {
  const p = d.plan ? d.sales.amt / d.plan : null;
  // Хвост строки — одно уточнение: у лидеров кто тащит, у провалов — что обычно.
  let tail = '';
  if (p != null && p >= 0.5) {
    const top = f.managers.filter(m => m.branch === d.branch && m.dept === d.name && m.sales.amt >= 3e5)
      .sort((a, b) => b.sales.amt - a.sales.amt)[0];
    if (top) tail = ` · ${surname(top.name)} ${fmtMoney(top.sales.amt)}`;
  } else if (d.usual.amt >= 5e5 && d.sales.amt / d.usual.amt < 0.4) {
    tail = color(GREY, ` · обычно ${fmtMoney(d.usual.amt)}`);
  }
  return `${indent}${d.name} — ${fmtPair(d.sales.amt, d.plan)}${p != null ? ` · ${coloredPct(p, companyPct, d.sales.n)}` : ''}${tail}`;
}

function departmentLines(f: HowAreWeFacts, branch: string, companyPct: number | null): string[] {
  // Существенные команды: план дня или обычный уровень от 300 тыс.
  const depts = f.departments.filter(d => d.branch === branch && ((d.plan ?? 0) >= 3e5 || d.usual.amt >= 3e5));
  if (!depts.length) return [];
  const byPct = (a: DeptFact, b: DeptFact) => ((b.plan ? b.sales.amt / b.plan : -1) - (a.plan ? a.sales.amt / a.plan : -1)) || b.sales.amt - a.sales.amt;

  // Группировка по департаментам — только когда их в филиале больше одного
  // (Питер: Департамент ОС / НЦ); иначе команды сразу под филиалом.
  const parents = [...new Set(depts.map(d => d.parent).filter((x): x is string => !!x))];
  if (parents.length < 2) return depts.sort(byPct).map(d => teamLine(f, d, companyPct, ''));

  const groups = parents.map(name => ({ unit: sumUnits(name, depts.filter(d => d.parent === name)), teams: depts.filter(d => d.parent === name).sort(byPct) }));
  const rest = depts.filter(d => !d.parent).sort(byPct);
  groups.sort((a, b) => ((b.unit.plan ? b.unit.sales.amt / b.unit.plan : -1) - (a.unit.plan ? a.unit.sales.amt / a.unit.plan : -1)));
  const lines: string[] = [];
  for (const g of groups) {
    const gp = g.unit.plan ? g.unit.sales.amt / g.unit.plan : null;
    lines.push(`[B]${g.unit.name}[/B] — ${fmtPair(g.unit.sales.amt, g.unit.plan)} · ${coloredPct(gp, companyPct, g.unit.sales.n)}`);
    for (const d of g.teams) lines.push(teamLine(f, d, companyPct, INDENT));
  }
  for (const d of rest) lines.push(teamLine(f, d, companyPct, ''));
  return lines;
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

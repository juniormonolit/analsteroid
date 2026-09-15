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

  // Компания.
  const c = f.company;
  const cVars = {
    time_words: HOUR_WORDS[f.cutHour] ?? `${f.cutHour}:00`,
    fact: fmtMoney(c.sales.amt), plan: c.plan ? fmtMoney(c.plan) : '—',
    pct: c.plan ? pct(c.sales.amt / c.plan * 100) : '—', usual: fmtMoney(c.usual.amt),
    deals: int(c.sales.n), usual_deals: int(c.usual.n), deals_w: dealsWord(c.sales.n), usual_deals_w: dealsWord(c.usual.n),
  };
  const funnelVars = { books: int(c.books.n), usual_books: int(c.usualBooks.n), created: int(c.created.n), usual_created: int(c.usualCreated.n) };
  const br = c.usualBooks.n > 0 ? c.books.n / c.usualBooks.n : 1;
  out.push(`${pick(`company_${trendOf(c)}`, cVars)} ${pick(br < 0.8 ? 'funnel_weak' : br > 1.2 ? 'funnel_strong' : 'funnel_ok', funnelVars)}`.trim());
  out.push('');

  // Филиалы — лучший первым: порядок в сообщении задаёт результат, а не алфавит.
  const withPct = f.branches.map(b => ({ b, p: b.plan ? b.sales.amt / b.plan : 0 }));
  withPct.sort((x, y) => y.p - x.p);
  for (const { b, p } of withPct) {
    if (!b.plan && b.sales.n === 0 && b.usual.n === 0) continue;
    const trend = trendOf(b);
    const label = trend === 'ahead' ? color(GREEN, pick('trend_ahead')) : trend === 'behind' ? color(RED, pick('trend_behind')) : color(GREY, pick('trend_normal'));
    out.push(`[B]${b.name}[/B] — ${fmtMoney(b.sales.amt)} из ${b.plan ? fmtMoney(b.plan) : '—'} · [B]${b.plan ? pct(p * 100) : '—'} %[/B] · ${label}`);
    const lines: string[] = [];
    const introVars = { name: b.name, fact: fmtMoney(b.sales.amt), usual: fmtMoney(b.usual.amt), pct: b.plan ? pct(p * 100) : '—', gap: fmtMoney(Math.max(0, b.usual.amt - b.sales.amt)) };
    const intro = pick(`branch_${trend}`, introVars);
    if (intro) lines.push(intro);
    lines.push(...departmentLines(f, b.key, pick));
    // Воронка филиала — только когда она заметно отличается от обычной.
    const bbr = b.usualBooks.n >= 5 ? b.books.n / b.usualBooks.n : 1;
    if (bbr < 0.75) lines.push(color(GREY, `Брони в филиале проседают: ${int(b.books.n)} против обычных ${int(b.usualBooks.n)}.`));
    else if (bbr > 1.3) lines.push(color(GREY, `Броней больше обычного: ${int(b.books.n)} против ${int(b.usualBooks.n)} — задел на завтра.`));
    out.push(lines.join(' '));
    out.push('');
  }

  // Товары.
  const goods = goodsLines(f, pick);
  if (goods.length) { out.push('[B]По товарам[/B]'); out.push(...goods); out.push(''); }

  // Люди.
  const heroes = f.managers
    .filter(m => m.sales.amt >= 5e5)
    .sort((a, b) => b.sales.amt - a.sales.amt).slice(0, 3)
    .map(m => {
      // Кратность к плану дня — только при внятном плане (≥ 300 тыс.) и в разумных
      // пределах: «×9» у человека с крошечным планом выпячивать нечестно.
      const k = m.plan && m.plan >= 3e5 ? m.sales.amt / m.plan : null;
      const tail = k && k >= 1.5 && k <= 5 ? `, ×${k.toFixed(1).replace('.', ',')} к плану дня` : '';
      return `${user(m)} (${shortBranch(m.branch)}, ${m.dept}) — ${fmtMoney(m.sales.amt)}${m.sales.n > 1 ? `, ${int(m.sales.n)} сд.` : ''}${tail}`;
    });
  if (heroes.length) out.push(pick('heroes', { list: heroes.join('; ') }));
  const zeros = f.managers
    .filter(m => m.active && m.sales.n === 0 && (m.plan ?? 0) > 1.5e5 && m.usual.amt > 1e5)
    .sort((a, b) => (b.plan ?? 0) - (a.plan ?? 0));
  if (zeros.length) {
    const shown = zeros.slice(0, 5).map(user);
    const more = zeros.length > 5 ? ` и ещё ${zeros.length - 5}` : '';
    out.push(pick('zeros', { list: `${shown.join(', ')}${more} — [URL=${baseUrl}/sales]список в отчёте[/URL]`, count: String(zeros.length) }));
  }
  if (heroes.length || zeros.length) out.push('');

  // Вечер: темп месяца.
  if (f.month) {
    out.push('[B]Месяц[/B]');
    out.push(paceLine('продажам', f.month.company.sales, f.month.workdayNum, f.month.workdaysInMonth, pick));
    out.push(paceLine('отгрузкам', f.month.company.shipments, f.month.workdayNum, f.month.workdaysInMonth, pick));
    const parts = f.month.branches
      .filter(b => b.sales.plan > 0 && b.sales.share != null)
      .map(b => `${b.name} ${pct(b.sales.share! * 100)} %${b.sales.typicalShare ? ` (обычно ${pct(b.sales.typicalShare * 100)})` : ''}`);
    if (parts.length) out.push(color(GREY, `По продажам филиалы: ${parts.join(' · ')}.`));
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

function shortBranch(branch: string): string {
  return branch === 'СПб' ? 'СПб' : branch === 'Москва/МО' ? 'Москва' : BRANCH_LABEL[branch] ?? branch;
}

type Pick = (key: string, vars?: Record<string, string>) => string;

function departmentLines(f: HowAreWeFacts, branch: string, pick: Pick): string[] {
  // Существенные отделы: план дня или обычный уровень от 300 тыс.
  const depts = f.departments.filter(d => d.branch === branch && ((d.plan ?? 0) >= 3e5 || d.usual.amt >= 3e5));
  if (!depts.length) return [];
  const withP = depts.map(d => ({ d, p: d.plan ? d.sales.amt / d.plan : null }));
  const lines: string[] = [];

  // Лидер: лучший процент плана, если он хоть чего-то стоит.
  const leader = withP.filter(x => x.p != null && x.p >= 0.5).sort((a, b) => b.p! - a.p!)[0];
  if (leader) {
    const top = f.managers.filter(m => m.branch === branch && m.dept === leader.d.name && m.sales.amt >= 3e5)
      .sort((a, b) => b.sales.amt - a.sales.amt).slice(0, 2)
      .map(m => `${surname(m.name)} ${fmtMoney(m.sales.amt)}${m.sales.n > 1 ? ` ${int(m.sales.n)} сд.` : ''}`);
    lines.push(pick('dept_leader', {
      dept: leader.d.name, pct: pct(leader.p! * 100), fact: fmtMoney(leader.d.sales.amt), plan: fmtMoney(leader.d.plan!),
      deals: int(leader.d.sales.n), usual_deals: int(leader.d.usual.n), deals_w: dealsWord(leader.d.sales.n), usual_deals_w: dealsWord(leader.d.usual.n),
      top: top.length ? ` — ${top.join(', ')}` : '',
    }));
  }

  // Тревога: сильно ниже своего обычного (отдел заметный).
  const alarm = withP.filter(x => x.d !== leader?.d && x.d.usual.amt >= 1e6 && x.d.sales.amt / x.d.usual.amt < 0.4)
    .sort((a, b) => (a.d.sales.amt / a.d.usual.amt) - (b.d.sales.amt / b.d.usual.amt))[0];
  if (alarm) {
    const names = f.managers.filter(m => m.branch === branch && m.dept === alarm.d.name && m.sales.n === 0 && m.usual.amt >= 2e5)
      .sort((a, b) => b.usual.amt - a.usual.amt).slice(0, 3).map(m => surname(m.name));
    lines.push(pick('dept_alarm', {
      dept: alarm.d.name, fact: fmtMoney(alarm.d.sales.amt), usual: fmtMoney(alarm.d.usual.amt),
      names: cap(names.length ? names.join(', ') : 'несколько менеджеров'),
    }));
  }

  // Отстающие — одной фразой; нули с планом — отдельно.
  const lagging = withP.filter(x => x.d !== leader?.d && x.d !== alarm?.d && x.p != null && x.p < 0.25 && x.d.sales.n > 0 && (x.d.plan ?? 0) >= 5e5)
    .sort((a, b) => a.p! - b.p!).slice(0, 4);
  if (lagging.length) {
    lines.push(pick('dept_lagging', {
      list: lagging.map((x, i) => i === 0
        ? `${x.d.name} ${pct(x.p! * 100)} % плана (${fmtMoney(x.d.sales.amt)} из ${fmtMoney(x.d.plan!)})`
        : `${x.d.name} ${pct(x.p! * 100)} %`).join(', '),
    }));
  }
  const zeros = withP.filter(x => x.d !== alarm?.d && x.d.sales.n === 0 && (x.d.plan ?? 0) >= 5e5).slice(0, 2);
  for (const z of zeros) {
    lines.push(pick('dept_zero', { dept: z.d.name, plan: fmtMoney(z.d.plan!), usual: fmtMoney(z.d.usual.amt) }));
  }
  return lines;
}

function goodsLines(f: HowAreWeFacts, pick: Pick): string[] {
  const notable = f.groups.filter(g => g.usual.n >= 2 && g.usual.amt >= 2e5);
  const ups = notable.filter(g => g.ratio >= 1.8 && g.today.amt >= 5e5).sort((a, b) => b.today.amt - a.today.amt).slice(0, 3);
  const downs = notable.filter(g => g.ratio <= 0.4).sort((a, b) => (b.usual.amt - b.today.amt) - (a.usual.amt - a.today.amt)).slice(0, 4);
  const lines: string[] = [];
  for (const g of ups) {
    lines.push(`${color(GREEN, '⬆')} ${pick('goods_up', vars(g))}`);
  }
  for (const g of downs) {
    lines.push(`${color(RED, '⬇')} ${pick(g.today.n === 0 ? 'goods_zero' : 'goods_down', vars(g))}`);
  }
  return lines;
  function vars(g: HowAreWeFacts['groups'][number]) {
    return {
      group: g.group, branch: branchLoc(g.branch), fact: fmtMoney(g.today.amt), usual: fmtMoney(g.usual.amt),
      deals: int(g.today.n), usual_deals: int(g.usual.n), deals_w: dealsWord(g.today.n), usual_deals_w: dealsWord(g.usual.n),
    };
  }
}
function branchLoc(b: string): string { return b === 'СПб' ? 'Питере' : b === 'Москва/МО' ? 'Москве' : b === 'Краснодар' ? 'Краснодаре' : b; }

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

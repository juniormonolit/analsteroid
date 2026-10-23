// Связки, просьбы и анкеты в разборе звонков (решения владельца 23.10, BACKLOG «Повторка: связки, анкеты и ИИ»).
//
// Разделение труда: ФАКТЫ считает код (что отгружали за 12 мес, ручные приоритеты /cross-sell к этим
// группам, отгружали ли их, какие сделки с ними есть и в каком состоянии, вопросы анкет), модель только
// ищет в речи (предлагали ли — цитата и дата, что ответил клиент, что клиент просил сам, ответы на вопросы
// анкеты по id), код проверяет ответ (группы и id — только из выданных, варианты — только из анкеты,
// цитаты — по расшифровкам) и сверяет просьбы со сделками: была ли после просьбы сделка с этой группой,
// в работе — ок, закрыта — стадия и цитата клиента. Видно, недоработка менеджера или не прошли по цене.
// Формулировки обезличенные: «не было предложено», «заказчику не предложили».
import { fetchCrossSellPriorities } from '@/features/customers/engine/crossSell';
import { PROPOSE_ASK_MARK } from './memo';
import { fetchQuestionnaires, looksLikeCheckText, COMMON_GROUP, type GroupQuestion } from '@/features/questionnaires/engine/questions';
import { systemDb } from '@/lib/db/clients';
import type { ClientCallData, CollectedDeal } from './collect';
import { verifyQuotes } from './verify';

const SHIPPED_MONTHS = 12;

export interface PairFact {
  from: string; to: string;
  /** Отгружали ли «to» заказчику за всю историю и когда последний раз. */
  shippedEver: boolean; lastShipped: string | null;
  /** Сделки с группой «to» (любые, по дате создания). */
  deals: { dealId: number; createdAt: string | null; state: CollectedDeal['state']; stage: string | null }[];
}
/** audience (migrations/251): 'client' — вопрос клиенту («спрошено? ответ?» → анкета карточки); 'manager_check' —
 *  проверка менеджера («Менеджер предложил бесплатного замерщика»): сделал ли в разговоре — только отчёт РОПу. */
export interface QuestionFact { id: number; group: string; question: string; kind: GroupQuestion['kind']; options: string[]; audience: 'client' | 'manager_check' }
export interface LinksFacts {
  shipped12: string[];
  pairs: PairFact[];
  /** Вопросы анкет отгруженных групп + общие — их проверяет модель. */
  questions: QuestionFact[];
  /** Анкеты групп, которые предлагаем (не отгружали): 2–3 вопроса клиенту под строкой «Предложить»
   *  («если нужна — уточнить:»), модели не даём. В «Выяснить» не идут (владелец 23.10, кейс 39547). */
  askForProposed: { group: string; questions: string[] }[];
}

/** Вопросов под строкой «Предложить» — не больше (по предложениям: в анкете один пункт бывает «Объём? Плотность?
 *  Толщина?»); обязательные пункты первыми, повторы «Выяснить» и других групп отброшены до лимита. */
const PROPOSED_QUESTIONS = 3;

/** «Уточнил, что строится?», «Предложил бетон?» — по смыслу проверка менеджера, даже если в анкете стоит
 *  audience = 'client' (данные на проде поправят не сразу). В задачу такие не берём никогда. Признак — единый
 *  с подсказкой редактора анкет (questionnaires/engine/types.ts). */
const looksLikeManagerCheck = looksLikeCheckText;

/** Почти одинаковые вопросы разных групп: нормализация + пересечение слов (по основе 5 букв) ≥ 0,6. */
const STOP = new Set(['или', 'для', 'что', 'как', 'вам', 'вас', 'нужно', 'нужен', 'нужна', 'нужны', 'ли', 'это', 'там', 'уже', 'ещё', 'еще', 'под']);
function wordSet(q: string): Set<string> {
  return new Set(q.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter(w => w.length > 2 && !STOP.has(w)).map(w => w.slice(0, 5)));
}
export function similarQuestion(a: string, b: string): boolean {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size || !B.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.6;
}

const ddmm = (iso: string | null) => (iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '—');

export async function buildLinksFacts(data: ClientCallData): Promise<LinksFacts> {
  const since = new Date(Date.now() - SHIPPED_MONTHS * 30.4 * 86_400_000).toISOString().slice(0, 10);
  const shippedAll = new Map<string, string>(); // группа → последняя дата отгрузки
  const shipped12 = new Set<string>();
  for (const d of data.deals) if (d.state === 'shipped' && d.deliveredAt) {
    for (const g of d.groups) {
      if (!shippedAll.has(g) || d.deliveredAt > shippedAll.get(g)!) shippedAll.set(g, d.deliveredAt);
      if (d.deliveredAt >= since) shipped12.add(g);
    }
  }
  const priorities = await fetchCrossSellPriorities().catch(() => ({} as Record<string, (string | null)[]>));
  const pairs: PairFact[] = [];
  const seen = new Set<string>();
  for (const from of [...shipped12].sort()) {
    for (const to of priorities[from] ?? []) {
      if (!to || to === from || seen.has(`${from}→${to}`)) continue;
      seen.add(`${from}→${to}`);
      pairs.push({
        from, to,
        shippedEver: shippedAll.has(to), lastShipped: shippedAll.get(to) ?? null,
        deals: data.deals.filter(d => d.groups.includes(to)).map(d => ({ dealId: d.dealId, createdAt: d.createdAt, state: d.state, stage: d.stage })),
      });
    }
  }
  const proposed = [...new Set(pairs.filter(p => !shipped12.has(p.to)).map(p => p.to))];
  const qs = await fetchQuestionnaires([...shipped12, COMMON_GROUP, ...proposed]).catch(() => new Map<string, GroupQuestion[]>());
  const questions: QuestionFact[] = [];
  for (const g of [...shipped12, COMMON_GROUP]) for (const q of qs.get(g) ?? []) {
    if (q.id !== null) questions.push({ id: q.id, group: g, question: q.question, kind: q.kind, options: q.options, audience: q.audience === 'manager_check' ? 'manager_check' : 'client' });
  }
  const askForProposed = proposed
    .map(g => ({
      group: g,
      questions: (qs.get(g) ?? []).filter(q => q.audience !== 'manager_check' && !looksLikeManagerCheck(q.question))
        .map((q, i) => ({ q, i })).sort((a, b) => Number(b.q.required) - Number(a.q.required) || a.i - b.i)
        .map(x => x.q.question),
    }))
    .filter(x => x.questions.length);
  return { shipped12: [...shipped12], pairs, questions, askForProposed };
}

/** Блок данных для модели (в пользовательской части, после звонков). */
export function linksText(f: LinksFacts): string {
  const out: string[] = ['', '## Связки (посчитано кодом)'];
  if (!f.pairs.length) out.push('- Связок нет: по отгруженным за 12 мес группам приоритеты не настроены.');
  for (const p of f.pairs) {
    const deals = p.deals.length ? p.deals.map(d => `#${d.dealId} от ${ddmm(d.createdAt)} — ${d.state === 'shipped' ? 'отгружена' : d.state === 'lost' ? `закрыта: ${d.stage ?? ''}` : `в работе: ${d.stage ?? ''}`}`).join('; ') : 'сделок нет';
    out.push(`- «${p.from}» → «${p.to}»: ${p.shippedEver ? `отгружали, последний раз ${ddmm(p.lastShipped)}` : 'не отгружали'}; сделки с «${p.to}»: ${deals}`);
  }
  out.push('', '## Анкета (вопросы по отгруженным группам и общие)');
  if (!f.questions.length) out.push('- Анкет по этим группам нет — раздел пропусти (questions: []).');
  for (const q of f.questions) {
    if (q.audience === 'manager_check') {
      out.push(`- Q${q.id} [${q.group === COMMON_GROUP ? 'общий' : q.group}; ПРОВЕРКА МЕНЕДЖЕРА — asked: сделал ли это менеджер в разговоре, quote — цитата] ${q.question}`);
      continue;
    }
    const opts = q.kind === 'text' ? 'свободный ответ' : `${q.kind === 'single' ? 'один вариант' : 'несколько вариантов'} из: ${q.options.join(' | ')}`;
    out.push(`- Q${q.id} [${q.group === COMMON_GROUP ? 'общий' : q.group}; вопрос клиенту; ${opts}] ${q.question}`);
  }
  return out.join('\n');
}

// ── Ответ модели (раздел «### 10. Данные») → проверенные данные ────────────────────────────────────
type Offered = 'yes' | 'no' | 'unclear';
type Answer = 'yes' | 'no' | 'later' | 'bought_elsewhere' | 'none';
export interface PairResult { from: string; to: string; offered: Offered; quote: string | null; date: string | null; answer: Answer; answerQuote: string | null; quoteFound: boolean; callId: string | null }
export interface RequestResult {
  group: string; quote: string; date: string | null; quoteFound: boolean; callId: string | null;
  /** Сверка кодом: сделки с группой после просьбы. */
  check: 'shipped' | 'in_work' | 'closed' | 'no_deal';
  dealId: number | null; stage: string | null; reasonQuote: string | null;
}
export interface QuestionResult { id: number; question: string; audience: 'client' | 'manager_check'; asked: 'yes' | 'no' | 'unclear'; answerText: string | null; answerOptions: string[]; quote: string | null; date: string | null; quoteFound: boolean; callId: string | null; calledAt: string | null }
export interface LinksResult {
  pairs: PairResult[]; requests: RequestResult[]; questions: QuestionResult[]; askForProposed: LinksFacts['askForProposed']; parseError: string | null;
  /** Готовые строки для текста задачи — считаются при анализе (analyze.ts), вопросам нужны тексты анкет. */
  propose?: string[]; clarify?: string[];
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 400) : null);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => (allowed.includes(v as T) ? v as T : dflt);
/** «ДД.ММ» или «ДД.ММ.ГГГГ» → ISO-дата (год — по ближайшему прошлому). */
function dateIso(v: unknown): string | null {
  const m = typeof v === 'string' ? v.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/) : null;
  if (!m) return null;
  const now = new Date();
  let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : now.getFullYear();
  const iso = (yy: number) => `${yy}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (!m[3] && iso(y) > now.toISOString().slice(0, 10)) y--;
  return iso(y);
}

function extractJson(md: string): unknown | null {
  const sec = md.split(/^#{2,4}\s*10\.\s*[^\n]*$/m)[1] ?? md;
  const block = sec.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? sec.match(/\{[\s\S]*\}/)?.[0];
  if (!block) return null;
  try { return JSON.parse(block); } catch { return null; }
}

export function checkLinks(md: string, facts: LinksFacts, data: ClientCallData): LinksResult {
  const raw = extractJson(md) as { pairs?: unknown[]; requests?: unknown[]; questions?: unknown[] } | null;
  const base: LinksResult = { pairs: [], requests: [], questions: [], askForProposed: facts.askForProposed, parseError: null };
  if (!raw || typeof raw !== 'object') return { ...base, parseError: 'Раздел «Данные» не разобран' };
  const quoteOf = (q: string | null): { found: boolean; callId: string | null; calledAt: string | null } => {
    if (!q) return { found: false, callId: null, calledAt: null };
    const r = verifyQuotes(`«${q}»`, data.calls, data.deals)[0];
    return r ? { found: r.found, callId: r.callId, calledAt: r.calledAt } : { found: false, callId: null, calledAt: null };
  };

  const pairKeys = new Map(facts.pairs.map(p => [`${p.from}→${p.to}`.toLowerCase(), p]));
  for (const x of Array.isArray(raw.pairs) ? raw.pairs as Record<string, unknown>[] : []) {
    const p = pairKeys.get(`${str(x.from)}→${str(x.to)}`.toLowerCase());
    if (!p) continue; // только пары, которые выдал код
    const quote = str(x.quote);
    const v = quoteOf(quote);
    base.pairs.push({
      from: p.from, to: p.to, offered: oneOf(x.offered, ['yes', 'no', 'unclear'] as const, 'unclear'), quote, date: str(x.date),
      answer: oneOf(x.answer, ['yes', 'no', 'later', 'bought_elsewhere', 'none'] as const, 'none'), answerQuote: str(x.answer_quote),
      quoteFound: v.found, callId: v.callId,
    });
  }
  // Пары без ответа модели — «нет данных», чтобы в задаче было видно, что связку не проверили.
  for (const p of facts.pairs) if (!base.pairs.some(r => r.from === p.from && r.to === p.to)) {
    base.pairs.push({ from: p.from, to: p.to, offered: 'unclear', quote: null, date: null, answer: 'none', answerQuote: null, quoteFound: false, callId: null });
  }

  for (const x of Array.isArray(raw.requests) ? raw.requests as Record<string, unknown>[] : []) {
    const group = str(x.group); const quote = str(x.quote);
    if (!group || !quote) continue;
    const v = quoteOf(quote);
    const when = dateIso(x.date) ?? (v.calledAt ? v.calledAt.slice(0, 10) : null);
    // Сверка кодом: сделки с этой группой — созданные не раньше чем за 7 дней до просьбы или отгруженные
    // после неё (дозаказ часто дописывают в уже открытую сделку: «Алтай» 30.09 → сделка от 26.09, отгрузка 12.10).
    const from = when ? new Date(Date.parse(when) - 7 * 86_400_000).toISOString().slice(0, 10) : null;
    const after = data.deals.filter(d => d.groups.some(g => g.toLowerCase() === group.toLowerCase())
      && (!when || (d.createdAt ?? '') >= from! || (!!d.deliveredAt && d.deliveredAt >= when)));
    const shipped = after.find(d => d.state === 'shipped'), open = after.find(d => d.state === 'open'), lost = after.find(d => d.state === 'lost');
    const pick = shipped ?? open ?? lost ?? null;
    base.requests.push({
      group, quote, date: when, quoteFound: v.found, callId: v.callId,
      check: shipped ? 'shipped' : open ? 'in_work' : lost ? 'closed' : 'no_deal',
      dealId: pick?.dealId ?? null, stage: pick?.stage ?? null, reasonQuote: str(x.reason_quote),
    });
  }

  // Одна просьба на группу — самая поздняя (модель повторяет группу по нескольким звонкам).
  const byGroup = new Map<string, RequestResult>();
  for (const r of base.requests) {
    const k = r.group.toLowerCase(), prev = byGroup.get(k);
    if (!prev || (r.date ?? '') > (prev.date ?? '')) byGroup.set(k, r);
  }
  base.requests = [...byGroup.values()];

  const qById = new Map(facts.questions.map(q => [q.id, q]));
  for (const x of Array.isArray(raw.questions) ? raw.questions as Record<string, unknown>[] : []) {
    const id = Number(String(x.id ?? '').replace(/^Q/i, ''));
    const q = qById.get(id);
    if (!q) continue;
    const asked = oneOf(x.asked, ['yes', 'no', 'unclear'] as const, 'unclear');
    // single/multi — только варианты анкеты (без учёта регистра); остальное отбрасываем.
    const opts = Array.isArray(x.options) ? (x.options as unknown[]).map(o => String(o).trim()) : [];
    const answerOptions = q.kind === 'text' ? [] : opts.map(o => q.options.find(v => v.toLowerCase() === o.toLowerCase())).filter((o): o is string => !!o);
    const answerOptionsCut = q.audience === 'manager_check' ? [] : q.kind === 'single' ? answerOptions.slice(0, 1) : answerOptions;
    const quote = str(x.quote);
    const v = quoteOf(quote);
    base.questions.push({
      id, question: q.question, audience: q.audience, asked, answerText: q.audience === 'client' && q.kind === 'text' ? str(x.answer) : null, answerOptions: answerOptionsCut,
      quote, date: str(x.date), quoteFound: v.found, callId: v.callId, calledAt: v.calledAt,
    });
  }
  return base;
}

// ── Текст задачи: «Предложить» и «Выяснить» (обезличенно, без слов про ИИ) ─────────────────────────
export function proposeLines(r: LinksResult, shipped12: string[] = [], clarify: string[] = []): string[] {
  const out: string[] = [];
  const taken = new Set(shipped12.map(g => g.toLowerCase()));
  const used = clarify.map(l => l.replace(/^—\s*/, ''));
  /** Под строкой группы — 2–3 вопроса её анкеты (без повторов «Выяснить» и других групп). */
  const ask = (group: string) => {
    const qs = (r.askForProposed.find(x => x.group === group)?.questions ?? [])
      .filter(q => !looksLikeManagerCheck(q) && !used.some(u => similarQuestion(u, q)));
    const parts: string[] = [];
    for (const q of qs) {
      if (parts.length >= PROPOSED_QUESTIONS) break;
      used.push(q);
      for (const one of q.split(/(?<=[?.!])\s+/).map(x => x.trim().replace(/[.!]+$/, '')).filter(Boolean)) {
        if (parts.length >= PROPOSED_QUESTIONS) break;
        const low = /^[А-ЯЁA-Z][а-яёa-z]/.test(one) ? one[0].toLowerCase() + one.slice(1) : one;
        parts.push(/\?$/.test(low) ? low : low + '?');
      }
    }
    if (parts.length) out.push(`${PROPOSE_ASK_MARK} ${parts.join(' ')}`);
  };
  for (const q of r.requests) {
    if (q.check === 'no_deal') out.push(`— ${q.group}: заказчик сам говорил, что нужно (${q.date ? ddmm(q.date).slice(0, 5) : 'в разговоре'}) — сделки после этого не было`);
    else if (q.check === 'closed') out.push(`— ${q.group}: просил, сделка #${q.dealId} закрыта (${q.stage ?? 'отказ'})${q.reasonQuote ? ` — «${q.reasonQuote}»` : ''}; предложить ещё раз`);
    else continue;
    ask(q.group);
  }
  for (const p of r.pairs) {
    // Уже брал эту группу за 12 мес — не «предложить», это шум (замечание к прогону v8 23.10).
    if (out.some(l => l.startsWith(`— ${p.to}:`)) || taken.has(p.to.toLowerCase())) continue;
    if (p.offered === 'no' || p.offered === 'unclear') out.push(`— ${p.to}: по «${p.from}» заказчику не предложили`);
    else if (p.answer === 'later') out.push(`— ${p.to}: предлагали${p.date ? ` ${p.date}` : ''}, ответил «позже» — вернуться`);
    else continue;
    ask(p.to);
  }
  return out;
}

/** «Выяснить» — только вопросы КЛИЕНТУ анкет отгруженных групп + общих, на которые в разговорах нет ответа.
 *  Анкеты предлагаемых групп — под их строкой «Предложить» (proposeLines), не здесь. */
export function clarifyLines(r: LinksResult, facts: Pick<LinksFacts, 'questions'>): string[] {
  const asked = new Map(r.questions.map(q => [q.id, q]));
  const out: string[] = [];
  const seen: string[] = [];
  const push = (line: string, key: string) => { if (!seen.some(s => similarQuestion(s, key))) { seen.push(key); out.push(line); } };
  for (const q of facts.questions) {
    // Проверка менеджера (по полю или по смыслу) — не поручение «выяснить».
    if (q.audience === 'manager_check' || looksLikeManagerCheck(q.question)) continue;
    const a = asked.get(q.id);
    // Ответ уже есть (спросил менеджер или клиент сказал сам) — выяснять нечего.
    if (a && (a.answerText || a.answerOptions.length)) continue;
    push(`— ${q.question}`, q.question);
  }
  return out;
}

/** Группы, которые заказчик сам просил (последний разбор каждого заказчика за 90 дней) — первый ярус
 *  «Что можно предложить» на доске (potentialGroups input.requests). Ключ — client_ref (c<contact>|k<company>). */
export async function fetchRequestedGroups(): Promise<Map<string, string[]>> {
  const r = await systemDb().query<{ client_ref: string; reqs: { group: string; check: string }[] | null }>(
    `SELECT DISTINCT ON (client_ref) client_ref, parsed->'links'->'requests' AS reqs
       FROM ai_analyses
      WHERE status = 'done' AND NOT is_test AND kind = 'client' AND created_at >= now() - interval '90 days'
      ORDER BY client_ref, created_at DESC`,
  ).catch(() => ({ rows: [] as { client_ref: string; reqs: { group: string; check: string }[] | null }[] }));
  const out = new Map<string, string[]>();
  for (const row of r.rows) {
    const groups = (row.reqs ?? []).filter(q => q.check !== 'shipped').map(q => q.group);
    if (groups.length) out.set(row.client_ref, [...new Set(groups)]);
  }
  return out;
}


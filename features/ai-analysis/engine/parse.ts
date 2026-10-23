// Разбор отчёта модели кодом (этап 2): тип заказчика, вердикты по 8 критериям, итоговый балл,
// найденные нарушения. `\w` в JS не видит кириллицу — везде явный [а-яё]. Отчёт — markdown с фиксированными разделами «### N.» (prompt.ts), поэтому
// хватает регулярок; не распозналось — поле null, сводка такие отчёты просто не учитывает.
// Чистые функции — нужны и воркеру (сохранить parsed), и вкладке.

export type CriterionVerdict = 'yes' | 'partial' | 'no' | 'na';
// «Оплата мимо компании» и «представился не от Монолита» убраны 23.10 (владелец: ложные срабатывания —
// переводы водителю за доставку, несколько брендов компании). В старых отчётах встречаются — не считаем.
export type ViolationKind = 'signature' | 'rude' | 'promise' | 'refusal' | 'unhappy';

export interface ParsedReport {
  /** Значение CLIENT_TYPES карточки клиента (features/client-module/engine/types.ts). */
  clientType: string | null;
  /** Индекс = номер критерия − 1 (8 штук), null — не распознан. */
  criteria: (CriterionVerdict | null)[];
  score: number | null;
  violations: ViolationKind[];
  /** Связки/просьбы/анкета (links.ts:checkLinks), с v8. */
  links?: import('./links').LinksResult | null;
}

export const CRITERIA_LABELS = [
  'Выяснил тип заказчика', 'Спросил, что строит, и тип дома', 'Выяснил стадию стройки', 'Предложил следующий материал по цепочке',
  'Рассказал про ассортимент', 'Выяснил, что нужно и когда', 'Договорился о следующем шаге', 'При отказе выяснил причину',
] as const;

export const VIOLATION_LABELS: Record<ViolationKind, string> = {
  signature: 'Подпись за клиента',
  rude: 'Грубость, давление, пустые обещания',
  promise: 'Обещание без исполнения',
  refusal: 'Отказ не подтверждён звонками',
  unhappy: 'Клиент недоволен / ушёл к конкуренту',
};

const VIOLATION_MATCH: [ViolationKind, RegExp][] = [
  ['signature', /подпис[а-яё]* (документов )?за клиента|распишусь/i],
  ['rude', /грубост|мат |давлени/i],
  ['promise', /обещани[а-яё]* (клиенту )?без|без видимого исполн|исполнение которого/i],
  ['refusal', /отказ.{0,20}(без оснований|не подтвержд)|ОТКАЗ НЕ ПОДТВЕРЖД/i],
  ['unhappy', /недовол|угрожает уйти|ушёл к конкурент|ушел к конкурент/i],
];

// Порядок важен: «середина/финал» раньше общего «строит себе».
const TYPE_MATCH: [string, RegExp][] = [
  ['self_builder_late', /строит себе\s*[—–-]\s*(середина|финал|окончани)|середина\s*\/\s*финал/i],
  ['self_builder', /строит себе\s*[—–-]\s*начал|строит себе/i],
  ['own_needs_org', /организация под собственные|под собственные не строительные/i],
  ['construction_org', /строительн[а-яё]* организаци/i],
  ['foreman', /прораб/i],
];

function section(md: string, n: number): string {
  const parts = md.split(/^#{2,4}\s*(\d{1,2})\.\s*[^\n]*$/m);
  for (let i = 1; i < parts.length; i += 2) if (Number(parts[i]) === n) return parts[i + 1];
  return '';
}

function verdictOf(s: string): CriterionVerdict | null {
  const u = s.toUpperCase();
  if (/НЕПРИМЕНИМО|НЕ ПРИМЕНИМО/.test(u)) return 'na';
  if (/ЧАСТИЧНО/.test(u)) return 'partial';
  if (/(^|[^А-ЯЁ])НЕТ([^А-ЯЁ]|$)/.test(u)) return 'no';
  if (/(^|[^А-ЯЁ])ДА([^А-ЯЁ]|$)/.test(u)) return 'yes';
  return null;
}

export function parseReport(md: string): ParsedReport {
  // Тип — по строке «Тип: …» в разделе 1, иначе по первому упоминанию в разделе.
  const who = section(md, 1);
  const typeLine = who.match(/тип[^:\n]{0,20}:\s*([^\n]+)/i)?.[1] ?? who;
  // Тип, упомянутый в строке первым: «Прораб (не строительная организация)» — прораб.
  let clientType: string | null = null, at = Infinity;
  for (const [t, re] of TYPE_MATCH) {
    const i = typeLine.search(re);
    if (i >= 0 && i < at) { at = i; clientType = t; }
  }

  const crit: (CriterionVerdict | null)[] = Array(8).fill(null);
  for (const line of section(md, 5).split('\n')) {
    const m = line.match(/^\s*[-*]?\s*\**\s*([1-8])[.)]\s*(.+)$/);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    if (crit[i] !== null) continue;
    // Вердикт — после «—»/«:» в начале строки, до цитаты.
    const head = m[2].replace(/«[^»]*»/g, '').slice(0, 160);
    crit[i] = verdictOf(head.split(/[—–:]/).slice(1).join(' ') || head);
  }

  // «Итоговый балл: 4 из 7 = 0,57» (v3) или «Балл: (5 ДА + 2×0,5)/7 = 6/7 ≈ 0,86» / «≈ 56%» (v2):
  // последнее число строки со словом «балл».
  const scoreLine = section(md, 5).split('\n').find(l => /балл/i.test(l)) ?? '';
  const nums = [...scoreLine.replace(/«[^»]*»/g, '').matchAll(/(\d+(?:[.,]\d+)?)\s*(%?)/g)];
  const lastNum = nums[nums.length - 1];
  let score = lastNum ? Number(lastNum[1].replace(',', '.')) : null;
  if (score !== null && lastNum?.[2] === '%') score = score / 100;
  if (score !== null && score > 1 && score <= 100) score = score / 100; // «56%»
  if (score !== null && (Number.isNaN(score) || score < 0 || score > 1)) score = null;

  const violations = new Set<ViolationKind>();
  for (const line of section(md, 6).split('\n')) {
    if (!/НАЙДЕНО|НЕ ПОДТВЕРЖД/i.test(line) || /НЕ НАЙДЕНО/i.test(line)) continue;
    // «СЛАБО/ЧАСТИЧНО НАЙДЕНО» — сигнал для РОПа во вкладке, но не нарушение в сводке (аудит 23.10).
    if (/(СЛАБО|ЧАСТИЧНО)\s*НАЙДЕНО/i.test(line)) continue;
    for (const [kind, re] of VIOLATION_MATCH) if (re.test(line)) { violations.add(kind); break; }
  }

  return { clientType, criteria: crit, score, violations: [...violations] };
}

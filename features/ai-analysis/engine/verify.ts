// Проверка цитат отчёта по расшифровкам (консультация 22.10: «РОП не поймёт, где модель выдумала»).
// Каждую «цитату» из отчёта ищем в текстах звонков: дословно после нормализации, иначе — по
// совпадению идущих подряд слов (распознавание и модель слегка меняют формы слов). Найдена —
// UI ставит «✓ звонок от 02.10» и подсвечивает фрагмент; нет — «⚠ цитата не найдена».
//
// Не всё в «ёлочках» — цитаты из звонков: модель так же оформляет вопросы скрипта из цепочки
// материалов, типы заказчика, названия стадий и товаров. Такие — kind 'reference', не проверяем.
// Склейки через «…» («оплата переводом… на карту кинет») проверяем по кускам: каждый кусок должен
// найтись в одном и том же звонке.
import { MATERIAL_CHAIN } from '@/features/client-module/engine/chain';
import type { CollectedCall, CollectedDeal } from './collect';

export type QuoteKind = 'call' | 'reference';
export interface QuoteCheck { quote: string; kind: QuoteKind; found: boolean; callId: string | null; calledAt: string | null; score: number }

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
/** Слово без окончания — «привезли/привезём», «плиты/плит» считаем одним. */
const stem = (w: string) => (w.length > 5 ? w.slice(0, w.length - 2) : w);
const words = (s: string) => norm(s).split(' ').filter(Boolean).map(stem);

const MIN_QUOTE_WORDS = 3;
const MIN_PIECE_WORDS = 2;
const MATCH_THRESHOLD = 0.7;
const REFERENCE_THRESHOLD = 0.6;

const FIXED_REFERENCES = [
  'Прораб', 'Строительная организация', 'Строит себе — начало стройки', 'Строит себе — середина/финал',
  'Организация под собственные не строительные нужды', 'Объектов больше нет', 'Больше ничего не нужно',
  'Дорого, предложил другие материалы', 'Подвели клиента — не хочет с нами работать',
  'ОТКАЗ НЕ ПОДТВЕРЖДЁН ЗВОНКАМИ', 'сплошной текст, без ролей', 'без ролей', 'компания Монолит',
];

export function extractQuotes(md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(/«([^«»\n]{6,240})»/g)) {
    const q = m[1].trim();
    if (norm(q).split(' ').length >= MIN_QUOTE_WORDS) out.add(q);
  }
  return [...out];
}

/** Доля слов куска, найденных в тексте одним окном (допускаем пропуск слова в цитате и вставки в речи). */
function bestRun(q: string[], text: string[]): number {
  if (!q.length) return 0;
  let best = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== q[0] && text[i] !== q[1]) continue;
    let qi = text[i] === q[0] ? 0 : 1, hits = 0;
    for (let j = i; j < Math.min(text.length, i + q.length + 4) && qi < q.length; j++) {
      if (text[j] === q[qi]) { hits++; qi++; }
      else if (qi + 1 < q.length && text[j] === q[qi + 1]) { hits++; qi += 2; }
    }
    best = Math.max(best, hits / q.length);
    if (best === 1) break;
  }
  return best;
}

function referenceTexts(deals: CollectedDeal[]): string[][] {
  const refs = new Set<string>(FIXED_REFERENCES);
  for (const r of MATERIAL_CHAIN) { refs.add(r.ask); refs.add(r.to); refs.add(r.from); }
  for (const d of deals) { if (d.stage) refs.add(d.stage); if (d.group) refs.add(d.group); if (d.name) refs.add(d.name); if (d.products) refs.add(d.products); }
  return [...refs].map(words).filter(w => w.length);
}

export function verifyQuotes(md: string, calls: CollectedCall[], deals: CollectedDeal[] = []): QuoteCheck[] {
  const prepared = calls.map(c => ({ c, flat: norm(c.text), words: words(c.text) }));
  const refs = referenceTexts(deals);
  return extractQuotes(md).map(quote => {
    const pieces = quote.split(/…|\.\.\./).map(words).filter(w => w.length >= MIN_PIECE_WORDS);
    if (!pieces.length) pieces.push(words(quote));
    // Лучший звонок: минимальный по кускам балл (все куски из одного разговора).
    let best = { score: 0, call: null as CollectedCall | null };
    for (const p of prepared) {
      const score = Math.min(...pieces.map(w => (p.flat.includes(w.join(' ')) ? 1 : bestRun(w, p.words))));
      if (score > best.score) best = { score, call: p.c };
      if (score === 1) break;
    }
    if (best.score >= MATCH_THRESHOLD) {
      return { quote, kind: 'call' as const, found: true, callId: best.call!.id, calledAt: best.call!.calledAt, score: Math.round(best.score * 100) / 100 };
    }
    const all = words(quote);
    const isRef = refs.some(r => bestRun(all, r) >= REFERENCE_THRESHOLD || bestRun(r, all) >= 0.9);
    return { quote, kind: isRef ? 'reference' as const : 'call' as const, found: false, callId: null, calledAt: null, score: Math.round(best.score * 100) / 100 };
  });
}

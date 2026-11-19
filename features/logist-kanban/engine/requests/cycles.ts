// Циклы запроса из журнала событий — методика Панели снабжения (lib/supplyPanel/calc.ts buildTask):
// цикл 1 — от отправки до первого ответа; цикл N — от (N−1)-го возврата до следующего ответа.
// Взятие — первое taken в цикле; «отпустил» (released) взятие не сбрасывает (как у задач: держатель сменился,
// но «скорость взятия» уже случилась). Ответ сразу из «Новых» (без taken) — skip_take: takeH = null, execH = null.
// Часы — рабочие (9–18 МСК, без праздников).
import type { CycleInfo, PersonRef } from './contract';
import { workHoursBetween } from './worktime';

export interface CycleEvent {
  at: string; kind: string; actor: PersonRef | null;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

interface Cur { n: number; start: string; take: string | null; answer: string | null; accept: string | null; returnAt: string | null; by: PersonRef | null; implicitTake?: boolean }

export function buildCycles(events: readonly CycleEvent[]): CycleInfo[] {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const out: Cur[] = [];
  let cur: Cur | null = null;
  for (const e of sorted) {
    switch (e.kind) {
      case 'sent':
        if (!cur) cur = { n: 1, start: e.at, take: null, answer: null, accept: null, returnAt: null, by: null };
        break;
      case 'taken': case 'reassigned':
        if (cur && !cur.take && !cur.answer) cur.take = e.at;
        break;
      case 'answered':
        if (cur && !cur.answer) { cur.answer = e.at; cur.by = e.actor; }
        break;
      case 'accepted':
        if (cur && !cur.accept) cur.accept = e.at;
        break;
      case 'returned':
        if (cur) {
          cur.returnAt = e.at;
          out.push(cur);
          cur = { n: cur.n + 1, start: e.at, take: null, answer: null, accept: null, returnAt: null, by: null };
          // возврат идёт к тому же логисту: в работе с момента возврата — execH считается от него,
          // а «скорость взятия» у такого цикла не меряется (takeH = null)
          cur.implicitTake = true;
        }
        break;
    }
  }
  if (cur) out.push(cur);
  return out.map(c => {
    const skipTake = !c.take && !!c.answer;
    const takeAt = c.take ?? (c.implicitTake ? c.start : null);
    return {
      n: c.n, start: c.start, take: takeAt, answer: c.answer, accept: c.accept, returnAt: c.returnAt, by: c.by,
      takeH: c.take && !skipTake && !c.implicitTake ? r3(workHoursBetween(c.start, c.take)) : null,
      execH: takeAt && c.answer ? r3(workHoursBetween(takeAt, c.answer)) : null,
      answerH: c.answer ? r3(workHoursBetween(c.start, c.answer)) : null,
      cycleH: c.accept ? r3(workHoursBetween(c.start, c.accept)) : null,
    };
  });
}

/** Медиана (пусто → null), округление до 0.1. */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  const v = s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  return Math.round(v * 10) / 10;
}

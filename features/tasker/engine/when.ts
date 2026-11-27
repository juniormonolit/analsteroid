// Чистые функции времени Задачника (без БД) — общие для сервера и формы; проверяются scripts/assert-tasker-time.ts.

/** «вт 02.12, 15:00–15:30» по Москве. */
export function fmtWhen(startIso: string, endIso: string): string {
  const wd = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const s0 = new Date(Date.parse(startIso) + 3 * 3600_000);
  const e0 = new Date(Date.parse(endIso) + 3 * 3600_000).toISOString();
  const iso = s0.toISOString();
  return `${wd[s0.getUTCDay()]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}, ${iso.slice(11, 16)}–${e0.slice(11, 16)}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Свободные окна дня (МСК, YYYY-MM-DD) в рабочие часы fromH–toH длиной ≥ durationMin, начало с шагом 15 минут;
 * то, что уже прошло (now + 15 мин), не предлагается. busy — интервалы в мс, могут пересекаться и выходить за день.
 */
export function freeWindows(
  ymd: string, busy: { start: number; end: number }[], durationMin: number, now = Date.now(), fromH = 9, toH = 19,
): { start: number; end: number }[] {
  const dayStart = Date.parse(`${ymd}T${pad(fromH)}:00:00+03:00`);
  const dayEnd = Date.parse(`${ymd}T${pad(toH)}:00:00+03:00`);
  const step = 15 * 60_000;
  let cur = Math.max(dayStart, Math.ceil((now + step) / step) * step);
  const iv = busy.filter(b => b.end > dayStart && b.start < dayEnd).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const b of iv) {
    if (b.start - cur >= durationMin * 60_000) out.push({ start: cur, end: b.start });
    cur = Math.max(cur, Math.ceil(b.end / step) * step);
  }
  if (dayEnd - cur >= durationMin * 60_000) out.push({ start: cur, end: dayEnd });
  return out;
}

/** Даты одной постановки не наслаиваются друг на друга (длительность одна на все). */
export function slotsOverlap(startsMs: number[], durationMin: number): boolean {
  const s = [...startsMs].sort((a, b) => a - b);
  for (let i = 1; i < s.length; i++) if (s[i] < s[i - 1] + durationMin * 60_000) return true;
  return false;
}

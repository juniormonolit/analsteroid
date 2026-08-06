// Текст «Копировать для отчёта» (ЛК менеджера, «Карточка 10.0»).
//
// Сам формат живёт в движке конструктора отчётов
// (features/reports-builder/engine/personalReport.ts) — здесь только переходник
// от PlanFactResult к его входу. Раньше вёрстка и форматирование чисел были
// скопированы сюда из lib/jobs/dailyMoscowReport.ts, и три копии уже начали
// расходиться (см. комментарий в engine/format.ts). Байт-в-байт совпадение
// старого текста с новым проверяется в scripts/assert-report-engine.ts.

import { buildPersonalReportText } from '@/features/reports-builder/engine/personalReport';
import type { PlanFactResult } from './planFact';

export function buildManagerReportText(opts: {
  name: string;
  department?: string | null;
  pf: PlanFactResult;
}): string {
  const { name, department, pf } = opts;
  return buildPersonalReportText({
    name,
    department,
    date: pf.day.fromStr,
    weekFrom: pf.week.fromStr,
    day: pf.day,
    week: pf.week,
    month: pf.month,
    monthExtras: pf.monthExtras,
  });
}

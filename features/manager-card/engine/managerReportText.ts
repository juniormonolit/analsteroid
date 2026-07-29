// Текст «Копировать для отчёта» (ЛК менеджера, «Карточка 10.0»): BB-код в стиле
// ежедневного отчёта «МОСКВА» владельца (lib/jobs/dailyMoscowReport.ts) — жирные
// заголовки блоков, «показатель — значение», разделители «————». Вставляется в
// чат Битрикса как есть.

import type { PlanFactResult, PlanFactBucket } from './planFact';

function fmtMln(v: number, decimals = 1): string {
  return `${(v / 1e6).toFixed(decimals).replace('.', ',')} млн`;
}
function fmtMoney(v: number): string {
  if (Math.abs(v) >= 1_000_000) return fmtMln(v);
  if (Math.abs(v) >= 1_000) return `${Math.round(v / 1000)} тыс`;
  return `${Math.round(v)} ₽`;
}
function fmtPct(fact: number, plan: number | null): string {
  if (plan === null || plan <= 0) return '—';
  return `${Math.round((fact / plan) * 100)}%`;
}
function fmtDateRu(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function bucketBlock(title: string, b: PlanFactBucket): string {
  const lines = [
    `[b]${title}[/b]`,
    `План продаж — ${b.planSales !== null ? fmtMoney(b.planSales) : '—'}`,
    `Сумма продаж — ${fmtMoney(b.salesAmount)}`,
    `% выполнения — ${fmtPct(b.salesAmount, b.planSales)}`,
    `Продажи — ${b.salesCount} шт`,
    `Брони — ${b.reservationsCount} шт${b.reservationsAmount > 0 ? ` (${fmtMoney(b.reservationsAmount)})` : ''}`,
    `Подтв. брони — ${b.confirmedCount} шт`,
    `Отгружено — ${fmtMoney(b.shipmentsAmount)}${b.planShipments !== null ? ` / план ${fmtMoney(b.planShipments)} (${fmtPct(b.shipmentsAmount, b.planShipments)})` : ''}`,
    `Звонки — ${b.callsOut} исх · ${b.callMinutes} мин`,
  ];
  return lines.join('\n');
}

export function buildManagerReportText(opts: {
  name: string;
  department?: string | null;
  pf: PlanFactResult;
}): string {
  const { name, department, pf } = opts;
  const header = [
    `[b]Отчет: ${name}[/b]`,
    `[i]${department ? `${department} · ` : ''}за ${fmtDateRu(pf.day.fromStr)}[/i]`,
  ].join('\n');

  const planPct = [
    `[b]% ПЛАНА[/b]`,
    `День — ${fmtPct(pf.day.salesAmount, pf.day.planSales)}`,
    `Неделя — ${fmtPct(pf.week.salesAmount, pf.week.planSales)}`,
    `Месяц — ${fmtPct(pf.month.salesAmount, pf.month.planSales)}`,
  ].join('\n');

  const ex = pf.monthExtras;
  const monthDetails = [
    `[b]МЕСЯЦ · ДЕТАЛИ[/b]`,
    `Продажи (перв.) — ${fmtMoney(ex.primarySalesAmount)}`,
    `Продажи (повт.) — ${fmtMoney(ex.repeatSalesAmount)}`,
    `% повторных — ${ex.repeatSharePct !== null ? `${ex.repeatSharePct.toFixed(1).replace('.', ',')}%` : '—'}`,
    `CR сделка → продажа — ${ex.convDealToSalePct !== null ? `${ex.convDealToSalePct.toFixed(1).replace('.', ',')}%` : '—'}`,
  ].join('\n');

  return [
    `${header}\n\n${planPct}`,
    bucketBlock('ДЕНЬ', pf.day),
    bucketBlock(`НЕДЕЛЯ (с ${fmtDateRu(pf.week.fromStr).slice(0, 5)})`, pf.week),
    `${bucketBlock('МЕСЯЦ', pf.month)}\n\n${monthDetails}`,
  ].join('\n\n————\n');
}

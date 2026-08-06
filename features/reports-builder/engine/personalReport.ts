// Личный отчёт менеджера — третий эталон формата (кнопка «Копировать для отчёта»
// в карточке, features/manager-card/engine/managerReportText.ts).
//
// Почему отдельный композер, а не тот же buildReportText: в личном отчёте ось
// разбивки — ПЕРИОД (день/неделя/месяц), а не сущность, и агрегата нет вовсе
// («агрегат везде, кроме личного» — правило владельца). Общее с остальными
// отчётами — вёрстка (document.ts) и форматирование чисел (format.ts), и это
// как раз то, что раньше дублировалось.
//
// Вход описан здесь, а не берётся из manager-card, чтобы движок не зависел от
// прикладного кода и запускался напрямую через node --experimental-strip-types.

import {
  fmtDateRu,
  fmtMoney,
  fmtPct0,
  fmtPct1Value,
} from './format';
import { metricRow, renderDocument, type Block } from './document';

export interface PersonalBucket {
  /** null — плана нет; тогда «—», а не 0. */
  planSales: number | null;
  salesAmount: number;
  salesCount: number;
  reservationsCount: number;
  reservationsAmount: number;
  confirmedCount: number;
  shipmentsAmount: number;
  planShipments: number | null;
  callsOut: number;
  callMinutes: number;
}

export interface PersonalMonthExtras {
  primarySalesAmount: number;
  repeatSalesAmount: number;
  /** Уже посчитанный процент, не доля. */
  repeatSharePct: number | null;
  convDealToSalePct: number | null;
}

export interface PersonalReportInput {
  name: string;
  department?: string | null;
  /** Отчётная дата, YYYY-MM-DD. */
  date: string;
  /** Начало недели, YYYY-MM-DD — попадает в заголовок «НЕДЕЛЯ (с 04.08)». */
  weekFrom: string;
  day: PersonalBucket;
  week: PersonalBucket;
  month: PersonalBucket;
  monthExtras: PersonalMonthExtras;
}

function bucketBlock(title: string, b: PersonalBucket): Block {
  return {
    title,
    lines: [
      metricRow('План продаж', b.planSales !== null ? fmtMoney(b.planSales) : '—'),
      metricRow('Сумма продаж', fmtMoney(b.salesAmount)),
      metricRow('% выполнения', fmtPct0(b.salesAmount, b.planSales)),
      metricRow('Продажи', `${b.salesCount} шт`),
      metricRow('Брони', `${b.reservationsCount} шт${b.reservationsAmount > 0 ? ` (${fmtMoney(b.reservationsAmount)})` : ''}`),
      metricRow('Подтв. брони', `${b.confirmedCount} шт`),
      metricRow('Отгружено', `${fmtMoney(b.shipmentsAmount)}${
        b.planShipments !== null
          ? ` / план ${fmtMoney(b.planShipments)} (${fmtPct0(b.shipmentsAmount, b.planShipments)})`
          : ''
      }`),
      metricRow('Звонки', `${b.callsOut} исх · ${b.callMinutes} мин`),
    ],
  };
}

export function buildPersonalReportText(input: PersonalReportInput): string {
  const header: Block = {
    title: `Отчет: ${input.name}`,
    lines: [`[i]${input.department ? `${input.department} · ` : ''}за ${fmtDateRu(input.date)}[/i]`],
  };

  const planPct: Block = {
    title: '% ПЛАНА',
    lines: [
      metricRow('День', fmtPct0(input.day.salesAmount, input.day.planSales)),
      metricRow('Неделя', fmtPct0(input.week.salesAmount, input.week.planSales)),
      metricRow('Месяц', fmtPct0(input.month.salesAmount, input.month.planSales)),
    ],
  };

  const ex = input.monthExtras;
  const monthDetails: Block = {
    title: 'МЕСЯЦ · ДЕТАЛИ',
    lines: [
      metricRow('Продажи (перв.)', fmtMoney(ex.primarySalesAmount)),
      metricRow('Продажи (повт.)', fmtMoney(ex.repeatSalesAmount)),
      metricRow('% повторных', fmtPct1Value(ex.repeatSharePct)),
      metricRow('CR сделка → продажа', fmtPct1Value(ex.convDealToSalePct)),
    ],
  };

  // «НЕДЕЛЯ (с 04.08)» — год в заголовке не нужен, отчёт всегда про текущий.
  const weekTitle = `НЕДЕЛЯ (с ${fmtDateRu(input.weekFrom).slice(0, 5)})`;

  return renderDocument([
    [header, planPct],
    [bucketBlock('ДЕНЬ', input.day)],
    [bucketBlock(weekTitle, input.week)],
    [bucketBlock('МЕСЯЦ', input.month), monthDetails],
  ]);
}

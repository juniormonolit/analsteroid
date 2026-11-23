// «Карта показателей» — описание дерева (контракт: features/metric-map/types.ts).
//
// Корень = Σ двух веток (первичка/повторка по воронке, funnels.is_repeat). Ветка —
// ПРОИЗВЕДЕНИЕ телескопических множителей, поэтому в календарном режиме оно тождественно
// равно факту ветки:
//   Сделки × Брони/Сделки × Продажи/Брони × Группы/Продажи × СуммаПродаж/Группы × Отгрузки/СуммаПродаж
//   = Сумма отгрузок.
// Тождество ломается только на нулевом знаменателе (напр. 0 броней при продажах) — тогда
// узел null, а расхождение видно в residual ответа.
//
// id совпадают с dev-фикстурой интерфейса (features/metric-map/ui/fixture.ts).
import type { MapNodeDef } from '../types';

export type Branch = 'p' | 'r';
export const BRANCHES: Branch[] = ['p', 'r'];
export const BRANCH_TAG: Record<Branch, string> = { p: 'перв.', r: 'повт.' };

/** Пороги выборки: конверсии — 30 (знаменатель — сделки/брони), чеки — 10 (продажи). */
export const MIN_SAMPLE_CR = 30;
export const MIN_SAMPLE_CHECK = 10;

function branchNodes(b: Branch, coverageNote: string): MapNodeDef[] {
  const t = BRANCH_TAG[b];
  return [
    {
      id: `${b}.deals`, label: `Кол-во сделок (${t})`, kind: 'leaf', unit: 'count',
      formula: `Кол-во сделок (${t}) — созданные в периоде`,
      description: `Сколько сделок завели в ${b === 'p' ? 'первичных' : 'повторных'} воронках за период (по дате создания).`,
    },
    {
      id: `${b}.cr`, label: `CR Сделка → Продажа (${t})`, kind: 'product', unit: 'pct',
      children: [`${b}.cr_book`, `${b}.cr_sale`],
      formula: `Кол-во продаж (${t}) / Кол-во сделок (${t})`,
      description: 'Календарная конверсия: продажи периода к сделкам периода (каждая — по своей дате этапа). Раскладывается на две ступени.',
      minSample: MIN_SAMPLE_CR,
    },
    {
      id: `${b}.cr_book`, label: `CR Сделка → Бронь (${t})`, kind: 'leaf', unit: 'pct',
      formula: `Кол-во броней (${t}) / Кол-во сделок (${t})`,
      description: 'Брони периода (по дате брони) к сделкам периода (по дате создания).',
      minSample: MIN_SAMPLE_CR,
    },
    {
      id: `${b}.cr_sale`, label: `CR Бронь → Продажа (${t})`, kind: 'leaf', unit: 'pct',
      formula: `Кол-во продаж (${t}) / Кол-во броней (${t})`,
      description: 'Продажи периода (по дате продажи) к броням периода (по дате брони).',
      minSample: MIN_SAMPLE_CR,
    },
    {
      id: `${b}.check`, label: `Ср. чек продаж (${t})`, kind: 'product', unit: 'rub',
      children: [`${b}.complexity`, `${b}.per_group`],
      formula: `Сумма продаж (${t}) / Кол-во продаж (${t})`,
      description: 'Средняя сумма одной продажи = Комплексность × Ср. сумма на товарную группу.',
      minSample: MIN_SAMPLE_CHECK,
    },
    {
      id: `${b}.complexity`, label: `Комплексность (${t})`, kind: 'leaf', unit: 'ratio',
      formula: `Σ разных товарных групп в продажах (${t}) / Кол-во продаж (${t})`,
      description: 'Сколько разных товарных групп (head-групп позиций сделки, без доставки/услуг) в среднем в одной продаже. ' + coverageNote,
      minSample: MIN_SAMPLE_CHECK,
    },
    {
      id: `${b}.per_group`, label: `Ср. сумма на товарную группу (${t})`, kind: 'leaf', unit: 'rub',
      formula: `Сумма продаж (${t}) / Σ разных товарных групп в продажах (${t})`,
      description: 'Сколько в среднем приходится на одну товарную группу чека.',
      minSample: MIN_SAMPLE_CHECK,
    },
    {
      id: `${b}.ship`, label: `Коэф. отгрузки (${t})`, kind: 'leaf', unit: 'ratio',
      formula: `Сумма отгрузок (${t}) / Сумма продаж (${t})`,
      description: 'Отгрузки периода (по дате отгрузки) к продажам периода (по дате продажи), по сумме. Может быть больше 1: отгружают проданное раньше.',
      minSample: MIN_SAMPLE_CHECK,
    },
  ];
}

export const ROOT_ID = 'root';

export function buildNodes(coverage: Record<Branch, string>): MapNodeDef[] {
  return [
    {
      id: ROOT_ID, label: 'Сумма отгрузок', kind: 'sum', unit: 'rub', children: ['p', 'r'],
      formula: 'Сумма отгрузок (перв.) + Сумма отгрузок (повт.)',
      description: 'Корень карты — «Сумма отгрузок» отчёта по менеджерам. Первичка и повторка — по воронке сделки.',
    },
    ...BRANCHES.map((b): MapNodeDef => ({
      id: b, label: `Сумма отгрузок (${BRANCH_TAG[b]})`, kind: 'product', unit: 'rub',
      children: [`${b}.deals`, `${b}.cr`, `${b}.check`, `${b}.ship`],
      formula: `Кол-во сделок × CR Сделка → Продажа × Ср. чек продаж × Коэф. отгрузки (${BRANCH_TAG[b]})`,
      description: 'Множители телескопические: их произведение тождественно равно сумме отгрузок ветки.',
    })),
    ...branchNodes('p', coverage.p),
    ...branchNodes('r', coverage.r),
  ];
}

/** Аддитивные узлы (растут с размером среза и длиной периода): медиана команды для них
 *  имеет смысл только в срезе одного менеджера и масштабируется на длину периода. */
export function isAdditive(id: string): boolean {
  return id === ROOT_ID || id === 'p' || id === 'r' || id.endsWith('.deals');
}

// «Большой брат» — дисциплина задач: контракт API GET /api/big-brother/tasks.
import type { BbPeriod } from '../rop/period';

export type TaskScope = 'all' | 'services';
export type PersonKind = 'sales' | 'logist' | 'other';

export interface DisciplineRow {
  id: string;
  name: string;
  deptName: string | null;
  ropName: string | null;
  kind: PersonKind;
  /** Получено задач за период (создано на сотрудника). */
  received: number;
  /** Закрыто за период: всего / вовремя / с опозданием / без срока. */
  closed: number;
  onTime: number;
  late: number;
  noDeadline: number;
  /** Доля вовремя среди закрытых со сроком. */
  onTimePct: number | null;
  /** Сейчас: открыто / просрочено / висит без движения N дней / ждёт контроля постановщика. */
  open: number;
  overdue: number;
  stale: number;
  waitingControl: number;
  /** Возвращено на доработку за период (канбан повторки + смены статуса «ждёт контроля → в работу» в событиях Битрикса). */
  returned: number;
}

export interface DisciplineResponse {
  period: BbPeriod;
  scope: TaskScope;
  staleDays: number;
  generatedAt: string;
  rows: DisciplineRow[];
  total: Omit<DisciplineRow, 'id' | 'name' | 'deptName' | 'ropName' | 'kind'>;
  /** Источник «возвращено» по событиям Битрикса доступен (sa.bitrix_task_payload_raw). */
  returnsFromBitrix: boolean;
  notes: string[];
}

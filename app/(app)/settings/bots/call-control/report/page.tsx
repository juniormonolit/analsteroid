'use client';

// Отчёт «Контроль звонков» по менеджерам (задача Иосифа 14.07): кто самый
// безответственный. Таблица — общий ReportTable конструктора, период — стандартный
// DateRangePicker с дефолтом «с начала месяца по вчера» (defaultPeriod), клик по
// строке — дрилл-даун со списком сработавших кейсов менеджера. Данные — YC system
// (call_control_cases/deliveries), в общий каталог метрик не вшиты: кросс-БД
// джойна с Мишиной аналитикой нет, отчёт живёт своим API.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { ArrowLeft, CalendarDays } from 'lucide-react';
import { ReportTable, type RowDeltas } from '@/features/reports/ui/ReportTable';
import { DateRangePicker } from '@/features/reports/ui/DateRangePicker';
import { Popover } from '@/components/ui/Popover';
import { Modal } from '@/components/ui/Modal';
import { defaultPeriod, type DateRange } from '@/lib/period';
import type { Metric } from '@/lib/metrics/types';
import { DEAL_URL_PREFIX } from '@/lib/bots/callControl';
import { formatDuration } from '@/lib/bots/callControlAdmin';

interface ReportRow {
  manager_bitrix_user_id: string;
  manager_name: string | null;
  short_login: string | null;
  department_name: string | null;
  s1: string; s2: string; s3: string; s4: string; total: string;
  seconds: string | null;
}

interface CaseRow {
  id: string;
  phone_normalized: string;
  deal_id: string | null;
  status: string;
  missed_count: number;
  first_missed_at: string;
  resolved_at: string | null;
  max_stage: number;
  seconds: string;
}

// Синтетические описания метрик под общий ReportTable (в каталоге их нет — данные
// из другой БД). Поля за пределами рендера таблицы не используются.
function botMetric(id: string, nameRu: string, decimalPlaces = 0): Metric {
  return {
    id, nameRu, nameShortRu: null, description: null, calcOk: true, fillOk: true,
    metricType: 'external', dataType: decimalPlaces ? 'decimal' : 'int', formula: null,
    dependencies: [], decimalPlaces, aggregationFn: 'sum', category: 'Контроль звонков',
    sortOrder: 0, isCore: false, isActive: true, isHiddenInUi: false, isTest: false,
    source: 'deals', aggFn: null, aggField: null, dateField: null, filters: [], tags: [],
  } as unknown as Metric;
}

const METRICS: Metric[] = [
  botMetric('cc_s1', 'Пропущено ×1'),
  botMetric('cc_s2', 'Пропущено ×2'),
  botMetric('cc_s3', 'Пропущено ×3'),
  botMetric('cc_s4', 'Пропущено ×4+'),
  botMetric('cc_total', 'Кейсов всего'),
  botMetric('cc_hours', 'Время без перезвона, ч', 1),
];

const STAGE_LABELS: Record<number, string> = { 1: 'менеджер', 2: 'РОП', 3: 'директор', 4: 'собственник' };

const fmtDate = (d: Date) => format(d, 'yyyy-MM-dd');
const fmtHuman = (d: Date) => format(d, 'dd.MM.yyyy');

export default function CallControlReportPage() {
  const [period, setPeriod] = useState<DateRange>(() => defaultPeriod());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState<{ managerId: string; managerName: string } | null>(null);
  const [drillCases, setDrillCases] = useState<CaseRow[] | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/settings/bots/call-control/report?from=${fmtDate(period.from)}&to=${fmtDate(period.to)}`)
      .then(r => r.json())
      .then(d => setRows(Array.isArray(d.rows) ? d.rows : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [period]);

  useEffect(() => {
    if (!drill) { setDrillCases(null); return; }
    fetch(`/api/settings/bots/call-control/report?from=${fmtDate(period.from)}&to=${fmtDate(period.to)}&managerId=${drill.managerId}`)
      .then(r => r.json())
      .then(d => setDrillCases(Array.isArray(d.cases) ? d.cases : []))
      .catch(() => setDrillCases([]));
  }, [drill, period]);

  const tableRows: RowDeltas[] = useMemo(() => rows.map(r => {
    const val = (n: string | number | null) => ({ current: n == null ? null : Number(n), comparison: null, delta: null, deltaPct: null });
    return {
      dimensionId: r.manager_bitrix_user_id,
      dimensionName: r.manager_name ?? r.manager_bitrix_user_id,
      dimensionSubtitle: r.short_login ?? undefined,
      teamName: r.department_name,
      deltas: {
        cc_s1: val(r.s1), cc_s2: val(r.s2), cc_s3: val(r.s3), cc_s4: val(r.s4),
        cc_total: val(r.total),
        cc_hours: val(r.seconds == null ? null : Number(r.seconds) / 3600),
      },
    };
  }), [rows]);

  const totals = useMemo(() => {
    const sum = (f: (r: ReportRow) => number) => rows.reduce((a, r) => a + f(r), 0);
    const t = {
      cc_s1: sum(r => +r.s1), cc_s2: sum(r => +r.s2), cc_s3: sum(r => +r.s3),
      cc_s4: sum(r => +r.s4), cc_total: sum(r => +r.total),
      cc_hours: sum(r => (r.seconds == null ? 0 : +r.seconds)) / 3600,
    };
    return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { current: v, comparison: null, delta: null, deltaPct: null }]));
  }, [rows]);

  return (
    <div className="p-3 sm:p-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/settings/bots/call-control" className="flex items-center gap-1 text-sm text-[var(--color-accent)] hover:underline">
          <ArrowLeft size={14} /> К настройкам бота
        </Link>
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Контроль звонков — по менеджерам</h1>
        <Popover
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          className="p-2"
          trigger={
            <button className="flex items-center gap-1.5 px-3 py-1.5 border border-[var(--color-border)] rounded-md text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
              <CalendarDays size={14} />
              {fmtHuman(period.from)} — {fmtHuman(period.to)}
            </button>
          }
        >
          <DateRangePicker
            value={period}
            onChange={r => { setPeriod({ from: r.from, to: r.to }); setPickerOpen(false); }}
            onClose={() => setPickerOpen(false)}
          />
        </Popover>
      </div>

      <p className="text-xs text-[var(--color-text-muted)]">
        Считаются кейсы, по которым бот реально слал уведомления (боевые, без dry run).
        Этапы эксклюзивные: «×2» — кейс дошёл максимум до РОПа. Время — от первого
        пропуска до перезвона (для незакрытых — до текущего момента). Клик по строке —
        список кейсов менеджера.
      </p>

      <div className="scroll-x">
        <ReportTable
          rows={tableRows}
          totals={totals}
          metrics={METRICS}
          comparisonDisplay="current"
          isLoading={loading}
          dimensionLabel="Менеджер"
          onRowClick={(id, name) => setDrill({ managerId: id, managerName: name })}
        />
      </div>

      <Modal
        open={drill != null}
        onOpenChange={o => { if (!o) setDrill(null); }}
        title={drill ? `Кейсы: ${drill.managerName}` : ''}
        desktopWidth="sm:max-w-[720px]"
      >
        {drillCases == null ? (
          <p className="text-sm text-[var(--color-text-muted)] p-2">Загрузка…</p>
        ) : drillCases.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)] p-2">Кейсов за период нет.</p>
        ) : (
          <div className="scroll-x">
            <table className="w-full text-sm min-w-[620px]">
              <thead>
                <tr className="text-left text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                  <th className="px-2 py-1.5 font-medium">Первый пропуск</th>
                  <th className="px-2 py-1.5 font-medium">Телефон</th>
                  <th className="px-2 py-1.5 font-medium">Сделка</th>
                  <th className="px-2 py-1.5 font-medium">Пропущено</th>
                  <th className="px-2 py-1.5 font-medium">Дошло до</th>
                  <th className="px-2 py-1.5 font-medium">Без перезвона</th>
                </tr>
              </thead>
              <tbody>
                {drillCases.map(c => (
                  <tr key={c.id} className="border-b border-[var(--color-border)] last:border-b-0">
                    <td className="px-2 py-1.5 text-[var(--color-text)] whitespace-nowrap">
                      {format(new Date(c.first_missed_at), 'dd.MM HH:mm')}
                    </td>
                    <td className="px-2 py-1.5 text-[var(--color-text)] whitespace-nowrap">{c.phone_normalized}</td>
                    <td className="px-2 py-1.5">
                      {c.deal_id
                        ? <a href={`${DEAL_URL_PREFIX}${c.deal_id}/`} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline">#{c.deal_id}</a>
                        : <span className="text-[var(--color-text-muted)]">—</span>}
                    </td>
                    <td className="px-2 py-1.5 text-[var(--color-text)]">{c.missed_count}</td>
                    <td className="px-2 py-1.5 text-[var(--color-text)]">{STAGE_LABELS[Math.min(c.max_stage, 4)] ?? c.max_stage}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span className={c.resolved_at ? 'text-[var(--color-text)]' : 'text-[var(--color-error)] font-medium'}>
                        {formatDuration(Number(c.seconds))}{c.resolved_at ? '' : ' · не перезвонили'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}

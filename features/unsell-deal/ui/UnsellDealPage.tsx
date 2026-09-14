'use client';
// «Снять с продажи» (задача #6260, санкция Серёги 11.09): ручная очистка
// sold_at у сделки, ошибочно поставленной в продажу. Доступ — директор и
// выше (гейт в layout.tsx рядом, API-гейт lib/sales/unsellDeal.ts::canUnsellDeal).
//
// sold_at НЕ очищается автоматически никогда (решение владельца 11.09:
// залипание — защита рейтинга от накрутки) — единственный путь сюда, с
// обязательной причиной и записью в журнал. Обратной кнопки «вернуть sold_at»
// нет намеренно — нельзя «продать» сделку повторно кликом.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { AlertTriangle, RotateCcw, Search } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { HydratedDeal } from '@/lib/reports/dealsByIds';
import type { ManualFixRow } from '@/lib/sales/unsellDeal';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLS, unsellApi } from './api';

function fmtDt(iso: string | null): string {
  if (!iso) return '—';
  try { return format(new Date(iso), 'dd.MM.yyyy HH:mm', { locale: ru }); } catch { return iso; }
}

function fmtMoney(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  return `${n.toLocaleString('ru-RU')} ₽`;
}

// Та же стадийная блокировка, что и на сервере (lib/sales/unsellDeal.ts) —
// дублируется здесь ТОЛЬКО для мгновенной подсказки в карточке, финальное
// решение всегда принимает сервер (route POST /api/sales/unsell-deal/[id]).
const LOCKED_EVENT_TYPES = new Set(['sold', 'shipped']);

function DealCard({ deal }: { deal: HydratedDeal }) {
  const locked = !!deal.stage_event_type && LOCKED_EVENT_TYPES.has(deal.stage_event_type);
  const alreadyEmpty = !deal.sold_at;
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="text-sm font-semibold text-[var(--color-text)]">#{deal.deal_id} · {deal.deal_name || 'Без названия'}</div>
          <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{deal.manager_name ?? `#${deal.manager_id}`}{deal.branch_name ? ` · ${deal.branch_name}` : ''}</div>
        </div>
        <div className="text-sm font-medium text-[var(--color-text)]">{fmtMoney(deal.amount)}</div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mt-1">
        <div>
          <div className="text-[var(--color-text-muted)]">Стадия</div>
          <div className="text-[var(--color-text)]">{deal.stage_name ?? '—'}</div>
        </div>
        <div>
          <div className="text-[var(--color-text-muted)]">sold_at</div>
          <div className="text-[var(--color-text)]">{fmtDt(deal.sold_at)}</div>
        </div>
        <div>
          <div className="text-[var(--color-text-muted)]">delivered_at</div>
          <div className="text-[var(--color-text)]">{fmtDt(deal.delivered_at)}</div>
        </div>
        <div>
          <div className="text-[var(--color-text-muted)]">Создана</div>
          <div className="text-[var(--color-text)]">{fmtDt(deal.created_at)}</div>
        </div>
      </div>
      {alreadyEmpty && (
        <div className="flex items-start gap-1.5 text-xs text-[var(--color-text-muted)] mt-1">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" /> У сделки уже нет даты продажи — снимать нечего.
        </div>
      )}
      {!alreadyEmpty && locked && (
        <div className="flex items-start gap-1.5 text-xs text-[var(--color-negative,#e03131)] mt-1">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          Сделка сейчас в стадии «{deal.stage_name}» — это стадия продажи/отгрузки. Сначала переведите сделку в другую стадию в Битриксе.
        </div>
      )}
    </div>
  );
}

type SortKey = 'deal_id' | 'reason' | 'user_name' | 'created_at';
type SortState = { key: SortKey; dir: 'asc' | 'desc' };

function SortableTh({ label, sortKey, sort, onSort }: { label: string; sortKey: SortKey; sort: SortState; onSort: (k: SortKey) => void }) {
  const active = sort.key === sortKey;
  return (
    <th onClick={() => onSort(sortKey)} className="px-2 py-2 text-left font-medium whitespace-nowrap cursor-pointer select-none hover:text-[var(--color-text)] text-[var(--color-text-muted)]">
      {label}<span className="inline-block w-3 text-[10px]">{active ? (sort.dir === 'desc' ? '▼' : '▲') : ''}</span>
    </th>
  );
}

function JournalTable({ rows }: { rows: ManualFixRow[] }) {
  const [sort, setSort] = useState<SortState>({ key: 'created_at', dir: 'desc' });
  const handleSort = (key: SortKey) => setSort(cur => (cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  const sorted = useMemo(() => {
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const av = sort.key === 'deal_id' ? a.deal_id : a[sort.key];
      const bv = sort.key === 'deal_id' ? b.deal_id : b[sort.key];
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });
  }, [rows, sort]);

  if (rows.length === 0) {
    return <div className="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">Правок пока не было.</div>;
  }

  return (
    <div className="scroll-x rounded-lg border border-[var(--color-border)]">
      <table className="w-full text-xs min-w-[720px]">
        <thead className="border-b border-[var(--color-border)]">
          <tr>
            <SortableTh label="Сделка" sortKey="deal_id" sort={sort} onSort={handleSort} />
            <th className="px-2 py-2 text-left font-medium text-[var(--color-text-muted)]">Было → стало</th>
            <SortableTh label="Причина" sortKey="reason" sort={sort} onSort={handleSort} />
            <SortableTh label="Кто" sortKey="user_name" sort={sort} onSort={handleSort} />
            <SortableTh label="Когда" sortKey="created_at" sort={sort} onSort={handleSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => (
            <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0">
              <td className="px-2 py-2 whitespace-nowrap text-[var(--color-text)]">#{r.deal_id}{r.deal_name ? ` · ${r.deal_name}` : ''}</td>
              <td className="px-2 py-2 whitespace-nowrap text-[var(--color-text-muted)]">{r.field}: {fmtDt(r.old_value)} → {r.new_value ? fmtDt(r.new_value) : '—'}</td>
              <td className="px-2 py-2 max-w-[280px] truncate text-[var(--color-text)]" title={r.reason}>{r.reason}</td>
              <td className="px-2 py-2 whitespace-nowrap text-[var(--color-text-muted)]">{r.user_name}</td>
              <td className="px-2 py-2 whitespace-nowrap text-[var(--color-text-muted)]">{fmtDt(r.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UnsellDealPage() {
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const [dealId, setDealId] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  const dealQuery = useQuery({
    queryKey: ['unsell-deal', dealId],
    queryFn: () => unsellApi.findDeal(dealId!),
    enabled: dealId !== null,
    retry: false,
  });

  const journalQuery = useQuery({
    queryKey: ['unsell-deal-journal'],
    queryFn: unsellApi.journal,
  });

  const mutation = useMutation({
    mutationFn: () => unsellApi.unsell(dealId!, reason),
    onSuccess: () => {
      setConfirmOpen(false);
      setDoneMsg(`Сделка #${dealId} снята с продажи.`);
      setReason('');
      qc.invalidateQueries({ queryKey: ['unsell-deal', dealId] });
      qc.invalidateQueries({ queryKey: ['unsell-deal-journal'] });
    },
    onError: (e: Error) => { setActionError(e.message); setConfirmOpen(false); },
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(input.trim());
    setActionError(null);
    setDoneMsg(null);
    if (!Number.isFinite(n) || n <= 0) return;
    setDealId(n);
  };

  const deal = dealQuery.data?.deal ?? null;
  const canSubmit = !!deal && !!deal.sold_at
    && !(deal.stage_event_type && LOCKED_EVENT_TYPES.has(deal.stage_event_type))
    && reason.trim().length > 0
    && !mutation.isPending;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="p-3 sm:p-6 flex flex-col gap-6 max-w-3xl">
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-text)] flex items-center gap-2"><RotateCcw size={20} /> Снять с продажи</h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            Ручная очистка даты продажи (sold_at) у сделки, ошибочно попавшей в продажи. sold_at
            никогда не чистится автоматически — только так, с обязательной причиной. Снять можно,
            только если сделка сейчас НЕ в стадии продажи/отгрузки.
          </p>
        </div>

        <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-2">
          <input
            className={INPUT_CLS}
            placeholder="Номер сделки, напр. 252311"
            inputMode="numeric"
            value={input}
            onChange={(e) => setInput(e.target.value.replace(/[^\d]/g, ''))}
          />
          <button type="submit" className={BTN_PRIMARY} disabled={!input}><Search size={16} /> Найти</button>
        </form>

        {dealQuery.isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
        {dealQuery.isError && <div className="text-sm text-[var(--color-negative,#e03131)]">{(dealQuery.error as Error).message}</div>}
        {deal && <DealCard deal={deal} />}

        {deal && (
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-[var(--color-text)]" htmlFor="unsell-reason">Причина (обязательно)</label>
            <textarea
              id="unsell-reason"
              className={`${INPUT_CLS} min-h-20 resize-y`}
              placeholder="Например: сделка ошибочно переведена в «Продано» вместо соседней, менеджер перепутал карточки"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
            />
            <div className="flex items-center gap-2">
              <button type="button" className={BTN_PRIMARY} disabled={!canSubmit} onClick={() => setConfirmOpen(true)}>
                Снять с продажи
              </button>
              <button type="button" className={BTN_SECONDARY} onClick={() => { setDealId(null); setInput(''); setReason(''); setActionError(null); setDoneMsg(null); }}>
                Сбросить
              </button>
            </div>
          </div>
        )}

        {actionError && <div className="text-sm text-[var(--color-negative,#e03131)]">{actionError}</div>}
        {doneMsg && <div className="text-sm text-green-600">{doneMsg}</div>}

        <div>
          <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Журнал правок (последние 50)</h2>
          {journalQuery.isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
          {journalQuery.data && <JournalTable rows={journalQuery.data.rows} />}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Снять сделку с продажи?"
        description={`Сделка #${dealId}: sold_at будет очищена. Действие необратимо кнопкой — вернуть sold_at может только реальный переход стадии в Битриксе. Причина будет записана в журнал.`}
        confirmLabel="Снять"
        tone="danger"
        pending={mutation.isPending}
        onConfirm={() => mutation.mutate()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

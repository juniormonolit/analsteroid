'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, History } from 'lucide-react';
import { PinDialog } from '@/components/ui/PinDialog';
import { PinSetupDialog } from '@/components/ui/PinSetupDialog';
import { PinChangeDialog } from '@/components/ui/PinChangeDialog';
import { fetchPinGated } from '@/lib/client/pinFetch';

// Пин-код на денежные операции (задача #2995, спека
// owners-inbox/monolitika-pin-code-spec.md §4/§5/§7). Личный порог «запрашивать
// пин от суммы N» (пресеты + подтверждение пином — обе стороны изменения),
// смена пина, лок/заморозка статус, «История подтверждений».

interface PinState {
  pinFeatureEnabled: boolean;
  pinSet: boolean;
  pinThresholdMlt: number;
  pinLockedUntil: string | null;
  pinFreezeUntil: string | null;
  pinLockLevel: number;
}

interface PinEventRow {
  id: number; event: string; operation: string | null; amount: number | null; currency: string | null;
  threshold_before: number | null; threshold_after: number | null; surface: string | null; at: string;
}

const THRESHOLD_PRESETS = [0, 10, 30, 50, 100];

const EVENT_LABELS: Record<string, string> = {
  set: 'Пин установлен', change: 'Пин изменён', reset_by_admin: 'Сброшен администратором',
  threshold_change: 'Изменён порог', verify_ok: 'Подтверждена операция', verify_fail: 'Неверный пин',
  locked: 'Пин заблокирован',
};

function fmtDateTime(v: string): string {
  // формат из API уже 'YYYY-MM-DD HH24:MI' (МСК)
  return v;
}

export function PinSettingsCard({ ssoAccount }: { ssoAccount: boolean }) {
  const qc = useQueryClient();
  const [setupOpen, setSetupOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [thresholdPending, setThresholdPending] = useState<number | null>(null);
  const [pinVerifyForThreshold, setPinVerifyForThreshold] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: pin, isLoading } = useQuery<PinState>({
    queryKey: ['me-pin'],
    queryFn: async () => {
      const res = await fetch('/api/me/pin');
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
    staleTime: 30_000,
  });

  const { data: history } = useQuery<{ events: PinEventRow[] }>({
    queryKey: ['me-pin-events'],
    queryFn: async () => {
      const res = await fetch('/api/me/pin/events');
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
    enabled: historyOpen,
    staleTime: 15_000,
  });

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['me-pin'] });
    void qc.invalidateQueries({ queryKey: ['me-pin-events'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  }

  async function submitThreshold(v: number, pinValue: string): Promise<{ ok: boolean; error?: string }> {
    const r = await fetchPinGated('/api/me/pin', 'PATCH', { action: 'threshold', pin: pinValue, thresholdMlt: v });
    if (!r.ok) return { ok: false, error: r.error ?? 'Ошибка' };
    setNotice(`Порог обновлён: ${v} MLT`);
    refresh();
    return { ok: true };
  }

  if (isLoading || !pin) return null;
  if (!pin.pinFeatureEnabled) return null; // фича не включена (нет PIN_PEPPER в env) — секцию не показываем

  const locked = pin.pinLockedUntil !== null;
  const frozen = pin.pinFreezeUntil !== null;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck size={15} className="text-[var(--color-text-muted)]" />
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Пин-код на денежные операции</h2>
      </div>

      {!pin.pinSet ? (
        <>
          <p className="text-sm text-[var(--color-text-muted)] mb-3">
            Пин — 4 цифры. Подтверждает покупки дороже вашего личного порога, а рубли, переводы, подарки и вывод в ЗП —
            всегда, вне зависимости от суммы.
          </p>
          <button type="button" onClick={() => setSetupOpen(true)}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-white">
            Установить пин
          </button>
        </>
      ) : (
        <>
          {locked && (
            <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
              🔒 Пин заблокирован{pin.pinLockLevel >= 3 ? ' — обратитесь к администратору' : ` до ${pin.pinLockedUntil}`}.
            </div>
          )}
          {frozen && (
            <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
              ⏳ Переводы, подарки и вывод в ЗП временно заморожены до {pin.pinFreezeUntil} (после недавнего сброса/смены пина).
              Покупки для себя доступны.
            </div>
          )}

          <p className="text-sm text-[var(--color-text-muted)] mb-2">
            Запрашивать пин-код от суммы (только траты на себя — магазин, гача, реролл квеста; на рубли, переводы,
            подарки и вывод в ЗП порог не влияет, там пин всегда):
          </p>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm w-fit">
              {THRESHOLD_PRESETS.map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={thresholdPending !== null}
                  onClick={() => setPinVerifyForThreshold(v)}
                  className={`px-3 py-1.5 transition-colors disabled:opacity-50 ${
                    pin.pinThresholdMlt === v
                      ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
                      : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
            <span className="text-xs text-[var(--color-text-muted)]">MLT (сейчас {pin.pinThresholdMlt})</span>
          </div>
          <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
            Дополнительно системный суточный потолок 150 MLT без пина — исчерпан, дальше пин на всё до конца суток
            (МСК), даже под порогом.
          </p>

          {notice && <p className="mb-3 text-xs text-green-600">{notice}</p>}

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setChangeOpen(true)}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]">
              Сменить пин
            </button>
            <button type="button" onClick={() => setHistoryOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]">
              <History size={13} /> История подтверждений
            </button>
          </div>

          {historyOpen && (
            <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-[var(--color-border)]">
              {!history ? (
                <div className="p-3 text-xs text-[var(--color-text-muted)]">Загрузка…</div>
              ) : history.events.length === 0 ? (
                <div className="p-3 text-xs text-[var(--color-text-muted)]">Пока пусто</div>
              ) : (
                <table className="w-full text-xs">
                  <tbody>
                    {history.events.map((e) => (
                      <tr key={e.id} className="border-b border-[var(--color-border)] last:border-0">
                        <td className="px-2 py-1.5 whitespace-nowrap text-[var(--color-text-muted)]">{fmtDateTime(e.at)}</td>
                        <td className="px-2 py-1.5">{EVENT_LABELS[e.event] ?? e.event}</td>
                        <td className="px-2 py-1.5 text-[var(--color-text-muted)]">
                          {e.event === 'threshold_change' && e.threshold_before !== null
                            ? `${e.threshold_before} → ${e.threshold_after} MLT`
                            : e.amount !== null ? `${e.amount} ${e.currency ?? ''}` : (e.operation ?? '')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}

      <PinSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        ssoAccount={ssoAccount}
        onSuccess={() => { setNotice('Пин установлен'); refresh(); }}
      />
      <PinChangeDialog
        open={changeOpen}
        onOpenChange={setChangeOpen}
        ssoAccount={ssoAccount}
        onSuccess={() => { setNotice('Пин изменён'); refresh(); }}
      />
      <PinDialog
        open={pinVerifyForThreshold !== null}
        onOpenChange={(o) => { if (!o) setPinVerifyForThreshold(null); }}
        title="Подтвердите изменение порога пином"
        description={pinVerifyForThreshold !== null ? `Новый порог: ${pinVerifyForThreshold} MLT` : undefined}
        onConfirm={async (pinValue) => {
          if (pinVerifyForThreshold === null) return { ok: false, error: 'Нет значения' };
          setThresholdPending(pinVerifyForThreshold);
          try {
            const res = await submitThreshold(pinVerifyForThreshold, pinValue);
            if (res.ok) setPinVerifyForThreshold(null);
            return res;
          } finally {
            setThresholdPending(null);
          }
        }}
      />
    </div>
  );
}

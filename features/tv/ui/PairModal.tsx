'use client';
// Привязка телевизора: код с экрана телевизора + подпись «где висит».
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import type { TvScreen } from '../shared';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLS, LABEL_CLS, tvApi } from './api';

export function PairModal({ screen, onClose, onPaired }: { screen: TvScreen | null; onClose: () => void; onPaired: (s: TvScreen) => void }) {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!screen) return;
    setBusy(true); setError(null);
    try {
      const r = await tvApi.pair(screen.id, code, label.trim() || null);
      onPaired(r.screen);
      setCode(''); setLabel('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось привязать');
    } finally { setBusy(false); }
  }

  return (
    <Modal open={!!screen} onOpenChange={v => { if (!v) onClose(); }} title={screen ? `Привязать телевизор — ${screen.name}` : ''} desktopWidth="sm:max-w-md">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <ol className="text-sm text-[var(--color-text-muted)] list-decimal pl-5 space-y-1">
          <li>На телевизоре в браузере откройте <b className="text-[var(--color-text)]">{typeof window !== 'undefined' ? window.location.host : ''}/tv</b> и сохраните как домашнюю страницу.</li>
          <li>На экране появится код из 4 символов — введите его сюда.</li>
        </ol>
        <div className="flex flex-col gap-1.5">
          <label className={LABEL_CLS}>Код с телевизора</label>
          <input className={`${INPUT_CLS} text-2xl tracking-[.3em] font-mono uppercase text-center`} value={code}
            onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))} placeholder="AB7K" autoFocus autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className={LABEL_CLS}>Где висит (подпись телевизора)</label>
          <input className={INPUT_CLS} value={label} onChange={e => setLabel(e.target.value)} placeholder="Кабинет ОС, левая стена" />
        </div>
        {error && <div className="text-sm text-[var(--color-negative)]">{error}</div>}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button type="button" className={BTN_SECONDARY} onClick={onClose}>Закрыть</button>
          <button type="submit" className={BTN_PRIMARY} disabled={busy || code.length !== 4}>{busy ? 'Привязываем…' : 'Привязать'}</button>
        </div>
      </form>
    </Modal>
  );
}

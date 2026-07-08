'use client';
import { useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, Upload } from 'lucide-react';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';

interface ConflictItem {
  login: string;
  name: string;
  existing: number;
  incoming: number;
}

interface CleanItem {
  login: string;
  name: string;
  amount: number;
}

interface ParseResult {
  conflicts: ConflictItem[];
  clean: CleanItem[];
}

interface Props {
  currentPlanN: number;
  onClose: () => void;
}

function fmt(n: number) {
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

function defaultNextMonth() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const y = next.getFullYear();
  const m = String(next.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function ImportSlide({ currentPlanN, onClose }: Props) {
  const qc = useQueryClient();
  const [month, setMonth] = useState(defaultNextMonth());
  const [file, setFile] = useState<File | null>(null);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [conflictChoices, setConflictChoices] = useState<Map<string, 'keep' | 'overwrite'>>(new Map());
  const [saving, setSaving] = useState(false);
  const [parsing, setParsing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { closing, requestClose } = useSlideClose(onClose);

  async function handleParse() {
    if (!file || !month) return;
    setParsing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('month', month);
      const res = await fetch('/api/plans/import', { method: 'POST', body: fd });
      const data = await res.json() as ParseResult;
      setParseResult(data);
      const choices = new Map<string, 'keep' | 'overwrite'>();
      for (const c of data.conflicts) choices.set(c.login, 'keep');
      setConflictChoices(choices);
    } finally {
      setParsing(false);
    }
  }

  async function handleApply() {
    if (!parseResult) return;
    setSaving(true);
    try {
      const items: { login: string; amount: number }[] = [
        ...parseResult.clean.map(c => ({ login: c.login, amount: c.amount })),
        ...parseResult.conflicts
          .filter(c => conflictChoices.get(c.login) === 'overwrite')
          .map(c => ({ login: c.login, amount: c.incoming })),
      ];
      await fetch('/api/plans/import/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, items, plan_n: currentPlanN }),
      });
      await qc.invalidateQueries({ queryKey: ['plans'] });
      requestClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className={`fixed inset-0 z-40 transition-opacity duration-150 ${closing ? 'opacity-0' : 'opacity-100'}`} onClick={requestClose} />
      <div className={`fixed inset-y-0 right-0 z-50 w-96 max-w-[94vw] bg-[var(--color-bg-surface)] shadow-2xl flex flex-col ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}>
        <PanelCloseTab onClick={requestClose} />
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <h2 className="text-base font-semibold text-[var(--color-text)]">Импорт планов</h2>
          <button onClick={requestClose} className="sm:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {/* Month */}
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">Месяц</label>
            <input
              type="month"
              value={month}
              onChange={e => setMonth(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border border-[var(--color-border)] rounded-lg bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
            />
          </div>

          {/* File drop zone */}
          {!parseResult && (
            <div>
              <label className="block text-xs text-[var(--color-text-muted)] mb-1">Файл (xlsx / csv)</label>
              <div
                className="border-2 border-dashed border-[var(--color-border)] rounded-lg p-6 text-center cursor-pointer hover:border-[var(--color-accent)] transition-colors"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
              >
                <Upload size={24} className="mx-auto mb-2 text-[var(--color-text-muted)]" />
                {file ? (
                  <p className="text-sm text-[var(--color-text)]">{file.name}</p>
                ) : (
                  <p className="text-sm text-[var(--color-text-muted)]">Перетащите файл или нажмите для выбора</p>
                )}
                <p className="text-xs text-[var(--color-text-muted)] mt-2">
                  <strong>Колонка A</strong> — логин, <strong>B</strong> — имя (игнорируется), <strong>C</strong> — сумма отгрузок
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.csv,.xls"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) setFile(f); }}
              />
            </div>
          )}

          {/* Parse result */}
          {parseResult && (
            <div className="flex flex-col gap-3">
              <div className="text-sm text-[var(--color-text)]">
                Новых записей: <strong>{parseResult.clean.length}</strong>
              </div>

              {parseResult.conflicts.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
                    Конфликты ({parseResult.conflicts.length})
                  </p>
                  <div className="flex flex-col gap-2">
                    {parseResult.conflicts.map(c => (
                      <div key={c.login} className="border border-[var(--color-border)] rounded-lg p-3">
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <div className="text-sm font-medium text-[var(--color-text)]">{c.name}</div>
                            <div className="text-xs text-[var(--color-text-muted)]">{c.login}</div>
                          </div>
                        </div>
                        <div className="text-xs text-[var(--color-text-muted)] mb-2">
                          Текущее: {fmt(c.existing)} → Новое: {fmt(c.incoming)}
                        </div>
                        <div className="flex gap-3">
                          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                            <input
                              type="radio"
                              name={`conflict-${c.login}`}
                              checked={conflictChoices.get(c.login) === 'keep'}
                              onChange={() => setConflictChoices(prev => new Map(prev).set(c.login, 'keep'))}
                              className="accent-[var(--color-accent)]"
                            />
                            Оставить
                          </label>
                          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                            <input
                              type="radio"
                              name={`conflict-${c.login}`}
                              checked={conflictChoices.get(c.login) === 'overwrite'}
                              onChange={() => setConflictChoices(prev => new Map(prev).set(c.login, 'overwrite'))}
                              className="accent-[var(--color-accent)]"
                            />
                            Перезаписать
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <button
                onClick={() => setParseResult(null)}
                className="text-xs text-[var(--color-accent)] hover:underline self-start"
              >
                ← Изменить файл
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--color-border)] p-4 flex gap-2">
          {!parseResult ? (
            <button
              onClick={handleParse}
              disabled={!file || !month || parsing}
              className="flex-1 py-2 bg-[var(--color-accent)] text-white text-sm rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {parsing ? 'Разбор...' : 'Разобрать файл'}
            </button>
          ) : (
            <button
              onClick={handleApply}
              disabled={saving}
              className="flex-1 py-2 bg-[var(--color-accent)] text-white text-sm rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {saving ? 'Сохранение...' : 'Применить'}
            </button>
          )}
          <button
            onClick={requestClose}
            className="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Отмена
          </button>
        </div>
      </div>
    </>
  );
}

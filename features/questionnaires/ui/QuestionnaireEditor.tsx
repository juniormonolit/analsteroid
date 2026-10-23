'use client';
// Редактор анкеты одной товарной группы (миграция 244, владелец 22.10): список вопросов, тип
// ответа (текст / один вариант / несколько), варианты, обязательность, порядок. Сохраняется
// целиком кнопкой «Сохранить»; удалённые вопросы уходят в архив (на них сошлются ответы брифа).
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { QUESTION_AUDIENCES, QUESTION_KINDS, looksLikeCheck, type GroupQuestion, type QuestionAudience, type QuestionKind } from '../engine/types';
import { QuestionnaireForm, type Answers } from './QuestionnaireForm';

type Draft = GroupQuestion & { uid: string };
let seq = 0;
const uid = () => `q${++seq}`;
const blank = (): Draft => ({ uid: uid(), id: null, question: '', hint: null, kind: 'text', options: [], required: false, audience: 'client' });

const field = 'w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base sm:text-sm text-[var(--color-text)]';
const btnIdle = 'inline-flex min-h-11 items-center justify-center gap-1 rounded-lg border border-[var(--color-border)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40';
const iconBtn = 'tap-target inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:opacity-30';

export function QuestionnaireEditor({ group, title, initial, copySources, onClose, onSaved }: {
  group: string;
  title: string;
  initial: GroupQuestion[];
  /** Другие группы с анкетами — «Скопировать вопросы из…». */
  copySources: { group: string; label: string; questions: GroupQuestion[] }[];
  onClose: () => void;
  onSaved: (questions: GroupQuestion[]) => void;
}) {
  const [items, setItems] = useState<Draft[]>(() => initial.map(q => ({ ...q, options: [...q.options], uid: uid() })));
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [preview, setPreview] = useState<Answers>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const snapshot = useMemo(() => JSON.stringify(initial), [initial]);
  const strip = (l: Draft[]): GroupQuestion[] => l.map(({ uid: _u, ...q }) => q);
  const dirty = JSON.stringify(strip(items)) !== snapshot;

  const patch = (u: string, p: Partial<Draft>) => setItems(l => l.map(q => (q.uid === u ? { ...q, ...p } : q)));
  const move = (i: number, d: -1 | 1) => setItems(l => {
    const n = [...l]; const j = i + d;
    if (j < 0 || j >= n.length) return l;
    [n[i], n[j]] = [n[j], n[i]];
    return n;
  });
  const setKind = (q: Draft, kind: QuestionKind) =>
    patch(q.uid, { kind, options: kind === 'text' ? q.options : q.options.length >= 2 ? q.options : [...q.options, '', ''].slice(0, Math.max(2, q.options.length)) });

  const close = () => { if (!dirty || confirm('Закрыть без сохранения? Изменения пропадут.')) onClose(); };
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/settings/cross-sell/questions', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group, questions: strip(items).map(q => ({ ...q, options: q.options.map(o => o.trim()).filter(Boolean) })) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      onSaved(j.questions);
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <Modal open onOpenChange={o => { if (!o) close(); }} title={`Анкета · ${title}`} desktopWidth="sm:max-w-2xl">
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg border border-[var(--color-border)] p-0.5" role="tablist" aria-label="Режим">
            {(['edit', 'preview'] as const).map(m => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
                className={`min-h-10 rounded-md px-3 text-sm ${mode === m ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                {m === 'edit' ? 'Вопросы' : 'Как увидит менеджер'}
              </button>
            ))}
          </div>
          {mode === 'edit' && copySources.length > 0 && (
            <SearchSelect ariaLabel="Скопировать вопросы из другой группы" value="" searchable
              placeholder="Скопировать из группы…" allLabel="Скопировать из группы…"
              options={copySources.map(s => ({ value: s.group, label: s.label, hint: `${s.questions.length} вопр.` }))}
              onChange={g => {
                const src = copySources.find(s => s.group === g);
                if (src) setItems(l => [...l, ...src.questions.map(q => ({ ...q, id: null, options: [...q.options], uid: uid() }))]);
              }}
              className="min-w-0 flex-1 sm:max-w-xs" />
          )}
        </div>

        {mode === 'preview' ? (
          <div className="rounded-lg border border-[var(--color-border)] p-3">
            {/* Менеджер видит только вопросы клиенту; проверки — для разбора звонков и РОПа (миграция 251). */}
            <QuestionnaireForm questions={strip(items).filter(q => q.question.trim() && q.audience === 'client')} value={preview} onChange={setPreview} />
            {items.some(q => q.audience === 'manager_check' && q.question.trim()) && (
              <div className="mt-4 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
                <div className="mb-1 font-semibold">Проверки менеджера — менеджер их не видит, по ним разбор звонков оценивает разговор:</div>
                <ul className="list-disc pl-5">{items.filter(q => q.audience === 'manager_check' && q.question.trim()).map(q => <li key={q.uid}>{q.question}</li>)}</ul>
              </div>
            )}
          </div>
        ) : (
          <>
            {items.length === 0 && (
              <p className="text-[var(--color-text-muted)]">Вопросов нет. Добавьте первый — например, «Какой объект строите?» с вариантами ответа.</p>
            )}
            {items.map((q, i) => (
              <div key={q.uid} className="flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
                <div className="flex items-start gap-2">
                  <span className="mt-2 w-5 shrink-0 text-right text-xs font-semibold text-[var(--color-text-muted)]">{i + 1}</span>
                  <textarea rows={2} value={q.question} onChange={e => patch(q.uid, { question: e.target.value })}
                    placeholder="Текст вопроса" aria-label={`Вопрос ${i + 1}`} maxLength={500} className={field} />
                  <div className="flex shrink-0 flex-col">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Выше" className={iconBtn}><ArrowUp size={14} /></button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label="Ниже" className={iconBtn}><ArrowDown size={14} /></button>
                  </div>
                </div>
                <div className="flex min-w-0 flex-col gap-2 pl-7">
                  {looksLikeCheck(q) && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md bg-[#fff2cc] px-2 py-1.5 text-[12.5px] text-[#7f6000]">
                      <span className="min-w-0 flex-1">Похоже на проверку менеджера («сделал ли это менеджер»), а не на вопрос клиенту — вопросы клиенту уходят менеджеру в задачу.</span>
                      <button type="button" onClick={() => patch(q.uid, { audience: 'manager_check' })}
                        className="min-h-9 shrink-0 rounded-md bg-[#7f6000] px-2.5 text-xs font-medium text-white hover:opacity-90">Сделать проверкой</button>
                    </div>
                  )}
                  <input value={q.hint ?? ''} onChange={e => patch(q.uid, { hint: e.target.value || null })} maxLength={300}
                    placeholder={q.audience === 'manager_check' ? 'Как понять, что сделано (необязательно)' : 'Подсказка менеджеру (необязательно)'} aria-label="Подсказка" className={field} />
                  <div className="flex flex-wrap items-center gap-2">
                    <SearchSelect ariaLabel="Кому вопрос" value={q.audience} onChange={v => patch(q.uid, { audience: v as QuestionAudience })}
                      options={QUESTION_AUDIENCES.map(a => ({ value: a.value, label: a.label, hint: a.hint }))}
                      className={`w-full sm:w-56 ${q.audience === 'manager_check' ? 'border-[#e69138]' : ''}`} />
                    <SearchSelect ariaLabel="Тип ответа" value={q.kind} onChange={v => setKind(q, v as QuestionKind)}
                      options={QUESTION_KINDS.map(k => ({ value: k.value, label: k.label }))} className="w-full sm:w-56" />
                    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-[var(--color-text)]">
                      <input type="checkbox" checked={q.required} onChange={e => patch(q.uid, { required: e.target.checked })} className="h-4 w-4 accent-[var(--color-accent)]" />
                      Обязательный
                    </label>
                    <button type="button" onClick={() => setItems(l => l.filter(x => x.uid !== q.uid))}
                      className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-[#990000] hover:bg-[var(--color-bg-hover)]">
                      <Trash2 size={14} /> Удалить вопрос
                    </button>
                  </div>
                  {q.kind !== 'text' && (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs text-[var(--color-text-muted)]">
                        Варианты ответа · {q.kind === 'single' ? 'менеджер выберет один' : 'менеджер отметит несколько'}
                      </span>
                      {q.options.map((o, oi) => (
                        <div key={oi} className="flex items-center gap-1.5">
                          <input value={o} maxLength={200} aria-label={`Вариант ${oi + 1}`} placeholder={`Вариант ${oi + 1}`} className={field}
                            onChange={e => patch(q.uid, { options: q.options.map((x, xi) => (xi === oi ? e.target.value : x)) })}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); patch(q.uid, { options: [...q.options.slice(0, oi + 1), '', ...q.options.slice(oi + 1)] }); } }} />
                          <button type="button" aria-label="Убрать вариант" className={iconBtn}
                            onClick={() => patch(q.uid, { options: q.options.filter((_, xi) => xi !== oi) })}><X size={14} /></button>
                        </div>
                      ))}
                      <button type="button" onClick={() => patch(q.uid, { options: [...q.options, ''] })}
                        className="inline-flex min-h-11 items-center gap-1 self-start rounded-lg px-2 text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
                        <Plus size={14} /> Вариант
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            <button type="button" onClick={() => setItems(l => [...l, blank()])} className={`${btnIdle} self-start`}>
              <Plus size={14} /> Добавить вопрос
            </button>
          </>
        )}

        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-overlay)] px-4 py-2">
          <button type="button" onClick={close} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy || !dirty} onClick={save}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white disabled:opacity-50">{busy ? 'Сохраняю…' : 'Сохранить'}</button>
        </div>
      </div>
    </Modal>
  );
}

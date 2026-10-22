'use client';
// Заполнение анкеты товарной группы. Сейчас — предпросмотр в редакторе («как увидит менеджер»);
// дальше этот же компонент встанет в бриф карточки клиента.
import type { GroupQuestion } from '../engine/types';

export type Answers = Record<string, string | string[]>;
export const answerKey = (q: GroupQuestion, i: number) => (q.id !== null ? String(q.id) : `new${i}`);

const field = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base sm:text-sm text-[var(--color-text)]';

export function QuestionnaireForm({ questions, value, onChange, disabled = false }: {
  questions: GroupQuestion[]; value: Answers; onChange: (v: Answers) => void; disabled?: boolean;
}) {
  if (!questions.length) return <p className="text-sm text-[var(--color-text-muted)]">Вопросов пока нет.</p>;
  const set = (k: string, v: string | string[]) => onChange({ ...value, [k]: v });
  return (
    <div className="flex flex-col gap-4">
      {questions.map((q, i) => {
        const k = answerKey(q, i);
        const cur = value[k];
        const name = `q-${k}`;
        return (
          <fieldset key={k} className="flex min-w-0 flex-col gap-1.5" disabled={disabled}>
            <legend className="mb-1 text-sm font-semibold text-[var(--color-text)]">
              {i + 1}. {q.question}{q.required && <span className="text-[var(--color-negative)]"> *</span>}
            </legend>
            {q.hint && <p className="-mt-1 text-xs text-[var(--color-text-muted)]">{q.hint}</p>}
            {q.kind === 'text' && (
              <textarea rows={2} value={typeof cur === 'string' ? cur : ''} onChange={e => set(k, e.target.value)} className={field} />
            )}
            {q.kind !== 'text' && (
              <div className="flex flex-col gap-0.5">
                {q.options.map(o => {
                  const multi = q.kind === 'multi';
                  const checked = multi ? Array.isArray(cur) && cur.includes(o) : cur === o;
                  return (
                    <label key={o} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
                      <input type={multi ? 'checkbox' : 'radio'} name={name} checked={checked}
                        onChange={() => {
                          if (!multi) return set(k, o);
                          const list = Array.isArray(cur) ? cur : [];
                          set(k, checked ? list.filter(x => x !== o) : [...list, o]);
                        }}
                        className="h-4 w-4 shrink-0 accent-[var(--color-accent)]" />
                      <span className="min-w-0">{o}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}

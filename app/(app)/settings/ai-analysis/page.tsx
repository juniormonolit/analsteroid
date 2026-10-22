import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { systemPrompt, PROMPT_VERSION } from '@/features/ai-analysis/engine/prompt';
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, PRICE_RUB_PER_M } from '@/features/ai-analysis/engine/llm';
import { journal, MAX_PER_DAY } from '@/features/ai-analysis/engine/store';

// ИИ-анализ звонков: промпт (только просмотр — решение владельца 22.10, редактор с тест-прогоном —
// этап 2) и журнал запусков с расходом. Только супер-администраторы («промпт правят только админы»).
export const metadata = { title: 'ИИ-анализ звонков — Монолитика' };
export const dynamic = 'force-dynamic';

const fmtDT = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
const STATUS: Record<string, string> = { queued: 'в очереди', running: 'идёт', done: 'готов', error: 'ошибка' };

export default async function Page() {
  const session = await getSession();
  if (!session?.isSuperadmin) return <AccessDenied reason="Настройки ИИ-анализа доступны только супер-администратору." />;
  const j = await journal(50).catch(() => null);

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex max-w-4xl min-w-0 flex-col gap-4 p-4">
        <div>
          <h1 className="text-[20px] font-bold">ИИ-анализ звонков</h1>
          <p className="text-[13px] text-[var(--color-text-muted)]">
            Вкладка «ИИ-анализ» в карточке клиента. Запускают пользователи с правом «ИИ-анализ звонков заказчика»
            (выдаётся ролям РОП в «Настройки → Роли»). Модель {DEFAULT_MODEL}, reasoning_effort {DEFAULT_REASONING_EFFORT}, лимит {MAX_PER_DAY} запусков в день на человека.
          </p>
        </div>

        <section className="min-w-0 rounded-xl border border-[var(--color-border)] p-3">
          <h2 className="mb-2 text-[15px] font-bold">Расход</h2>
          {j ? (
            <div className="text-[13px]">
              В этом месяце: {j.monthCount} анализов, ≈ {j.monthRub.toFixed(2)} ₽ (оценка по тарифу {PRICE_RUB_PER_M.input}/{PRICE_RUB_PER_M.output} ₽ за 1 млн
              токенов вход/выход — сверяйте со списанием в кабинете Cloud.ru).
            </div>
          ) : <div className="text-[13px] text-[var(--color-negative)]">Таблица ai_analyses недоступна — накатите миграцию 247.</div>}
        </section>

        {j && j.rows.length > 0 && (
          <section className="min-w-0 rounded-xl border border-[var(--color-border)] p-3">
            <h2 className="mb-2 text-[15px] font-bold">Журнал запусков</h2>
            <div className="scroll-x">
              <table className="w-full min-w-[640px] text-[12.5px]">
                <thead className="text-left text-[var(--color-text-muted)]">
                  <tr><th className="py-1 pr-3">Когда</th><th className="pr-3">Кто</th><th className="pr-3">Заказчик</th><th className="pr-3">Статус</th><th className="pr-3">Звонков</th><th className="pr-3">₽</th><th className="pr-3">Отзыв</th></tr>
                </thead>
                <tbody>
                  {j.rows.map(r => (
                    <tr key={r.id} className="border-t border-[var(--color-border)] align-top">
                      <td className="py-1 pr-3 tabular-nums">{fmtDT(r.createdAt)}</td>
                      <td className="pr-3">{r.createdByName ?? r.createdBy}</td>
                      <td className="pr-3">{r.clientRef}</td>
                      <td className="pr-3">{STATUS[r.status] ?? r.status}{r.error ? ` — ${r.error.slice(0, 80)}` : ''}</td>
                      <td className="pr-3 tabular-nums">{r.callsCount ?? '—'}</td>
                      <td className="pr-3 tabular-nums">{r.costRub ?? '—'}</td>
                      <td className="pr-3">{r.feedback === 'useful' ? '👍' : r.feedback === 'inaccurate' ? `👎 ${r.feedbackNote ?? ''}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="min-w-0 rounded-xl border border-[var(--color-border)] p-3">
          <h2 className="mb-1 text-[15px] font-bold">Промпт · версия {PROMPT_VERSION}</h2>
          <p className="mb-2 text-[12px] text-[var(--color-text-muted)]">
            Только просмотр. Меняется в коде (features/ai-analysis/engine/prompt.ts) с повышением версии — каждый отчёт помнит,
            по какой версии сделан. Перед системной частью модель получает данные заказчика: сделки, «Факты из CRM» (считает код)
            и обезличенные расшифровки.
          </p>
          <pre className="max-h-[70dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--color-surface-2,var(--color-bg))] p-3 text-[12px] leading-relaxed">{systemPrompt()}</pre>
        </section>
      </div>
    </div>
  );
}

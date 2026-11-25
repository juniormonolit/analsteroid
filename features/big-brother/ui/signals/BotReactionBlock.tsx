'use client';
// Реакция на сообщения бота «Аналитик»: ушло → открыл Монолитику → сделал действие / пошёл рабочий сигнал (24 ч).
import type { BotReactionSummary } from '../../engine/signals/types';
import { CARD, fmtTime } from '../people/shared';

const fmtWait = (m: number | null) => (m == null ? '—' : m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60 ? `${m % 60} мин` : ''}`.trim());
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short' });

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={`${CARD} min-w-0 p-3`}>
      <div className="text-xs text-[var(--color-text-secondary)]">{label}</div>
      <div className="text-xl font-semibold tabular-nums text-[var(--color-text)]">{value}</div>
      {hint && <div className="text-xs text-[var(--color-text-muted)]">{hint}</div>}
    </div>
  );
}

export function BotReactionBlock({ bot }: { bot: BotReactionSummary }) {
  return (
    <section className={`${CARD} flex min-w-0 flex-col gap-3 p-3`}>
      <h2 className="text-sm font-semibold text-[var(--color-text)]">Реакция на сообщения бота</h2>
      {!bot.available ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          Журнал сообщений бота ещё не подключён (миграция 297). После выкатки данные начнут копиться — здесь будет видно, через
          сколько человек открывает Монолитику и берётся за дело после сообщения.
        </p>
      ) : (
        <>
          <p className="text-xs text-[var(--color-text-muted)]">
            {bot.since ? `Копится с ${fmtDay(bot.since)}. ` : ''}За 30 дней, только сообщения старше суток. «Открыл» — по ссылке из сообщения или
            любой вход в Монолитику в течение 24 ч; «Действие» — изменение в сервисе, звонок, смена стадии или задача.
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="Сообщений" value={String(bot.total)} />
            <Tile label="Открыли" value={pct(bot.opened, bot.total)} hint={`медиана ${fmtWait(bot.medianOpenMin)}`} />
            <Tile label="Взялись за дело" value={pct(bot.acted, bot.total)} hint={`медиана ${fmtWait(bot.medianActMin)}`} />
            <Tile label="Без реакции" value={pct(bot.silent, bot.total)} hint={`${bot.silent} сообщ.`} />
          </div>
          {bot.byChannel.length > 0 && (
            <div className="scroll-x">
              <table className="w-full min-w-[420px] text-sm">
                <thead><tr className="text-left text-[var(--color-text-secondary)]">
                  <th className="px-2 py-1.5 font-medium">Функция бота</th><th className="px-2 py-1.5 text-right font-medium">Сообщений</th>
                  <th className="px-2 py-1.5 text-right font-medium">Открыли</th><th className="px-2 py-1.5 text-right font-medium">Действие</th>
                  <th className="px-2 py-1.5 text-right font-medium">Медиана до действия</th>
                </tr></thead>
                <tbody>
                  {bot.byChannel.map(c => (
                    <tr key={c.channel} className="border-t border-[var(--color-border)] text-[var(--color-text)]">
                      <td className="px-2 py-1.5">{c.channel}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{c.total}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{pct(c.opened, c.total)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{pct(c.acted, c.total)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtWait(c.medianActMin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {bot.recent.length > 0 && (
            <details>
              <summary className="min-h-11 cursor-pointer py-2 text-sm text-[var(--color-accent)]">Последние сообщения ({bot.recent.length})</summary>
              <div className="scroll-x">
                <table className="w-full min-w-[560px] text-sm">
                  <thead><tr className="text-left text-[var(--color-text-secondary)]">
                    <th className="px-2 py-1.5 font-medium">Когда</th><th className="px-2 py-1.5 font-medium">Кому</th>
                    <th className="px-2 py-1.5 font-medium">Функция</th><th className="px-2 py-1.5 text-right font-medium">Открыл через</th>
                    <th className="px-2 py-1.5 text-right font-medium">Действие через</th>
                  </tr></thead>
                  <tbody>
                    {bot.recent.map(r => (
                      <tr key={r.messageId} className="border-t border-[var(--color-border)] text-[var(--color-text)]">
                        <td className="px-2 py-1.5 tabular-nums">{fmtDay(r.sentAt)} {fmtTime(r.sentAt)}</td>
                        <td className="px-2 py-1.5">{r.recipientName ?? r.recipientId}</td>
                        <td className="px-2 py-1.5">{r.channel ?? '—'}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtWait(r.openMin)}{r.openedByLink ? ' · по ссылке' : ''}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtWait(r.actMin)}{r.actKind ? ` · ${r.actKind}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}

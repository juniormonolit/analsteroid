'use client';
// Чат задачи прямо в канбане (встреча 11.11). С 25.11 — на общей ленте TaskThread (свои справа от смотрящего, служебные
// свёрнуты, автосообщения канбана — событиями) и компактном композере ThreadComposer (владелец 25.11 + спецификация Fable):
// шаблоны — кнопкой «Шаблоны» и одним чипом «по стадии», «Отметить» — кнопкой @. Отправка — action 'comment' от имени нажавшего.
import { Paperclip } from 'lucide-react';
import type { BigTaskCard } from '../engine/types';
import type { BigChatFile, BigChatMessage } from '../engine/taskDetails';
import { postBigAction } from './TaskDrawerShared';
import { TaskThread, ThreadComposer, type MentionTarget } from './TaskThread';

export function TaskChat({ card, messages, loading, onSent, questions, rop, inject, me = null, lastSeenAt = null, mock = false, className = '' }: {
  card: BigTaskCard; messages: BigChatMessage[] | null; loading: boolean; onSent: (card?: BigTaskCard) => void;
  /** Вопросы из описания задачи — в «Шаблонах». */
  questions?: string[];
  /** РОП исполнителя — в «@». */
  rop?: { id: string; name: string } | null;
  /** Текст снаружи (ИИ-оценка: «Спросить по красным и жёлтым») — дописывается в черновик. */
  inject?: { text: string; key: number } | null;
  /** Bitrix id смотрящего: свои сообщения — справа, себя в «@» не показываем. */
  me?: string | null;
  /** Когда смотрящий открывал карточку в прошлый раз — разделитель «новое». */
  lastSeenAt?: string | null;
  mock?: boolean;
  className?: string;
}) {
  // Кого можно отметить: ответственный по сделке первым (Осипов 24.11), исполнитель, РОП. Себя — нет.
  const mentions: MentionTarget[] = [];
  const roles: Record<string, string> = {};
  const addM = (p: { id: string; name: string } | null | undefined, role: string) => {
    if (!p?.id || !/^\d+$/.test(p.id)) return;
    roles[p.id] ??= role;
    if (p.id !== me && !mentions.some(m => m.id === p.id)) mentions.push({ id: p.id, name: p.name, role });
  };
  addM(card.responsible, 'исполнитель');
  addM(card.deal?.assigned, 'по сделке');
  addM(rop, 'РОП');
  // В «@» ответственный по сделке — первым.
  mentions.sort((a, b) => (a.role === 'по сделке' ? -1 : b.role === 'по сделке' ? 1 : 0));

  return (
    <section className={`flex min-h-0 min-w-0 flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] ${className}`}>
      <h3 className="px-3 pt-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Чат задачи</h3>
      <TaskThread messages={messages} viewerId={me} roles={roles} lastSeenAt={lastSeenAt} loading={loading}
        className="min-h-40 flex-1 px-3 py-2" />
      <div className="border-t border-[var(--color-border)] p-2">
        <ThreadComposer mentions={mentions} questions={questions} deal={card.deal} mock={mock} inject={inject}
          placeholder="Сообщение менеджеру — уйдёт в чат задачи от вашего имени"
          onSend={async (text, attachments) => {
            if (mock) { onSent(); return; }
            const r = await postBigAction({ type: 'comment', taskId: card.id, text, attachments });
            onSent(r.card);
            return r.warnings;
          }} />
      </div>
    </section>
  );
}

/** Файл в ленте чата (Осипов 23.11: «не открыть файл из чата») — ссылка в Битрикс, имя вебхуку неизвестно. */
export function ChatFileLink({ file }: { file: BigChatFile }) {
  const label = file.name === 'файл' ? 'Файл — открыть в Битриксе' : file.name;
  return file.url ? (
    <a href={file.url} target="_blank" rel="noreferrer" title="Откроется в Битриксе (нужен вход в Битрикс)"
      className="flex min-h-8 min-w-0 items-center gap-1 text-[12.5px] text-[var(--color-accent)] underline">
      <Paperclip size={12} className="shrink-0" aria-hidden /><span className="min-w-0 truncate">{label}</span>
    </a>
  ) : (
    <div className="flex min-w-0 items-center gap-1 text-[12.5px] text-[var(--color-text-secondary)]">
      <Paperclip size={12} className="shrink-0" aria-hidden /><span className="min-w-0 truncate">{file.name}</span>
    </div>
  );
}

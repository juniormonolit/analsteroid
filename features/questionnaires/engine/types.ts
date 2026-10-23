// Типы анкет товарных групп — общие для сервера и клиента (без драйвера БД).

export type QuestionKind = 'text' | 'single' | 'multi';
export const QUESTION_KINDS: { value: QuestionKind; label: string }[] = [
  { value: 'text', label: 'Текст' },
  { value: 'single', label: 'Один вариант' },
  { value: 'multi', label: 'Несколько вариантов' },
];
/** Общие вопросы — для любого заказчика, независимо от товарной группы. */
export const COMMON_GROUP = '*';
export const MAX_QUESTIONS = 40;
export const MAX_OPTIONS = 30;

/** Кому вопрос (миграция 251): клиенту — в анкету карточки клиента и задачу; проверка менеджера — только разбор
 *  звонков и РОП (менеджеру в карточке не показывается). */
export type QuestionAudience = 'client' | 'manager_check';
export const QUESTION_AUDIENCES: { value: QuestionAudience; label: string; hint: string }[] = [
  { value: 'client', label: 'Вопрос клиенту', hint: 'менеджер видит в анкете карточки клиента и в задаче' },
  { value: 'manager_check', label: 'Проверка менеджера', hint: 'сделал ли менеджер это в разговоре — только для разбора звонков и РОПа' },
];

/** Похоже на проверку менеджера, а не вопрос клиенту: «Уточнил, что строится?», «Предложил бетон?», «Менеджер…»
 *  (живой случай 23.10 — анкета «Арматура»: такие ушли менеджеру в «Выяснить»). Только подсказка в редакторе. */
export const LOOKS_LIKE_CHECK = /^\s*(менеджер|уточнил|предложил|спросил|рассказал|выяснил|озвучил|назвал|договорил|объяснил|сообщил|узнал)/i;
export const looksLikeCheck = (q: Pick<GroupQuestion, 'question' | 'audience'>) => q.audience === 'client' && LOOKS_LIKE_CHECK.test(q.question);

export interface GroupQuestion {
  /** null — новый, ещё не сохранён. */
  id: number | null;
  question: string;
  hint: string | null;
  kind: QuestionKind;
  options: string[];
  required: boolean;
  audience: QuestionAudience;
}

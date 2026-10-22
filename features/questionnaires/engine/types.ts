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

export interface GroupQuestion {
  /** null — новый, ещё не сохранён. */
  id: number | null;
  question: string;
  hint: string | null;
  kind: QuestionKind;
  options: string[];
  required: boolean;
}

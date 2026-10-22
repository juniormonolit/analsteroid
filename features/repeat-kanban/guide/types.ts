// Гид «Как работать?» канбана повторных (владелец 22.10). Контент — данные (content.ts), страница
// рендерит их (ui/GuidePage.tsx). ПРАВИЛО (CLAUDE.md): меняешь поведение канбана — правь content.ts
// в том же коммите, иначе инструкция отстаёт от приложения.
//
// Разметка в строках — минимальная: **жирный**, `кнопка` (выглядит как кнопка интерфейса).

export type GuideBlock =
  | { type: 'p'; text: string }
  /** Нумерованные шаги «сделай так». */
  | { type: 'steps'; items: string[] }
  | { type: 'list'; items: string[] }
  /** Совет / лайфхак (зелёная плашка). */
  | { type: 'tip'; text: string }
  /** Частая ошибка / «так не делать» (оранжевая плашка). */
  | { type: 'warn'; text: string }
  /** Таблица «если … → что делать». */
  | { type: 'table'; head: string[]; rows: string[][] }
  /** Скриншот: файл public/guide/repeat-kanban/<id>.jpg (снимает разработчик); пока файла нет — рамка с описанием. */
  | { type: 'shot'; id: string; caption: string; what: string }
  /** Мини-квиз для самопроверки: вопрос, варианты, индекс верного, пояснение. */
  | { type: 'quiz'; q: string; options: string[]; answer: number; why: string };

export interface GuideSection {
  /** Якорь в URL (#id) и ключ оглавления. */
  id: string;
  title: string;
  /** Одна строка-подзаголовок: зачем читать раздел. */
  lead: string;
  /** Иконка lucide-react по имени (см. ICONS в GuidePage). */
  icon: string;
  /** Для кого раздел; не задано — для всех. */
  audience?: 'rop' | 'manager';
  /** Право, без которого раздел не показывается вовсе (фильтр на сервере — текст не уходит в браузер).
   *  ИИ-анализ: владелец 23.10 — «не хочу, чтобы менеджеры знали, что это ИИ пишет». */
  perm?: string;
  blocks: GuideBlock[];
}

export interface Guide {
  title: string;
  /** Дата последней правки содержимого (YYYY-MM-DD) — видна внизу страницы. */
  updated: string;
  intro: string;
  sections: GuideSection[];
}

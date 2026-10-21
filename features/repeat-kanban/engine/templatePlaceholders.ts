// Плейсхолдеры шаблонов сообщений к задаче канбана повторных (владелец 21.10).
// Файл без импортов БД — его тянет и клиентский редактор шаблонов.
//
// В БД шаблон хранится с машинными ключами: {{client}}, {{last_purchase}}…
// В редакторе РОП/админ видит русские названия: {{Заказчик}}, {{Последняя покупка}}…
// Перевод туда-обратно — toDisplayBody/toStoredBody. renderTemplate понимает оба
// написания (на случай, если русское название вставили руками через API).

export interface PlaceholderDef {
  key: string;
  /** Русское название — так плейсхолдер выглядит в редакторе. */
  label: string;
  /** Что подставится — подсказка на кнопке-вставке. */
  hint: string;
}

export const PLACEHOLDERS: readonly PlaceholderDef[] = [
  { key: 'client', label: 'Заказчик', hint: 'Имя заказчика из Битрикса' },
  { key: 'manager', label: 'Менеджер', hint: 'Имя ответственного менеджера' },
  { key: 'last_purchase', label: 'Последняя покупка', hint: 'Товарные группы последней отгрузки, дата и сумма' },
  { key: 'recommended', label: 'Рекомендуемые материалы', hint: 'Что вероятно нужно сейчас — те же рекомендации, что в карточке клиента' },
  { key: 'days_since', label: 'Дней с отгрузки', hint: 'Сколько дней прошло с последней отгрузки' },
  { key: 'shipments', label: 'Число отгрузок', hint: 'Сколько раз покупал (дробные отгрузки одной покупки — одна)' },
  { key: 'ltv', label: 'Сумма отгрузок', hint: 'Сумма всех отгрузок за всё время' },
  { key: 'window_until', label: 'Окно открыто до', hint: 'До какого числа открыто окно повторной продажи (последняя отгрузка + 22 дня)' },
];

const BY_KEY = new Map(PLACEHOLDERS.map(p => [p.key, p]));
const BY_LABEL = new Map(PLACEHOLDERS.map(p => [p.label.toLowerCase(), p]));

/** {{ ключ }} — пробелы внутри скобок допускаются. */
export const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Ключ плейсхолдера по написанию (машинный ключ или русское название), иначе null. */
export function placeholderKey(raw: string): string | null {
  const t = raw.trim();
  if (BY_KEY.has(t)) return t;
  return BY_LABEL.get(t.toLowerCase())?.key ?? null;
}

/** Хранимый текст → текст редактора (машинные ключи → русские названия). */
export function toDisplayBody(body: string): string {
  return body.replace(PLACEHOLDER_RE, (m, raw: string) => {
    const k = placeholderKey(raw);
    return k ? `{{${BY_KEY.get(k)!.label}}}` : m;
  });
}

/** Текст редактора → хранимый (русские названия → машинные ключи; неизвестные — как есть). */
export function toStoredBody(body: string): string {
  return body.replace(PLACEHOLDER_RE, (m, raw: string) => {
    const k = placeholderKey(raw);
    return k ? `{{${k}}}` : m;
  });
}

// Конструктор фраз дайджеста «Как дела?»: блок → варианты. При сборке текста для
// каждого блока берётся один вариант (сид — дата и час, чтобы повтор отправки в тот
// же час давал тот же текст, а соседние выпуски — разный). Плейсхолдеры в фигурных
// скобках подставляет text.ts; список допустимых — в PLACEHOLDERS, его же показывает
// вкладка настроек. Владелец правит варианты в «Настройки → Боты → Аналитик → Как
// дела?»; пустой список у блока = стандартные фразы отсюда.

export interface PhraseBlock {
  key: string;
  title: string;
  hint: string;
  placeholders: string[];
  defaults: string[];
}

const NUM = ['fact', 'plan', 'pct', 'usual', 'deals', 'usual_deals', 'deals_w', 'usual_deals_w'];

export const PHRASE_BLOCKS: PhraseBlock[] = [
  {
    key: 'title', title: 'Заголовок', hint: 'Первая строка сообщения (жирная, крупнее). Плейсхолдеры с _w — число со словом: «73 сделки».',
    placeholders: ['weekday', 'date', 'time'],
    defaults: [
      'Как дела? · {weekday} {date}, {time}',
      'Сводка на {time} · {weekday}, {date}',
      '{time} · как идём сегодня',
    ],
  },
  {
    key: 'company_behind', title: 'Компания — ниже обычного', hint: 'Продаж к этому часу меньше привычного (< 85 % от обычного).',
    placeholders: ['time_words', ...NUM],
    defaults: [
      'Обычно к {time_words} — {usual}. Сегодня идём вяло: {deals_w}, обычно {usual_deals}.',
      'Ниже привычного: в средний день к {time_words} уже {usual}.',
      'Отстаём от себя — обычно к этому часу {usual}. Сделок {deals} против {usual_deals}.',
    ],
  },
  {
    key: 'company_ahead', title: 'Компания — выше обычного', hint: 'Продаж к этому часу больше привычного (> 115 %).',
    placeholders: ['time_words', ...NUM],
    defaults: [
      'Обычно к {time_words} — {usual}. Сегодня заметно бодрее: {deals_w} против {usual_deals}.',
      'Хороший день: в средний день к {time_words} только {usual}.',
      'Идём с опережением своего темпа — обычно к этому часу {usual}.',
    ],
  },
  {
    key: 'company_normal', title: 'Компания — как обычно', hint: 'Продажи в пределах ±15 % от обычного.',
    placeholders: ['time_words', ...NUM],
    defaults: [
      'Обычно к {time_words} — {usual}. Ровно наш темп.',
      'Без сюрпризов: обычный день, к этому часу в среднем {usual}.',
      'В своём ритме — привычные {usual} к {time_words}.',
    ],
  },
  {
    key: 'funnel_ok', title: 'Воронка — в норме', hint: 'Брони и новые сделки близки к обычному.',
    placeholders: ['books', 'usual_books', 'created', 'usual_created'],
    defaults: [
      'Воронка в норме: {books} броней, {created} новых сделок.',
      'По воронке спокойно — броней {books}, новых {created}.',
    ],
  },
  {
    key: 'funnel_weak', title: 'Воронка — проседает', hint: 'Броней заметно меньше обычного (< 80 %).',
    placeholders: ['books', 'usual_books', 'created', 'usual_created'],
    defaults: [
      'Брони проседают: {books} против обычных {usual_books}. Завтра может быть тише.',
      'Тревожно по воронке — броней {books}, обычно {usual_books}.',
    ],
  },
  {
    key: 'funnel_strong', title: 'Воронка — сильнее обычного', hint: 'Броней заметно больше обычного (> 120 %).',
    placeholders: ['books', 'usual_books', 'created', 'usual_created'],
    defaults: [
      'Воронка кормится: {books} броней против обычных {usual_books}. Задел на завтра есть.',
      'По броням бодро — {books} против {usual_books}.',
    ],
  },
  {
    key: 'trend_ahead', title: 'Метка филиала — выше обычного', hint: 'Короткая метка в строке филиала (зелёная).',
    placeholders: [],
    defaults: ['↑ лучше обычного', '↑ выше своего темпа', '↑ бодрее обычного'],
  },
  {
    key: 'trend_behind', title: 'Метка филиала — ниже обычного', hint: 'Короткая метка в строке филиала (красная).',
    placeholders: [],
    defaults: ['↓ ниже обычного', '↓ отстаём от своего темпа', '↓ слабее обычного'],
  },
  {
    key: 'trend_normal', title: 'Метка филиала — как обычно', hint: 'Короткая метка в строке филиала (серая).',
    placeholders: [],
    defaults: ['→ как обычно', '→ в своём ритме', '→ обычный день'],
  },
  {
    key: 'branch_ahead', title: 'Филиал — вступление, выше обычного', hint: 'Серая строка под заголовком филиала, когда он выше своего обычного уровня.',
    placeholders: ['name', 'fact', 'usual', 'pct'],
    defaults: [
      'Выше своего темпа — обычно {usual}.',
      'Лучший филиал дня: обычно к этому часу {usual}.',
      'Бодрее обычного ({usual}).',
    ],
  },
  {
    key: 'branch_behind', title: 'Филиал — вступление, ниже обычного', hint: 'Серая строка под заголовком филиала, когда он ниже своего обычного уровня.',
    placeholders: ['name', 'fact', 'usual', 'gap'],
    defaults: [
      'Минус {gap} к обычному ({usual}).',
      'Отстаёт от себя — обычно {usual}.',
      'Тише обычного: в средний день уже {usual}.',
    ],
  },
  {
    key: 'branch_normal', title: 'Филиал — вступление, как обычно', hint: 'Серая строка под заголовком филиала при обычном темпе.',
    placeholders: ['name', 'fact', 'usual'],
    defaults: [
      'Обычный темп ({usual}).',
      'В своём ритме — обычно {usual}.',
    ],
  },
  {
    key: 'heroes', title: 'Молодцы', hint: 'Заголовок блока героев; сами люди — строками ниже.',
    placeholders: ['list'],
    defaults: [
      '⭐ [B]Кто отличился[/B]',
      '⭐ [B]Молодцы[/B]',
      '⭐ [B]Герои дня[/B]',
    ],
  },
  {
    key: 'footer_next', title: 'Подпись — следующая сводка', hint: 'Последняя строка дневных выпусков.',
    placeholders: ['next_time'],
    defaults: [
      'Продолжим в {next_time}.',
      'Следующая сводка в {next_time}.',
    ],
  },
  {
    key: 'footer_evening', title: 'Подпись — вечерний выпуск', hint: 'Последняя строка выпуска с итогом месяца.',
    placeholders: ['next_time'],
    defaults: [
      'На сегодня всё. Завтра в {next_time}.',
      'Итоги подведены — увидимся завтра в {next_time}.',
    ],
  },
  {
    key: 'pace_ahead', title: 'Темп месяца — опережаем', hint: 'Доля плана к сегодняшнему дню выше типичной. {kind} — «продажам»/«отгрузкам».',
    placeholders: ['kind', 'mtd', 'plan', 'share', 'typical', 'forecast', 'need', 'day', 'days'],
    defaults: [
      'По {kind} опережаем: {share} % плана к {day}-му дню из {days}, обычно {typical} %. Прогноз месяца — {forecast}.',
      '{kind_cap}: {share} % плана при типичных {typical} % — впереди графика. Так закроем на {forecast}.',
    ],
  },
  {
    key: 'pace_behind', title: 'Темп месяца — отстаём', hint: 'Доля плана к сегодняшнему дню ниже типичной.',
    placeholders: ['kind', 'mtd', 'plan', 'share', 'typical', 'forecast', 'need', 'day', 'days'],
    defaults: [
      'По {kind} не успеваем: {share} % плана к {day}-му дню из {days}, обычно {typical} %. До плана нужно по {need} в день.',
      '{kind_cap}: {share} % плана при типичных {typical} % — отстаём. Прогноз {forecast}, нужно {need} в день.',
    ],
  },
  {
    key: 'pace_ontrack', title: 'Темп месяца — по графику', hint: 'Доля плана к сегодняшнему дню близка к типичной (±3 п.п.).',
    placeholders: ['kind', 'mtd', 'plan', 'share', 'typical', 'forecast', 'need', 'day', 'days'],
    defaults: [
      'По {kind} идём по графику: {share} % плана к {day}-му дню, типично {typical} %. Прогноз — {forecast}.',
      '{kind_cap}: {share} % плана — типичный темп ({typical} %). Прогноз {forecast}.',
    ],
  },
];

export type PhraseOverrides = Record<string, string[]>;

/** Итоговые варианты блока: переопределения владельца, иначе стандартные. */
export function phraseVariants(key: string, overrides: PhraseOverrides): string[] {
  const own = overrides[key]?.map(s => s.trim()).filter(Boolean);
  if (own?.length) return own;
  return PHRASE_BLOCKS.find(b => b.key === key)?.defaults ?? [];
}

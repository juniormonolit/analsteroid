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
      'Компания к {time_words} продала [B]{fact} из {plan}[/B] дневного плана — {pct} %. Обычно к этому часу бывает {usual}, так что сегодня идём вяло: сделок {deals} против {usual_deals}.',
      'К {time_words} — [B]{fact} из {plan}[/B] плана дня ({pct} %). Это ниже привычных {usual}: {deals_w}, обычно к этому часу {usual_deals}.',
      'Пока отстаём: [B]{fact}[/B] при дневном плане {plan} — {pct} %. В обычный день к {time_words} уже {usual}.',
    ],
  },
  {
    key: 'company_ahead', title: 'Компания — выше обычного', hint: 'Продаж к этому часу больше привычного (> 115 %).',
    placeholders: ['time_words', ...NUM],
    defaults: [
      'Хороший день: к {time_words} уже [B]{fact} из {plan}[/B] дневного плана — {pct} %. Обычно к этому часу {usual}, сегодня заметно бодрее ({deals_w} против {usual_deals}).',
      'Компания идёт с опережением: [B]{fact} из {plan}[/B] ({pct} %) при обычных {usual} к {time_words}.',
      'К {time_words} — [B]{fact}[/B], это {pct} % плана дня и выше привычного уровня ({usual}). Сделок {deals}, обычно {usual_deals}.',
    ],
  },
  {
    key: 'company_normal', title: 'Компания — как обычно', hint: 'Продажи в пределах ±15 % от обычного.',
    placeholders: ['time_words', ...NUM],
    defaults: [
      'К {time_words} компания продала [B]{fact} из {plan}[/B] дневного плана — {pct} %. Ровно наш обычный темп: в среднем к этому часу {usual}.',
      'Идём в своём ритме: [B]{fact} из {plan}[/B] ({pct} %), обычно к {time_words} бывает {usual}. Сделок {deals}.',
      'Без сюрпризов — [B]{fact}[/B] при плане дня {plan}, {pct} %. Обычный уровень к этому часу — {usual}.',
    ],
  },
  {
    key: 'funnel_ok', title: 'Воронка — в норме', hint: 'Брони и новые сделки близки к обычному.',
    placeholders: ['books', 'usual_books', 'created', 'usual_created'],
    defaults: [
      'Брони — {books} (обычно {usual_books}), новых сделок {created} — воронка в норме.',
      'По воронке спокойно: броней {books}, новых сделок {created}, всё около привычных значений.',
    ],
  },
  {
    key: 'funnel_weak', title: 'Воронка — проседает', hint: 'Броней заметно меньше обычного (< 80 %).',
    placeholders: ['books', 'usual_books', 'created', 'usual_created'],
    defaults: [
      'Брони проседают: {books} против обычных {usual_books} — завтрашние продажи под вопросом. Новых сделок {created}.',
      'Тревожный сигнал по воронке: броней {books}, обычно к этому часу {usual_books}. Новых сделок {created} (обычно {usual_created}).',
    ],
  },
  {
    key: 'funnel_strong', title: 'Воронка — сильнее обычного', hint: 'Броней заметно больше обычного (> 120 %).',
    placeholders: ['books', 'usual_books', 'created', 'usual_created'],
    defaults: [
      'Воронка кормится: броней {books} против обычных {usual_books}, новых сделок {created}. Задел на завтра есть.',
      'По броням бодро — {books} (обычно {usual_books}); новых сделок {created}.',
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
    key: 'branch_ahead', title: 'Филиал — вступление, выше обычного', hint: 'Первая фраза блока филиала, когда он выше своего обычного уровня.',
    placeholders: ['name', 'fact', 'usual', 'pct'],
    defaults: [
      'Филиал сегодня тащит компанию: обычно к этому часу тут {usual}.',
      '{name} идёт заметно выше своего обычного — {fact} при привычных {usual}.',
      'Лучший филиал дня: {fact} против обычных {usual}.',
    ],
  },
  {
    key: 'branch_behind', title: 'Филиал — вступление, ниже обычного', hint: 'Первая фраза блока филиала, когда он ниже своего обычного уровня.',
    placeholders: ['name', 'fact', 'usual', 'gap'],
    defaults: [
      'Обычно к этому часу {name} на {usual}, сегодня минус {gap}.',
      '{name} отстаёт от себя: {fact} вместо привычных {usual}.',
      'Здесь сегодня тише обычного — {fact}, а в среднем к этому часу {usual}.',
    ],
  },
  {
    key: 'branch_normal', title: 'Филиал — вступление, как обычно', hint: 'Первая фраза блока филиала при обычном темпе.',
    placeholders: ['name', 'fact', 'usual'],
    defaults: [
      'Обычный темп: {fact} при привычных {usual} к этому часу.',
      '{name} в своём ритме — {fact}, как и в средний день.',
    ],
  },
  {
    key: 'dept_leader', title: 'Отдел-лидер', hint: 'Отдел с лучшим выполнением дневного плана в филиале.',
    placeholders: ['dept', 'pct', 'fact', 'plan', 'deals', 'usual_deals', 'deals_w', 'usual_deals_w', 'top'],
    defaults: [
      '{dept} уже на [B]{pct} % дневного плана[/B] — {fact} из {plan}{top}.',
      'Впереди {dept}: {fact} из {plan} ({pct} %), {deals_w} против обычных {usual_deals}{top}.',
      '{dept} — единственные в графике: {fact} из {plan}, {pct} %{top}.',
    ],
  },
  {
    key: 'dept_lagging', title: 'Отделы-отстающие', hint: 'Перечисление отделов ниже 25 % дневного плана; {list} — «Команда Новикова 9 % (0,2 из 2,9), Руденко 16 %».',
    placeholders: ['list'],
    defaults: [
      'Дальше провал: {list}.',
      'Отстают: {list}.',
      'Не добирают: {list}.',
    ],
  },
  {
    key: 'dept_alarm', title: 'Отдел — тревога дня', hint: 'Отдел сильно ниже своего обычного уровня (< 40 %). {names} — менеджеры отдела без продаж.',
    placeholders: ['dept', 'fact', 'usual', 'names'],
    defaults: [
      '[B]{dept}[/B] — главная тревога дня: {fact} при обычных {usual}. {names} в обычный день к этому часу уже с продажами, сегодня — без.',
      '[B]{dept}[/B] сильно ниже себя: {fact} вместо привычных {usual}. Без продаж пока {names}.',
    ],
  },
  {
    key: 'dept_zero', title: 'Отдел без продаж', hint: 'Отдел с планом, но без единой продажи к этому часу.',
    placeholders: ['dept', 'plan', 'usual'],
    defaults: [
      '{dept} пока по нулям при плане {plan} — обычно к этому часу уже {usual}.',
      'У {dept} ещё ни одной продажи (план дня {plan}).',
    ],
  },
  {
    key: 'goods_up', title: 'Товары — выше обычного', hint: 'Строка ⬆ по товарной группе.',
    placeholders: ['group', 'branch', 'fact', 'usual', 'deals', 'usual_deals', 'deals_w', 'usual_deals_w'],
    defaults: [
      '{group} в {branch} — {fact} против обычных {usual}, {deals_w} вместо {usual_deals}. Хороший день.',
      '{group} в {branch}: {fact} при привычных {usual} — заметно выше.',
    ],
  },
  {
    key: 'goods_down', title: 'Товары — ниже обычного', hint: 'Строка ⬇ по товарной группе (есть продажи, но мало).',
    placeholders: ['group', 'branch', 'fact', 'usual', 'deals', 'usual_deals', 'deals_w', 'usual_deals_w'],
    defaults: [
      '{group} в {branch} — {fact} против обычных {usual}, {deals_w} вместо {usual_deals}.',
      '{group} в {branch}: просели до {fact} при привычных {usual}.',
    ],
  },
  {
    key: 'goods_zero', title: 'Товары — ноль', hint: 'Строка ⬇ по товарной группе без продаж, хотя обычно они есть.',
    placeholders: ['group', 'branch', 'usual', 'usual_deals', 'usual_deals_w'],
    defaults: [
      '{group} в {branch} — ноль, обычно {usual_deals_w} к этому часу.',
      '{group} в {branch}: пока ни одной продажи, в обычный день уже {usual}.',
    ],
  },
  {
    key: 'heroes', title: 'Молодцы', hint: 'Строка героев дня; {list} — «Кравченко (Москва ОС) — 1,8 млн, …».',
    placeholders: ['list'],
    defaults: [
      '[B]Молодцы:[/B] {list}.',
      '[B]Герои дня:[/B] {list}.',
      '[B]Кто отличился:[/B] {list}.',
    ],
  },
  {
    key: 'zeros', title: 'Без продаж при плане', hint: 'Менеджеры с планом и обычными продажами к этому часу, но сегодня без сделок.',
    placeholders: ['list', 'count'],
    defaults: [
      '[B]Без продаж при плане:[/B] {list}.',
      '[B]Пока без сделок:[/B] {list} — обычно к этому часу они уже продают.',
    ],
  },
  {
    key: 'footer_next', title: 'Подпись — следующая сводка', hint: 'Последняя строка дневных выпусков.',
    placeholders: ['next_time'],
    defaults: [
      'Следующая сводка в {next_time}.',
      'Продолжим в {next_time}.',
    ],
  },
  {
    key: 'footer_evening', title: 'Подпись — вечерний выпуск', hint: 'Последняя строка выпуска с итогом месяца.',
    placeholders: ['next_time'],
    defaults: [
      'На сегодня всё. Следующая сводка завтра в {next_time}.',
      'Итоги подведены — увидимся завтра в {next_time}.',
    ],
  },
  {
    key: 'pace_ahead', title: 'Темп месяца — опережаем', hint: 'Доля плана к сегодняшнему дню выше типичной. {kind} — «продажам»/«отгрузкам».',
    placeholders: ['kind', 'mtd', 'plan', 'share', 'typical', 'forecast', 'need', 'day', 'days'],
    defaults: [
      'По {kind} идём с опережением: {mtd} из {plan} — {share} % плана к {day}-му рабочему дню из {days}, обычно к этому дню набираем {typical} %. Если темп сохранится — месяц закроем на {forecast}.',
      '{kind_cap}: {share} % плана против типичных {typical} % к этому дню — впереди графика. Прогноз месяца {forecast} при плане {plan}.',
    ],
  },
  {
    key: 'pace_behind', title: 'Темп месяца — отстаём', hint: 'Доля плана к сегодняшнему дню ниже типичной.',
    placeholders: ['kind', 'mtd', 'plan', 'share', 'typical', 'forecast', 'need', 'day', 'days'],
    defaults: [
      'По {kind} не успеваем: {mtd} из {plan} — {share} % плана к {day}-му рабочему дню из {days}, обычно к этому дню уже {typical} %. Чтобы выйти на план, нужно по {need} в день до конца месяца.',
      '{kind_cap}: {share} % плана при типичных {typical} % к этому дню — отставание. Прогноз месяца при текущем темпе {forecast}, до плана нужно {need} в день.',
    ],
  },
  {
    key: 'pace_ontrack', title: 'Темп месяца — по графику', hint: 'Доля плана к сегодняшнему дню близка к типичной (±3 п.п.).',
    placeholders: ['kind', 'mtd', 'plan', 'share', 'typical', 'forecast', 'need', 'day', 'days'],
    defaults: [
      'По {kind} идём по графику: {mtd} из {plan} — {share} % плана к {day}-му рабочему дню, типично к этому дню {typical} %. Прогноз месяца {forecast}.',
      '{kind_cap}: {share} % плана — ровно типичный темп ({typical} %). Так месяц закроем примерно на {forecast}.',
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

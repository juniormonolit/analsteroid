// Раз в 10 минут пересчитывает % выполнения годового плана по отгрузкам и кладёт в Redis
// (plan:summary) для страницы «Сводная» и iPhone-виджета. Отдельной cron-инфраструктуры на
// проекте нет (деплой — SSH+tar+nohup на голый VPS), поэтому таймер живёт прямо в процессе
// next start — единственном на инстанс, так что дублирования интервалов не будет.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { computeAndCachePlanSummary } = await import('./lib/jobs/planSummary');

  const run = () => computeAndCachePlanSummary().catch(err => console.error('[planSummary] job failed:', err));

  run();
  setInterval(run, 10 * 60 * 1000);

  scheduleDailyMoscowReport();
  scheduleCallControl();
  scheduleWidgetMetrics();
}

// Конструктор виджетов: матрица (6 метрик × отделы/филиалы/Россия × 5 периодов) в Redis
// (widget:metrics), раз в 10 мин. Redis-замок на тик — как у scheduleCallControl, чтобы
// соседние инстансы на общей БД не гоняли расчёт дважды. Конфиги виджетов расчёт не
// триггерят (только выбирают срез) — нагрузка постоянна независимо от числа виджетов.
function scheduleWidgetMetrics() {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      try {
        const { getRedis } = await import('./lib/cache/redis');
        const redis = getRedis();
        if (redis) {
          const acquired = await redis.set('widget:metrics:tick', '1', 'EX', 570, 'NX');
          if (acquired !== 'OK') return;
        }
      } catch { /* без Redis — полагаемся на in-process флаг */ }

      const { computeAndCacheWidgetMetrics } = await import('./lib/jobs/widgetMetrics');
      await computeAndCacheWidgetMetrics();
    } catch (err) {
      console.error('[widgetMetrics] цикл упал:', err);
    } finally {
      running = false;
    }
  };

  void tick();
  setInterval(() => { void tick(); }, 10 * 60 * 1000);
}

// Бот «Контроль звонков»: тик раз в минуту, движок в lib/bots/callControl.ts.
// Гейт — НЕ env, а call_control_settings.enabled в БД (правится в /settings/bots):
// на dev-стенде своя системная БД (junibaseone) со своим выключателем, дублей не будет.
// Redis-замок на тик — на случай перекрытия соседних инстансов одной БД.
function scheduleCallControl() {
  let running = false; // защита от наложения тиков внутри процесса

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      try {
        const { getRedis } = await import('./lib/cache/redis');
        const redis = getRedis();
        if (redis) {
          const acquired = await redis.set('call-control:tick', '1', 'EX', 55, 'NX');
          if (acquired !== 'OK') return;
        }
      } catch { /* без Redis — полагаемся на in-process флаг */ }

      const { runCallControlCycle } = await import('./lib/bots/callControl');
      const summary = await runCallControlCycle();
      if (summary !== 'disabled') console.log(`[callControl] ${summary}`);
    } catch (err) {
      console.error('[callControl] цикл упал:', err);
    } finally {
      running = false;
    }
  };

  setInterval(() => { void tick(); }, 60 * 1000);
}

// Ежедневный отчёт «МОСКВА» в личку владельца через бота «Аналитик» в 18:00 МСК.
// Включается только если задан DAILY_REPORT_BITRIX_USER_ID (на dev-машине не задаём,
// чтобы запущенный dev-сервер не слал дубли). Защита от повторной отправки после
// рестарта процесса — Redis SET NX; без Redis — in-memory флаг на дату.
function scheduleDailyMoscowReport() {
  const recipient = process.env.DAILY_REPORT_BITRIX_USER_ID;
  if (!recipient) return;

  // Окно отправки 18:00–19:59 МСК: тик раз в минуту, при неудаче — ПОВТОР на
  // следующем тике (правка 30.07 после реального пропуска: Битрикс оборвал
  // 10-мегабайтный ответ mlt.sales.list, отправка упала, а замок уже стоял —
  // отчёт молча потерялся за день). Замок в Redis теперь ставится ТОЛЬКО ПОСЛЕ
  // успешной отправки, до этого от гонки соседних инстансов защищает короткий
  // «замок попытки» (2 мин) — он же не даёт двум процессам слать одновременно.
  const SEND_HOUR_FROM = 18;
  const SEND_HOUR_TO = 19; // включительно — запас на ретраи
  let lastSentDate = '';   // in-memory fallback, если Redis недоступен
  let running = false;

  const tick = async () => {
    if (running) return;
    const msk = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }); // 'YYYY-MM-DD HH:mm:ss'
    const [date, time] = msk.split(' ');
    const hour = parseInt(time.slice(0, 2), 10);
    if (hour < SEND_HOUR_FROM || hour > SEND_HOUR_TO || lastSentDate === date) return;

    running = true;
    let redis: Awaited<ReturnType<typeof import('./lib/cache/redis')['getRedis']>> = null;
    try {
      const { getRedis } = await import('./lib/cache/redis');
      redis = getRedis();
      if (redis) {
        // Уже отправлен другим инстансом сегодня?
        if (await redis.get(`daily-report:sent:${date}`)) { lastSentDate = date; return; }
        // Замок ПОПЫТКИ: кто-то прямо сейчас собирает отчёт — не дублируем.
        const attempt = await redis.set(`daily-report:attempt:${date}`, '1', 'EX', 120, 'NX');
        if (attempt !== 'OK') return;
      }
    } catch (err) {
      console.warn('[dailyReport] Redis недоступен, полагаюсь на in-memory флаг:', err);
    }

    try {
      const { sendDailyMoscowReport } = await import('./lib/jobs/dailyMoscowReport');
      await sendDailyMoscowReport();
      lastSentDate = date;
      if (redis) await redis.set(`daily-report:sent:${date}`, '1', 'EX', 24 * 3600).catch(() => {});
      console.log(`[dailyReport] отчёт за ${date} отправлен пользователю ${recipient}`);
    } catch (err) {
      // НЕ ставим флаг «отправлено» — следующий тик (через минуту) попробует снова,
      // пока не кончится окно 18:00–19:59.
      console.error('[dailyReport] отправка не удалась, повтор через минуту:', err);
      if (redis) await redis.del(`daily-report:attempt:${date}`).catch(() => {});
    } finally {
      running = false;
    }
  };

  setInterval(() => { void tick(); }, 60 * 1000);
}

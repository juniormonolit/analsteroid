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

  const SEND_HOUR = 18; // МСК
  let lastSentDate = ''; // in-memory fallback, если Redis недоступен

  const tick = async () => {
    const msk = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }); // 'YYYY-MM-DD HH:mm:ss'
    const [date, time] = msk.split(' ');
    const hour = parseInt(time.slice(0, 2), 10);
    // Окно 18:00–18:59: тик раз в минуту, но защита по дате не даст отправить дважды.
    if (hour !== SEND_HOUR || lastSentDate === date) return;

    try {
      const { getRedis } = await import('./lib/cache/redis');
      const redis = getRedis();
      if (redis) {
        const acquired = await redis.set(`daily-report:sent:${date}`, '1', 'EX', 24 * 3600, 'NX');
        if (acquired !== 'OK') { lastSentDate = date; return; }
      }
    } catch (err) {
      console.warn('[dailyReport] Redis-замок недоступен, полагаюсь на in-memory флаг:', err);
    }
    lastSentDate = date;

    try {
      const { sendDailyMoscowReport } = await import('./lib/jobs/dailyMoscowReport');
      await sendDailyMoscowReport();
      console.log(`[dailyReport] отчёт за ${date} отправлен пользователю ${recipient}`);
    } catch (err) {
      console.error('[dailyReport] отправка не удалась:', err);
    }
  };

  setInterval(() => { void tick(); }, 60 * 1000);
}

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

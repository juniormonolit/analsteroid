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
  scheduleEmployeeRenameCheck();
  scheduleBadgeRecompute();
  scheduleManagerDigest();
  scheduleAdviceFeedback();
  scheduleRopDigest();
  scheduleRopAdviceFeedback();
}

// ── Дайджест «Аналитика» менеджерам + цикл обратной связи (задача 2765) ──────
// Ежедневный (будни, короткий) и еженедельный (по понедельникам, итоги) пуш
// каждому активному менеджеру: движок lib/jobs/managerDigest.ts. Гейт —
// digest_settings (правится в «Настройки → Геймификация → Дайджест»), не env —
// как у call_control_settings, чтобы дев-стенд не слал дублей на общую БД
// (там свой YC system, junibaseone).

// Общий хелпер «раз в сутки по МСК с Redis-замком» — та же идея, что у
// scheduleDailyMoscowReport, но вынесена: дневное и недельное окно дайджеста
// почти идентичны, дублировать блок целиком незачем.
async function runOnceADayMsk(lockKey: string, dateStr: string, job: () => Promise<void>): Promise<'ran' | 'already' | 'busy'> {
  let redis: Awaited<ReturnType<typeof import('./lib/cache/redis')['getRedis']>> = null;
  try {
    const { getRedis } = await import('./lib/cache/redis');
    redis = getRedis();
    if (redis) {
      if (await redis.get(`${lockKey}:sent:${dateStr}`)) return 'already';
      const attempt = await redis.set(`${lockKey}:attempt:${dateStr}`, '1', 'EX', 900, 'NX');
      if (attempt !== 'OK') return 'busy';
    }
  } catch (err) {
    console.warn(`[${lockKey}] Redis недоступен, полагаюсь на in-memory флаг:`, err);
  }
  await job();
  if (redis) await redis.set(`${lockKey}:sent:${dateStr}`, '1', 'EX', 24 * 3600).catch(() => {});
  return 'ran';
}

function scheduleManagerDigest() {
  let lastDailyDate = '';   // in-memory fallback, если Redis недоступен
  let lastWeeklyDate = '';
  let dailyRunning = false;
  let weeklyRunning = false;

  const tick = async () => {
    try {
      const { fetchDigestSettings, mskIsoWeekday, runDailyDigestForAllManagers, runWeeklyDigestForAllManagers } = await import('./lib/jobs/managerDigest');
      const now = new Date();
      const msk = now.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }); // 'YYYY-MM-DD HH:mm:ss'
      const [date, time] = msk.split(' ');
      const hour = parseInt(time.slice(0, 2), 10);
      const weekday = mskIsoWeekday(now); // 1=Пн … 7=Вс
      const settings = await fetchDigestSettings();

      // Ежедневный: только будни (Пн-Пт) — «в выходные ежедневный не слать» из брифа.
      if (settings.dailyEnabled && weekday <= 5 && hour === settings.dailyHour && !dailyRunning && lastDailyDate !== date) {
        dailyRunning = true;
        try {
          const outcome = await runOnceADayMsk('digest:daily', date, async () => {
            const res = await runDailyDigestForAllManagers();
            console.log(`[digest] дневной: отправлено ${res.sent}, ошибок ${res.failed}`);
          });
          if (outcome !== 'busy') lastDailyDate = date;
        } finally { dailyRunning = false; }
      }

      // Еженедельный: только понедельник, итоги закончившейся недели.
      if (settings.weeklyEnabled && weekday === 1 && hour === settings.weeklyHour && !weeklyRunning && lastWeeklyDate !== date) {
        weeklyRunning = true;
        try {
          const outcome = await runOnceADayMsk('digest:weekly', date, async () => {
            const res = await runWeeklyDigestForAllManagers();
            console.log(`[digest] недельный: отправлено ${res.sent}, ошибок ${res.failed}`);
          });
          if (outcome !== 'busy') lastWeeklyDate = date;
        } finally { weeklyRunning = false; }
      }
    } catch (err) {
      console.error('[digest] тик упал:', err);
    }
  };

  setInterval(() => { void tick(); }, 60 * 1000);
}

// Цикл обратной связи по журналу подсказок (lib/jobs/adviceFeedback.ts) — тик
// чаще дайджеста (раз в 15 мин), строк обычно немного (открытых советов на
// менеджера — единицы), Redis-замок на случай нескольких инстансов на общей БД.
function scheduleAdviceFeedback() {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      try {
        const { getRedis } = await import('./lib/cache/redis');
        const redis = getRedis();
        if (redis) {
          const acquired = await redis.set('advice-feedback:tick', '1', 'EX', 14 * 60, 'NX');
          if (acquired !== 'OK') return;
        }
      } catch { /* без Redis — полагаемся на in-process флаг running */ }

      const { runAdviceFeedbackTick } = await import('./lib/jobs/adviceFeedback');
      const stats = await runAdviceFeedbackTick();
      if (stats.checked > 0) {
        console.log(`[adviceFeedback] проверено ${stats.checked}: успех ${stats.success}, контакт ${stats.contacted}, напоминаний ${stats.reminded}, закрыто без контакта ${stats.closedNoContact}, закрыто без сделки ${stats.closedNoDeal}, ошибок ${stats.errors}`);
      }
    } catch (err) {
      console.error('[adviceFeedback] тик упал:', err);
    } finally {
      running = false;
    }
  };

  setTimeout(() => { void tick(); }, 45 * 1000); // сдвиг от старта — не толпиться с остальными job на боевом старте
  setInterval(() => { void tick(); }, 15 * 60 * 1000);
}

// ── Дайджест «Аналитика» РОПу — агрегированный по отделу (задача 2769,
// продолжение 2765) + свой цикл обратной связи (lib/jobs/ropAdviceFeedback.ts).
// ПЕРЕИСПОЛЬЗУЕТ те же часы/гейт, что менеджерский дайджест (digest_settings —
// отдельных настроек времени для РОПа не заводили, не просили), поэтому окна
// отправки daily/weekly у менеджеров и РОПов совпадают по времени — они не
// зависят друг от друга (свои Redis-замки `rop-digest:*`, своя таблица
// rop_bot_prefs/rop_advice_log), но не толпятся, т.к. это разные списки
// получателей (менеджер vs РОП одного отдела получают РАЗНЫЕ сообщения).
function scheduleRopDigest() {
  let lastDailyDate = '';
  let lastWeeklyDate = '';
  let dailyRunning = false;
  let weeklyRunning = false;

  const tick = async () => {
    try {
      const { fetchDigestSettings, mskIsoWeekday, runDailyDigestForAllRops, runWeeklyDigestForAllRops } = await import('./lib/jobs/ropDigest');
      const now = new Date();
      const msk = now.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' });
      const [date, time] = msk.split(' ');
      const hour = parseInt(time.slice(0, 2), 10);
      const weekday = mskIsoWeekday(now);
      const settings = await fetchDigestSettings();

      if (settings.dailyEnabled && weekday <= 5 && hour === settings.dailyHour && !dailyRunning && lastDailyDate !== date) {
        dailyRunning = true;
        try {
          const outcome = await runOnceADayMsk('rop-digest:daily', date, async () => {
            const res = await runDailyDigestForAllRops();
            console.log(`[ropDigest] дневной: отправлено ${res.sent}, ошибок ${res.failed}`);
          });
          if (outcome !== 'busy') lastDailyDate = date;
        } finally { dailyRunning = false; }
      }

      if (settings.weeklyEnabled && weekday === 1 && hour === settings.weeklyHour && !weeklyRunning && lastWeeklyDate !== date) {
        weeklyRunning = true;
        try {
          const outcome = await runOnceADayMsk('rop-digest:weekly', date, async () => {
            const res = await runWeeklyDigestForAllRops();
            console.log(`[ropDigest] недельный: отправлено ${res.sent}, ошибок ${res.failed}`);
          });
          if (outcome !== 'busy') lastWeeklyDate = date;
        } finally { weeklyRunning = false; }
      }
    } catch (err) {
      console.error('[ropDigest] тик упал:', err);
    }
  };

  setInterval(() => { void tick(); }, 60 * 1000);
}

// Цикл обратной связи по rop_advice_log (lib/jobs/ropAdviceFeedback.ts) — тот
// же ритм 15 мин, что и менеджерский, свой Redis-замок.
function scheduleRopAdviceFeedback() {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      try {
        const { getRedis } = await import('./lib/cache/redis');
        const redis = getRedis();
        if (redis) {
          const acquired = await redis.set('rop-advice-feedback:tick', '1', 'EX', 14 * 60, 'NX');
          if (acquired !== 'OK') return;
        }
      } catch { /* без Redis — полагаемся на in-process флаг running */ }

      const { runRopAdviceFeedbackTick } = await import('./lib/jobs/ropAdviceFeedback');
      const stats = await runRopAdviceFeedbackTick();
      if (stats.checked > 0) {
        console.log(`[ropAdviceFeedback] проверено ${stats.checked}: успех ${stats.success}, контакт ${stats.contacted}, напоминаний ${stats.reminded}, закрыто без контакта ${stats.closedNoContact}, закрыто без результата ${stats.closedNoDeal}, ошибок ${stats.errors}`);
      }
    } catch (err) {
      console.error('[ropAdviceFeedback] тик упал:', err);
    } finally {
      running = false;
    }
  };

  setTimeout(() => { void tick(); }, 60 * 1000); // сдвиг от старта, отличный от менеджерского (45с) — не толпиться
  setInterval(() => { void tick(); }, 15 * 60 * 1000);
}

// Бейджи менеджеров (задача 2655): ночной полный идемпотентный пересчёт наград
// (03:30+ МСК, Redis-замок на дату) + ретро-прогон при первом старте, если
// badge_awards ещё пуста. Планировщика в проекте нет — таймер в процессе
// next start, как у остальных джоб выше.
function scheduleBadgeRecompute() {
  let lastRunDateMsk: string | null = null;
  let bootChecked = false;

  const run = async (reason: string) => {
    const { runBadgeRecompute } = await import('./features/badges/engine/compute');
    const res = await runBadgeRecompute();
    console.log(`[badges] пересчёт (${reason}): +${res.inserted} новых, ${res.updated} обновлено, всего наград в проходе ${res.total}, ${res.ms}ms`);
  };

  const tick = async () => {
    try {
      const now = new Date();
      const msk = now.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' });
      const [date, time] = msk.split(' ');
      const hour = Number(time.slice(0, 2));

      if (!bootChecked) {
        bootChecked = true;
        try {
          const { systemDb } = await import('./lib/db/clients');
          const r = await systemDb().query<{ n: string }>('SELECT count(*) AS n FROM badge_awards');
          if (Number(r.rows[0]?.n ?? '0') === 0) {
            await run('первый запуск, ретро');
            lastRunDateMsk = date;
            return;
          }
        } catch (e) {
          console.warn('[badges] boot-проверка не удалась (миграция 112 ещё не применена?):', e instanceof Error ? e.message : e);
          return;
        }
      }

      if (hour < 3 || lastRunDateMsk === date) return;
      try {
        const { getRedis } = await import('./lib/cache/redis');
        const redis = getRedis();
        if (redis) {
          const acquired = await redis.set(`badges:recompute:${date}`, '1', 'EX', 20 * 60 * 60, 'NX');
          if (acquired !== 'OK') { lastRunDateMsk = date; return; }
        }
      } catch { /* без Redis — in-memory дата */ }
      await run('ночной');
      lastRunDateMsk = date;
    } catch (err) {
      console.error('[badges] пересчёт упал:', err);
    }
  };

  setTimeout(() => { void tick(); }, 30 * 1000); // ретро-чек через 30с после старта
  setInterval(() => { void tick(); }, 15 * 60 * 1000);
}

// Реестр сотрудников (задача 2654): суточный серверный детект переименований
// битрикс-логинов (sa.employees.full_name vs sa.employee_name_history, SCD2).
// Детект также срабатывает при обращении к странице «Сотрудники» (кэш ~6 ч в
// features/employees/engine/registry.ts — общий и для тика, и для страницы).
// Redis-замок — чтобы соседние инстансы на общей БД не гоняли детект дважды.
function scheduleEmployeeRenameCheck() {
  let lastRunDateMsk: string | null = null;

  const tick = async () => {
    try {
      const now = new Date();
      const msk = now.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' });
      const [date, time] = msk.split(' ');
      const hour = Number(time.slice(0, 2));
      if (hour < 5 || lastRunDateMsk === date) return; // окно: с 05:00 МСК, раз в день
      try {
        const { getRedis } = await import('./lib/cache/redis');
        const redis = getRedis();
        if (redis) {
          const acquired = await redis.set(`employees:rename-check:${date}`, '1', 'EX', 20 * 60 * 60, 'NX');
          if (acquired !== 'OK') { lastRunDateMsk = date; return; }
        }
      } catch { /* без Redis — только in-memory дата */ }
      const { detectRenames } = await import('./features/employees/engine/registry');
      const res = await detectRenames(true);
      lastRunDateMsk = date;
      console.log(`[employees] суточный детект переименований: seeded=${res.seeded} renamed=${res.renamed} skippedFlips=${res.skippedFlips}`);
    } catch (err) {
      console.error('[employees] суточный детект упал:', err);
    }
  };

  setInterval(() => { void tick(); }, 15 * 60 * 1000);
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

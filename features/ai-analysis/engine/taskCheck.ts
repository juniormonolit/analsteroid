// Проверка звонка по закрытой задаче канбана повторных (план повторки, решение владельца 23.10): что менеджеру
// поручили (описание задачи — «Перед звонком / Предложить / Выяснить / От РОПа») и что он сделал в звонках ПОСЛЕ
// постановки. Только вручную (кнопка у РОПа) — владелец контролирует бюджет. Очередь та же (ai_analyses, kind
// 'task_check'), обезличивание то же, цитаты проверяет verify.ts. Формулировки — обезличенные.
import { analyticsDb } from '@/lib/db/clients';
import { CLIENT_KEY_SQL } from '@/features/customers/engine/clientKey';
import type { ClientRef } from '@/features/client-module/engine/types';
import type { CollectedCall } from './collect';
import { maskCompany, maskPii } from './mask';
import { verifyQuotes, type QuoteCheck } from './verify';

export const TASK_CHECK_VERSION = 'tc1';
/** Чек-лист больших чеков (владелец 18.11): своя версия промпта для задач проектов больших сделок. */
export const BIG_DEAL_CHECK_VERSION = 'bdc1';
/** Проекты больших сделок Битрикса (features/big-deals-kanban/engine/config.ts — BIG_DEALS_GROUP_IDS). */
const BIG_DEAL_GROUPS = new Set([72, 74, 79, 80, 81, 108]);
/** Большие чеки: звонки по сделке берём и ДО постановки задачи (до 14 дней) — ИНН, сроки, цену часто спрашивают
 *  в первом разговоре, ещё до того, как сделка «стала большой». */
const BIG_DEAL_PRE_DAYS = 14;
/** Короче — недозвон/«перезвоню», проверять нечего (как правило «сделанной задачи» в канбане — 20 с). */
const MIN_TALK_SEC = 20;

export interface TaskInfo {
  taskId: number; dealId: number | null; title: string; description: string; createdAt: string; closedAt: string | null;
  status: number | null; responsibleName: string | null; clientRef: ClientRef | null;
  groupId: number | null;
}

export const isBigDealTask = (t: Pick<TaskInfo, 'groupId'>) => t.groupId != null && BIG_DEAL_GROUPS.has(t.groupId);

/** BB-коды Битрикса → простой текст (модели теги не нужны). */
const unBb = (s: string) => s.replace(/\[\/?(?:B|I|U|S|SIZE|COLOR|URL|USER|CODE|QUOTE|LIST|\*)[^\]]*\]/gi, '').replace(/^>>/gm, '').trim();

export async function fetchTaskInfo(taskId: number): Promise<TaskInfo | null> {
  const r = await analyticsDb().query<{ task_id: string; deal_id: string | null; title: string | null; description: string | null; created_at: Date; closed_at: Date | null; status: number | null; responsible_name: string | null; client_key: string | null; group_id: number | null }>(
    `SELECT t.task_id, t.deal_id, t.group_id, t.title, t.description, t.created_at, t.closed_at, t.status, t.responsible_name,
            (SELECT (${CLIENT_KEY_SQL}) FROM sa.deals d WHERE d.deal_id = t.deal_id) AS client_key
       FROM sa.bitrix_task_current t WHERE t.task_id = $1 AND NOT t.is_deleted`,
    [taskId],
  );
  const x = r.rows[0];
  if (!x) return null;
  const k = x.client_key;
  return {
    taskId: Number(x.task_id), dealId: x.deal_id ? Number(x.deal_id) : null, title: x.title ?? '', description: unBb(x.description ?? ''),
    createdAt: new Date(x.created_at).toISOString(), closedAt: x.closed_at ? new Date(x.closed_at).toISOString() : null,
    status: x.status, responsibleName: x.responsible_name,
    clientRef: k ? (k.startsWith('k') ? k as ClientRef : `c${k.slice(1)}` as ClientRef) : null,
    groupId: x.group_id != null ? Number(x.group_id) : null,
  };
}

/** Звонки по сделке задачи после её постановки (у больших чеков — и за BIG_DEAL_PRE_DAYS до), с расшифровкой. */
export async function callsAfterTask(t: TaskInfo): Promise<CollectedCall[]> {
  if (!t.dealId) return [];
  const since = isBigDealTask(t) ? new Date(Date.parse(t.createdAt) - BIG_DEAL_PRE_DAYS * 86_400_000).toISOString() : t.createdAt;
  const r = await analyticsDb().query<{ id: string; called_at: Date; deal_id: string; direction: string | null; dur: number | null; manager: string | null; txt: string | null; roles: boolean }>(
    `SELECT c.id::text, c.called_at, c.deal_id, c.direction::text, c.duration_seconds AS dur,
            coalesce(org.manager_name, e.full_name) AS manager, coalesce(tr.formatted_dialogue, tr.raw_text) AS txt, (tr.formatted_dialogue IS NOT NULL) AS roles
       FROM va.calls c
       JOIN va.transcriptions tr ON tr.call_id = c.id
       LEFT JOIN sa.employees e ON e.bitrix_id = c.manager_id
       LEFT JOIN sa.org_resolved_hierarchy org ON org.manager_bitrix_user_id = c.manager_id::text
      WHERE c.failed_at_stage IS NULL AND c.deal_id = $1 AND c.called_at >= $2 AND coalesce(c.duration_seconds, 0) >= $3
      ORDER BY c.called_at`,
    [t.dealId, since, MIN_TALK_SEC],
  );
  return r.rows.filter(x => (x.txt ?? '').length > 10).map(x => ({
    id: x.id, calledAt: new Date(x.called_at).toISOString(), dealId: Number(x.deal_id), direction: x.direction, durationSec: x.dur,
    stage: null, manager: x.manager, text: x.txt!, hasRoles: x.roles,
  }));
}

/** Состояние для пометки на доске: есть ли разговор после постановки и проверяли ли уже. */
export async function fetchTaskCheckState(taskIds: number[]): Promise<Map<number, { hasCall: boolean; check: { id: number; status: string; verdict: string | null; at: string } | null }>> {
  const out = new Map<number, { hasCall: boolean; check: { id: number; status: string; verdict: string | null; at: string } | null }>();
  if (!taskIds.length) return out;
  const { systemDb } = await import('@/lib/db/clients');
  const [calls, checks] = await Promise.all([
    analyticsDb().query<{ task_id: string; n: number }>(
      `SELECT t.task_id, count(c.id)::int AS n
         FROM sa.bitrix_task_current t
         JOIN va.calls c ON c.failed_at_stage IS NULL AND c.deal_id = t.deal_id AND c.result = 'completed' AND coalesce(c.duration_seconds, 0) >= $2
              AND c.called_at >= t.created_at - CASE WHEN t.group_id = ANY($3::int[]) THEN make_interval(days => $4) ELSE interval '0' END
        WHERE t.task_id = ANY($1::bigint[]) GROUP BY 1`,
      [taskIds, MIN_TALK_SEC, [...BIG_DEAL_GROUPS], BIG_DEAL_PRE_DAYS],
    ),
    systemDb().query<{ check_task_id: string; id: string; status: string; verdict: string | null; created_at: Date }>(
      `SELECT DISTINCT ON (check_task_id) check_task_id, id, status, parsed->'taskCheck'->>'verdict' AS verdict, created_at
         FROM ai_analyses WHERE kind = 'task_check' AND check_task_id = ANY($1::bigint[])
        ORDER BY check_task_id, created_at DESC`,
      [taskIds],
    ).catch(() => ({ rows: [] as { check_task_id: string; id: string; status: string; verdict: string | null; created_at: Date }[] })),
  ]);
  for (const id of taskIds) out.set(id, { hasCall: false, check: null });
  for (const r of calls.rows) out.get(Number(r.task_id))!.hasCall = r.n > 0;
  for (const r of checks.rows) out.get(Number(r.check_task_id))!.check = { id: Number(r.id), status: r.status, verdict: r.verdict, at: new Date(r.created_at).toISOString() };
  return out;
}

export function taskCheckSystem(): string {
  return `# Задача: проверить, выполнил ли менеджер поручение по звонку заказчику

Компания продаёт стройматериалы, отдел повторных продаж. Менеджеру поставили задачу (текст ниже: «Перед звонком», «Предложить», «Выяснить», «От РОПа» и т.п.). Ниже — расшифровки звонков по этой сделке ПОСЛЕ постановки задачи. Расшифровки автоматические: ошибки распознавания, перепутанные роли (менеджер говорит от имени компании). Данные обезличены: [ТЕЛЕФОН], #, [компания].

Правила: только факты из звонков; цитаты — ДОСЛОВНО, в «…», до 12 слов, с датой ДД.ММ; обезличенно («не было предложено», «вопрос не задан»), без «ты»; по-русски; заголовки ровно как ниже.

### 1. Итог
Одна строка: «Выполнено» / «Частично» / «Не выполнено» / «Не дозвонились по сути» — и почему, коротко.

### 2. По пунктам задачи
Каждый пункт из «Зайти с», «Предложить», «Выяснить» и поручений РОПа — отдельной строкой: «— <пункт>: ДА / ЧАСТИЧНО / НЕТ — цитата (дата)».

### 3. Что сказал заказчик
Итог разговора: что нужно, когда, договорённости, возражения (с цитатами). 2–5 строк.

### 4. Данные
Только JSON в блоке \`\`\`json … \`\`\`:
{"verdict":"done|partial|not_done|no_talk","items":[{"item":"<пункт задачи кратко>","done":"yes|partial|no","quote":"<цитата>","date":"<ДД.ММ.ГГГГ>"}]}`;
}

/** Чек-лист больших чеков (владелец 18.11: «первичная оценка — была ли попытка брони или счёта, спросил ли ИНН,
 *  когда нужен материал, была ли обратная связь по цене, спросил ли, есть ли дешевле, и всё в таком духе»).
 *  Формат ответа — тот же, что у проверки повторки (разделы 1–4 + JSON items): панель TaskCheck и parseTaskCheck общие. */
export const BIG_DEAL_CHECKLIST = [
  'Попытка закрыть в бронь или выставить счёт',
  'Спросил ИНН / реквизиты для счёта (у юрлица) или данные покупателя',
  'Выяснил, когда нужен материал / когда планируется закупка',
  'Выяснил, под какие цели и на какой объект материал',
  'Получил обратную связь по цене (как клиенту наша цена)',
  'Спросил, есть ли цена дешевле / КП конкурента',
  'Уточнил объём и состав заказа (все позиции, количество)',
  'Обсудил доставку: адрес, транспорт, разгрузку, сроки',
  'Отработал возражение (цена, сроки, бренд) или предложил аналог',
  'Выяснил, кто принимает решение и как идёт согласование',
  'Договорился о следующем шаге с датой (созвон, оплата, бронь)',
] as const;

export function bigDealCheckSystem(): string {
  return `# Задача: первичная оценка работы менеджера по БОЛЬШОЙ сделке

Компания продаёт стройматериалы. Сделка крупная (от 150 тыс. ₽) — по ней в Битриксе автоматически создана задача, РОП контролирует, чтобы менеджер довёл её до брони и оплаты. Ниже: текст задачи (клиент, товары, сумма, цели, «есть ли цена дешевле», дата поставки, вопросы РОПа) и расшифровки звонков по сделке — за 14 дней до постановки задачи и после неё (у каждого звонка помечено). Расшифровки автоматические: ошибки распознавания, перепутанные роли (менеджер говорит от имени компании). Данные обезличены: [ТЕЛЕФОН], #, [компания].

Оцени разговоры по чек-листу больших сделок. Правила: только факты из звонков, без домыслов; цитаты — ДОСЛОВНО, в «…», до 12 слов, с датой ДД.ММ; обезличенно («вопрос не задан», «бронь не предложена»), без «ты»; по-русски; заголовки ровно как ниже. Если по пункту в звонках ничего нет — «НЕТ» и коротко, чего не хватило. Если пункт неприменим (например, ИНН у физлица — тогда «данные покупателя») — оценивай по смыслу.

### 1. Итог
Одна строка: «Отработано» / «Частично» / «Не отработано» / «Не дозвонились по сути» — и главное, чего не хватает, чтобы сделка дошла до брони/счёта.

### 2. По пунктам задачи
Ровно эти пункты, каждый отдельной строкой: «— <пункт>: ДА / ЧАСТИЧНО / НЕТ — цитата (дата)».
${BIG_DEAL_CHECKLIST.map((x, i) => `${i + 1}. ${x}`).join('\n')}
Плюс отдельными строками — вопросы и поручения РОПа из текста задачи, если они там есть.

### 3. Что сказал заказчик
Где сделка сейчас: что нужно, когда, сколько, что смущает (цена, сроки, конкурент — с цифрами, если звучали), договорённости. 2–5 строк. Последней строкой — «Совет РОПу:» одно конкретное действие, которое сдвинет сделку к брони.

### 4. Данные
Только JSON в блоке \`\`\`json … \`\`\`:
{"verdict":"done|partial|not_done|no_talk","items":[{"item":"<пункт чек-листа кратко>","done":"yes|partial|no","quote":"<цитата или пусто>","date":"<ДД.ММ.ГГГГ или пусто>"}]}
verdict: done — бронь/счёт предложены и ключевые пункты (сроки, цена, конкурент, ИНН/данные, следующий шаг) закрыты; partial — часть закрыта; not_done — по сути не отработано; no_talk — содержательного разговора не было.`;
}

export function taskCheckUser(t: TaskInfo, calls: CollectedCall[]): { text: string; maskHits: Record<string, number> } {
  const fmt = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
  const lines = [`# Задача #${t.taskId}: ${t.title}`, `Поставлена: ${fmt(t.createdAt)}${t.closedAt ? `, закрыта: ${fmt(t.closedAt)}` : ''}; исполнитель: ${t.responsibleName ?? '—'}`, '', '## Текст задачи', t.description || '(пусто)', '', '## Звонки после постановки'];
  const pre = (c: CollectedCall) => (isBigDealTask(t) && c.calledAt < t.createdAt ? ' | ДО постановки задачи' : '');
  for (const c of calls) lines.push('', `### ${fmt(c.calledAt)} | ${c.direction === 'inbound' ? 'входящий' : 'исходящий'} | ${c.durationSec ?? '?'} с | ${c.manager ?? '—'}${c.hasRoles ? '' : ' | без ролей'}${pre(c)}`, c.text);
  const m = maskPii(lines.join('\n'));
  return { text: maskCompany(m.text, m.hits), maskHits: m.hits };
}

export interface TaskCheckResult { verdict: 'done' | 'partial' | 'not_done' | 'no_talk' | null; items: { item: string; done: 'yes' | 'partial' | 'no'; quote: string | null; date: string | null; quoteFound: boolean }[] }

export function parseTaskCheck(md: string, calls: CollectedCall[]): { result: TaskCheckResult; quotes: QuoteCheck[] } {
  const sec = md.split(/^#{2,4}\s*4\.\s*[^\n]*$/m)[1] ?? md;
  const block = sec.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? sec.match(/\{[\s\S]*\}/)?.[0];
  let raw: { verdict?: string; items?: { item?: string; done?: string; quote?: string; date?: string }[] } = {};
  try { raw = block ? JSON.parse(block) : {}; } catch { /* JSON не разобрался — итог из раздела 1 не берём */ }
  const quotes = verifyQuotes(md, calls);
  const verdicts = ['done', 'partial', 'not_done', 'no_talk'] as const;
  const result: TaskCheckResult = {
    verdict: verdicts.includes(raw.verdict as typeof verdicts[number]) ? raw.verdict as TaskCheckResult['verdict'] : null,
    items: (Array.isArray(raw.items) ? raw.items : []).filter(i => i && typeof i.item === 'string').slice(0, 30).map(i => {
      const q = typeof i.quote === 'string' && i.quote.trim() ? i.quote.trim() : null;
      return {
        item: i.item!.slice(0, 200), done: (['yes', 'partial', 'no'] as const).includes(i.done as 'yes') ? i.done as 'yes' | 'partial' | 'no' : 'no',
        quote: q, date: typeof i.date === 'string' ? i.date : null,
        quoteFound: !!q && !!verifyQuotes(`«${q}»`, calls)[0]?.found,
      };
    }),
  };
  return { result, quotes };
}

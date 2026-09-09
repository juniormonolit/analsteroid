import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { closeOpenRuns, loadScenarios, type Scenario } from '@/lib/jobs/scenarios';

// Сценарии авто-коучинга (задача владельца 09.09.2026) — CRUD. Только супер-админ,
// как весь реестр бота. Новый сценарий создаётся ВЫКЛЮЧЕННЫМ.

const ID_RE = /^[0-9a-f-]{36}$/;

interface Parsed {
  name: string; metricId: string; windowDays: number; baseline: 'target' | 'own_avg'; targetValue: number | null;
  baselineDays: number; dropThreshold: number; adviceText: string; followupDays: number;
  followupImprovedText: string; followupSameText: string; maxSteps: number; cooldownDays: number;
  praiseEnabled: boolean; praiseText: string | null; praiseCooldownDays: number; checkHour: number; weekdaysOnly: boolean;
}

function int(v: unknown, min: number, max: number, label: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: целое от ${min} до ${max}`);
  return n;
}
function num(v: unknown, label: string): number {
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error(`${label}: число`);
  return n;
}
function text(v: unknown, label: string, required = true): string {
  const s = String(v ?? '').trim();
  if (required && !s) throw new Error(`${label}: заполните текст`);
  if (s.length > 4000) throw new Error(`${label}: не длиннее 4000 символов`);
  return s;
}

async function parseBody(body: Record<string, unknown>): Promise<Parsed> {
  const name = text(body.name, 'Название');
  if (name.length > 120) throw new Error('Название: не длиннее 120 символов');
  const metricId = String(body.metricId ?? '').trim();
  const metrics = await loadMetrics();
  const metric = metrics.find(m => m.id === metricId);
  if (!metric) throw new Error('Выберите показатель из каталога');
  const baseline = body.baseline === 'own_avg' ? 'own_avg' : 'target';
  const targetValue = baseline === 'target' ? num(body.targetValue, 'Целевое значение') : null;
  const praiseEnabled = Boolean(body.praiseEnabled ?? true);
  return {
    name, metricId, baseline, targetValue,
    windowDays: int(body.windowDays ?? 30, 1, 365, 'Окно, дней'),
    baselineDays: int(body.baselineDays ?? 90, 7, 730, 'База, дней'),
    dropThreshold: Math.abs(num(body.dropThreshold ?? 0, 'Допустимая просадка')),
    adviceText: text(body.adviceText, 'Текст совета'),
    followupDays: int(body.followupDays ?? 7, 1, 90, 'Проверка через, дней'),
    followupImprovedText: text(body.followupImprovedText, 'Текст «стало лучше»'),
    followupSameText: text(body.followupSameText, 'Текст «всё ещё ниже»'),
    maxSteps: int(body.maxSteps ?? 2, 1, 10, 'Максимум советов в цепочке'),
    cooldownDays: int(body.cooldownDays ?? 14, 0, 365, 'Пауза после цепочки, дней'),
    praiseEnabled,
    praiseText: praiseEnabled ? text(body.praiseText, 'Текст похвалы') : (text(body.praiseText, 'Текст похвалы', false) || null),
    praiseCooldownDays: int(body.praiseCooldownDays ?? 14, 1, 365, 'Похвала не чаще, дней'),
    checkHour: int(body.checkHour ?? 10, 0, 23, 'Час проверки'),
    weekdaysOnly: Boolean(body.weekdaysOnly ?? true),
  };
}

interface Stats { open: number; sent30: number; lastEventAt: string | null }

async function loadStats(): Promise<Map<string, Stats>> {
  const db = systemDb();
  const [open, ev] = await Promise.all([
    db.query<{ scenario_id: string; n: string }>(`SELECT scenario_id::text, count(*)::text AS n FROM bot_scenario_runs WHERE status = 'open' GROUP BY 1`),
    db.query<{ scenario_id: string; n: string; last_at: string | Date }>(
      `SELECT scenario_id::text, count(*) FILTER (WHERE created_at > now() - interval '30 days')::text AS n, max(created_at) AS last_at
         FROM bot_scenario_events GROUP BY 1`),
  ]);
  const out = new Map<string, Stats>();
  const get = (id: string) => out.get(id) ?? out.set(id, { open: 0, sent30: 0, lastEventAt: null }).get(id)!;
  for (const r of open.rows) get(r.scenario_id).open = Number(r.n);
  for (const r of ev.rows) { const s = get(r.scenario_id); s.sent30 = Number(r.n); s.lastEventAt = r.last_at ? new Date(r.last_at).toISOString() : null; }
  return out;
}

function withMetric(s: Scenario, metricNames: Map<string, { nameRu: string; dataType: string }>, stats: Stats | undefined) {
  const m = metricNames.get(s.metricId);
  return { ...s, metricName: m?.nameRu ?? s.metricId, metricDataType: m?.dataType ?? 'decimal', stats: stats ?? { open: 0, sent30: 0, lastEventAt: null } };
}

export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const [scenarios, metrics, stats] = await Promise.all([loadScenarios(), loadMetrics(), loadStats()]);
  const names = new Map(metrics.map(m => [m.id, { nameRu: m.nameRu, dataType: m.dataType }]));
  return NextResponse.json({ scenarios: scenarios.map(s => withMetric(s, names, stats.get(s.id))) });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  let p: Parsed;
  try { p = await parseBody(body); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка' }, { status: 400 }); }
  const r = await systemDb().query<{ id: string }>(
    `INSERT INTO bot_scenarios (name, enabled, metric_id, window_days, baseline, target_value, baseline_days, drop_threshold,
       advice_text, followup_days, followup_improved_text, followup_same_text, max_steps, cooldown_days,
       praise_enabled, praise_text, praise_cooldown_days, check_hour, weekdays_only, created_by)
     VALUES ($1, false, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id::text`,
    [p.name, p.metricId, p.windowDays, p.baseline, p.targetValue, p.baselineDays, p.dropThreshold,
     p.adviceText, p.followupDays, p.followupImprovedText, p.followupSameText, p.maxSteps, p.cooldownDays,
     p.praiseEnabled, p.praiseText, p.praiseCooldownDays, p.checkHour, p.weekdaysOnly, session!.login],
  );
  return NextResponse.json({ id: r.rows[0].id });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const id = String(body?.id ?? '');
  if (!body || !ID_RE.test(id)) return NextResponse.json({ error: 'Не указан сценарий' }, { status: 400 });
  const db = systemDb();

  // Быстрый тумблер — только enabled; выключение закрывает открытые цепочки,
  // чтобы после включения не полетели «проверки» месячной давности.
  if (Object.keys(body).length === 2 && typeof body.enabled === 'boolean') {
    await db.query(`UPDATE bot_scenarios SET enabled = $2, updated_at = now() WHERE id = $1`, [id, body.enabled]);
    const closed = body.enabled ? 0 : await closeOpenRuns(id, 'disabled');
    return NextResponse.json({ ok: true, closedRuns: closed });
  }

  let p: Parsed;
  try { p = await parseBody(body); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка' }, { status: 400 }); }
  const r = await db.query(
    `UPDATE bot_scenarios SET name = $2, metric_id = $3, window_days = $4, baseline = $5, target_value = $6, baseline_days = $7,
       drop_threshold = $8, advice_text = $9, followup_days = $10, followup_improved_text = $11, followup_same_text = $12,
       max_steps = $13, cooldown_days = $14, praise_enabled = $15, praise_text = $16, praise_cooldown_days = $17,
       check_hour = $18, weekdays_only = $19, updated_at = now()
     WHERE id = $1`,
    [id, p.name, p.metricId, p.windowDays, p.baseline, p.targetValue, p.baselineDays, p.dropThreshold,
     p.adviceText, p.followupDays, p.followupImprovedText, p.followupSameText, p.maxSteps, p.cooldownDays,
     p.praiseEnabled, p.praiseText, p.praiseCooldownDays, p.checkHour, p.weekdaysOnly],
  );
  if (!r.rowCount) return NextResponse.json({ error: 'Сценарий не найден' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const id = req.nextUrl.searchParams.get('id') ?? '';
  if (!ID_RE.test(id)) return NextResponse.json({ error: 'Не указан сценарий' }, { status: 400 });
  await systemDb().query(`DELETE FROM bot_scenarios WHERE id = $1`, [id]); // runs/events — ON DELETE CASCADE
  return NextResponse.json({ ok: true });
}

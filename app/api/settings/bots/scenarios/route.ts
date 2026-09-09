import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { closeOpenRuns, loadScenario, loadScenarios, type Scenario } from '@/lib/jobs/scenarios';
import { countNodes, validateFlow } from '@/lib/jobs/scenarioFlow';

// Сценарии авто-коучинга (задача владельца 09.09.2026) — CRUD. Только супер-админ,
// как весь реестр бота. Новый сценарий создаётся ВЫКЛЮЧЕННЫМ. Дерево блоков — flow
// jsonb, проверяется validateFlow (тот же код, что подсвечивает ошибки в редакторе).

const ID_RE = /^[0-9a-f-]{36}$/;

function parseMeta(body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim();
  if (!name) throw new Error('Название: заполните');
  if (name.length > 120) throw new Error('Название: не длиннее 120 символов');
  const checkHour = Number(body.checkHour ?? 10);
  if (!Number.isInteger(checkHour) || checkHour < 0 || checkHour > 23) throw new Error('Час проверки: 0–23');
  const weekdaysOnly = Boolean(body.weekdaysOnly ?? true);
  const { flow, errors } = validateFlow(body.flow);
  if (errors.length) throw new Error(errors.join('; '));
  return { name, checkHour, weekdaysOnly, flow };
}

interface Stats { open: number; sent30: number; lastEventAt: string | null }

async function loadStats(): Promise<Map<string, Stats>> {
  const db = systemDb();
  const [open, ev] = await Promise.all([
    db.query<{ scenario_id: string; n: string }>(`SELECT scenario_id::text, count(*)::text AS n FROM bot_scenario_runs WHERE status = 'open' GROUP BY 1`),
    db.query<{ scenario_id: string; n: string; last_at: string | Date }>(
      `SELECT scenario_id::text, count(*) FILTER (WHERE kind = 'message' AND created_at > now() - interval '30 days')::text AS n, max(created_at) AS last_at
         FROM bot_scenario_events GROUP BY 1`),
  ]);
  const out = new Map<string, Stats>();
  const get = (id: string) => out.get(id) ?? out.set(id, { open: 0, sent30: 0, lastEventAt: null }).get(id)!;
  for (const r of open.rows) get(r.scenario_id).open = Number(r.n);
  for (const r of ev.rows) { const s = get(r.scenario_id); s.sent30 = Number(r.n); s.lastEventAt = r.last_at ? new Date(r.last_at).toISOString() : null; }
  return out;
}

async function serializeScenario(s: Scenario, metricNames: Map<string, { nameRu: string; dataType: string }>, stats?: Stats) {
  const m = metricNames.get(s.flow.trigger.metricId);
  return {
    ...s, metricName: m?.nameRu ?? s.flow.trigger.metricId, metricDataType: m?.dataType ?? 'decimal',
    nodeCount: countNodes(s.flow.below) + countNodes(s.flow.norm),
    stats: stats ?? { open: 0, sent30: 0, lastEventAt: null },
  };
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const id = req.nextUrl.searchParams.get('id');
  const metrics = await loadMetrics();
  const names = new Map(metrics.map(m => [m.id, { nameRu: m.nameRu, dataType: m.dataType }]));
  if (id) {
    if (!ID_RE.test(id)) return NextResponse.json({ error: 'Не указан сценарий' }, { status: 400 });
    const s = await loadScenario(id);
    if (!s) return NextResponse.json({ error: 'Сценарий не найден' }, { status: 404 });
    const stats = await loadStats();
    return NextResponse.json({ scenario: await serializeScenario(s, names, stats.get(id)) });
  }
  const [scenarios, stats] = await Promise.all([loadScenarios(), loadStats()]);
  return NextResponse.json({ scenarios: await Promise.all(scenarios.map(s => serializeScenario(s, names, stats.get(s.id)))) });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  try {
    const p = parseMeta(body);
    const r = await systemDb().query<{ id: string }>(
      `INSERT INTO bot_scenarios (name, enabled, flow, check_hour, weekdays_only, created_by) VALUES ($1, false, $2, $3, $4, $5) RETURNING id::text`,
      [p.name, JSON.stringify(p.flow), p.checkHour, p.weekdaysOnly, session!.login],
    );
    return NextResponse.json({ id: r.rows[0].id });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка' }, { status: 400 }); }
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
  // чтобы после включения не полетели продолжения месячной давности.
  if (Object.keys(body).length === 2 && typeof body.enabled === 'boolean') {
    if (body.enabled) {
      const s = await loadScenario(id);
      if (!s) return NextResponse.json({ error: 'Сценарий не найден' }, { status: 404 });
      const { errors } = validateFlow(s.flow);
      if (errors.length || !s.flow.trigger.metricId) return NextResponse.json({ error: `Сценарий не готов: ${errors.join('; ') || 'нет показателя'}` }, { status: 400 });
    }
    await db.query(`UPDATE bot_scenarios SET enabled = $2, updated_at = now() WHERE id = $1`, [id, body.enabled]);
    const closed = body.enabled ? 0 : await closeOpenRuns(id, 'disabled');
    return NextResponse.json({ ok: true, closedRuns: closed });
  }

  try {
    const p = parseMeta(body);
    const r = await db.query(
      `UPDATE bot_scenarios SET name = $2, flow = $3, check_hour = $4, weekdays_only = $5, updated_at = now() WHERE id = $1`,
      [id, p.name, JSON.stringify(p.flow), p.checkHour, p.weekdaysOnly],
    );
    if (!r.rowCount) return NextResponse.json({ error: 'Сценарий не найден' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка' }, { status: 400 }); }
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

import { NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { bx } from '@/lib/bitrix/notify';
import { invalidateGroupings } from '@/lib/marketing/groupings';
import { invalidateSourceMap } from '@/lib/marketing/sources';

// «Ещё → Источники» (задача владельца 22.10): структура маркетинговых источников.
// GET — группировки, группы и все источники (справочник ∪ встречающиеся в сделках) со
// счётчиками сделок; POST — правки ({ op, ... }). Доступ — как у пункта меню: админ ИЛИ
// право section.marketing_sources. Отчёты читают структуру через lib/marketing/groupings.

function canEdit(session: SessionUser): boolean {
  return hasFullManagerAccess(session) || hasPerm(session, 'section.marketing_sources');
}

interface DealStat { source_id: string; deals: number; deals90: number; last_at: string | null }

async function loadDealStats(): Promise<DealStat[]> {
  return cached('mkt:source-deal-stats:v1', 10 * 60, async () => {
    const res = await analyticsDb().query<DealStat>(
      `SELECT d.source_id,
              count(*)::int AS deals,
              (count(*) FILTER (WHERE d.created_at >= now() - interval '90 days'))::int AS deals90,
              max(d.created_at)::text AS last_at
         FROM deals d
        WHERE d.source_id IS NOT NULL
        GROUP BY d.source_id`,
    );
    return res.rows;
  });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canEdit(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const db = systemDb();
  const [gs, groups, assign, sources, stats] = await Promise.all([
    db.query('SELECT id, name, sort FROM marketing_groupings ORDER BY sort, id'),
    db.query('SELECT id, grouping_id AS "groupingId", name, color, sort FROM marketing_groups ORDER BY sort, name'),
    db.query<{ grouping_id: number; source_id: string; group_id: number }>(
      'SELECT grouping_id, source_id, group_id FROM marketing_source_groups'),
    db.query<{ source_id: string; name: string; category: string; note: string | null }>(
      'SELECT source_id, name, category, note FROM marketing_sources'),
    loadDealStats().catch(() => [] as DealStat[]),
  ]);

  const statMap = new Map(stats.map(s => [s.source_id, s]));
  const assignMap = new Map<string, Record<number, number>>();
  for (const a of assign.rows) {
    const m = assignMap.get(a.source_id) ?? {};
    m[a.grouping_id] = a.group_id;
    assignMap.set(a.source_id, m);
  }

  const out = sources.rows.map(s => {
    const st = statMap.get(s.source_id);
    return {
      sourceId: s.source_id, name: s.name, category: s.category, note: s.note, inDirectory: true,
      deals: st?.deals ?? 0, deals90: st?.deals90 ?? 0, lastAt: st?.last_at ?? null,
      assign: assignMap.get(s.source_id) ?? {},
    };
  });
  // source_id, которые есть в сделках, но не в справочнике (новые источники Битрикса).
  const known = new Set(sources.rows.map(s => s.source_id));
  for (const st of stats) {
    if (known.has(st.source_id)) continue;
    out.push({
      sourceId: st.source_id, name: '', category: 'marketing', note: null, inDirectory: false,
      deals: st.deals, deals90: st.deals90, lastAt: st.last_at,
      assign: assignMap.get(st.source_id) ?? {},
    });
  }

  return NextResponse.json({ groupings: gs.rows, groups: groups.rows, sources: out, statsOk: stats.length > 0 });
}

type Body =
  | { op: 'grouping.create'; name: string }
  | { op: 'grouping.update'; id: number; name?: string; sort?: number }
  | { op: 'grouping.delete'; id: number }
  | { op: 'group.create'; groupingId: number; name: string; color?: string | null }
  | { op: 'group.update'; id: number; name?: string; color?: string | null; sort?: number }
  | { op: 'group.delete'; id: number }
  | { op: 'assign'; groupingId: number; sourceIds: string[]; groupId: number | null }
  | { op: 'source.update'; sourceId: string; name?: string; note?: string | null }
  | { op: 'bitrix.sync' };

const clean = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canEdit(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'bad body' }, { status: 400 });
  const db = systemDb();
  const bad = (msg: string) => NextResponse.json({ error: msg }, { status: 400 });

  try {
    switch (body.op) {
      case 'grouping.create': {
        const name = clean(body.name);
        if (!name) return bad('Пустое название');
        const r = await db.query<{ id: number }>(
          `INSERT INTO marketing_groupings (name, sort)
             VALUES ($1, COALESCE((SELECT max(sort) + 1 FROM marketing_groupings), 1)) RETURNING id`, [name]);
        invalidateGroupings();
        return NextResponse.json({ ok: true, id: r.rows[0].id });
      }
      case 'grouping.update': {
        if (!isId(body.id)) return bad('id');
        const name = body.name !== undefined ? clean(body.name) : null;
        if (body.name !== undefined && !name) return bad('Пустое название');
        await db.query(
          `UPDATE marketing_groupings SET name = COALESCE($2, name), sort = COALESCE($3, sort), updated_at = now() WHERE id = $1`,
          [body.id, name, Number.isInteger(body.sort) ? body.sort : null]);
        break;
      }
      case 'grouping.delete': {
        if (!isId(body.id)) return bad('id');
        await db.query('DELETE FROM marketing_groupings WHERE id = $1', [body.id]);
        break;
      }
      case 'group.create': {
        const name = clean(body.name);
        if (!isId(body.groupingId) || !name) return bad('Пустое название');
        const color = body.color && COLOR_RE.test(body.color) ? body.color : null;
        const r = await db.query<{ id: number }>(
          `INSERT INTO marketing_groups (grouping_id, name, color, sort)
             VALUES ($1, $2, $3, COALESCE((SELECT max(sort) + 1 FROM marketing_groups WHERE grouping_id = $1), 1)) RETURNING id`,
          [body.groupingId, name, color]);
        invalidateGroupings();
        return NextResponse.json({ ok: true, id: r.rows[0].id });
      }
      case 'group.update': {
        if (!isId(body.id)) return bad('id');
        const name = body.name !== undefined ? clean(body.name) : null;
        if (body.name !== undefined && !name) return bad('Пустое название');
        const setColor = body.color !== undefined;
        const color = body.color && COLOR_RE.test(body.color) ? body.color : null;
        await db.query(
          `UPDATE marketing_groups
              SET name = COALESCE($2, name),
                  color = CASE WHEN $3 THEN $4 ELSE color END,
                  sort = COALESCE($5, sort)
            WHERE id = $1`,
          [body.id, name, setColor, color, Number.isInteger(body.sort) ? body.sort : null]);
        break;
      }
      case 'group.delete': {
        if (!isId(body.id)) return bad('id');
        await db.query('DELETE FROM marketing_groups WHERE id = $1', [body.id]);
        break;
      }
      case 'assign': {
        if (!isId(body.groupingId)) return bad('groupingId');
        const ids = Array.isArray(body.sourceIds)
          ? [...new Set(body.sourceIds.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 100))]
          : [];
        if (ids.length === 0) return bad('Нет источников');
        if (body.groupId === null) {
          await db.query('DELETE FROM marketing_source_groups WHERE grouping_id = $1 AND source_id = ANY($2)', [body.groupingId, ids]);
        } else {
          if (!isId(body.groupId)) return bad('groupId');
          // Группа обязана принадлежать этой группировке — иначе источник «уедет» в чужую ось.
          const r = await db.query(
            `INSERT INTO marketing_source_groups (grouping_id, source_id, group_id)
               SELECT $1, sid, g.id FROM unnest($2::text[]) AS sid
                 JOIN marketing_groups g ON g.id = $3 AND g.grouping_id = $1
             ON CONFLICT (grouping_id, source_id) DO UPDATE SET group_id = EXCLUDED.group_id, updated_at = now()`,
            [body.groupingId, ids, body.groupId]);
          if (r.rowCount === 0) return bad('Группа не из этой группировки');
        }
        break;
      }
      case 'source.update': {
        const sid = clean(body.sourceId, 100);
        if (!sid) return bad('sourceId');
        const name = body.name !== undefined ? clean(body.name, 300) : null;
        const setNote = body.note !== undefined;
        const note = setNote ? (clean(body.note ?? '', 2000) || null) : null;
        // Источника может не быть в справочнике (новый в Битриксе) — заводим строку.
        await db.query(
          `INSERT INTO marketing_sources (source_id, name, note) VALUES ($1, COALESCE(NULLIF($2, ''), $1), $4)
           ON CONFLICT (source_id) DO UPDATE
              SET name = COALESCE(NULLIF($2, ''), marketing_sources.name),
                  note = CASE WHEN $3 THEN $4 ELSE marketing_sources.note END,
                  updated_at = now()`,
          [sid, name, setNote, note]);
        invalidateSourceMap();
        break;
      }
      case 'bitrix.sync': {
        // Названия новых источников из Битрикса (crm.status.list, ENTITY_ID=SOURCE). Только
        // добавляем недостающие: переименования маркетолога в справочнике не затираем.
        const webhook = process.env.BITRIX_WEBHOOK_URL || '';
        if (!webhook) return bad('Не задан BITRIX_WEBHOOK_URL');
        const res = await bx(webhook, 'crm.status.list', { filter: { ENTITY_ID: 'SOURCE' } });
        const list = ((res?.result ?? []) as { STATUS_ID?: string; NAME?: string }[])
          .filter(x => x.STATUS_ID && x.NAME);
        let added = 0;
        if (list.length > 0) {
          const r = await db.query(
            `INSERT INTO marketing_sources (source_id, name)
               SELECT * FROM unnest($1::text[], $2::text[])
             ON CONFLICT (source_id) DO NOTHING`,
            [list.map(x => x.STATUS_ID!), list.map(x => x.NAME!.slice(0, 300))]);
          added = r.rowCount ?? 0;
          // Строки, заведённые вручную без названия (name = id), получают имя из Битрикса.
          await db.query(
            `UPDATE marketing_sources ms SET name = b.name, updated_at = now()
               FROM unnest($1::text[], $2::text[]) AS b(id, name)
              WHERE ms.source_id = b.id AND ms.name = ms.source_id`,
            [list.map(x => x.STATUS_ID!), list.map(x => x.NAME!.slice(0, 300))]);
        }
        invalidateSourceMap();
        return NextResponse.json({ ok: true, added, total: list.length });
      }
      default:
        return bad('unknown op');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate key|unique/i.test(msg)) return bad('Такое название уже есть');
    throw e;
  }
  invalidateGroupings();
  return NextResponse.json({ ok: true });
}

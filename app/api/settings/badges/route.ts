import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { getCurrencyName } from '@/features/badges/engine/coins';
import { CUSTOM_PREFIX, describeCustom, validateCustomCriteria } from '@/features/badges/engine/customTemplates';

// Каталог наград для «Настройки → Награды» (задача 2655). Админский паттерн:
// как roles — только супер-админ (гейт и в layout вкладки).
// + Цены валюты по (badge_key, tier) и название валюты (задача 2657).
export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  const db = systemDb();
  const [res, currencyName] = await Promise.all([
    db.query(
      `SELECT d.key, d.name, d.description, d.icon, d.category, d.tiered, d.criteria,
              d.enabled, d.sort_order,
              coalesce(a.awards, 0)::int AS awards,
              coalesce(a.holders, 0)::int AS holders,
              coalesce(p.prices, '{}'::jsonb) AS prices
         FROM badge_definitions d
         LEFT JOIN (
           SELECT badge_key, count(*) AS awards, count(DISTINCT bitrix_id) AS holders
             FROM badge_awards GROUP BY badge_key
         ) a ON a.badge_key = d.key
         LEFT JOIN (
           SELECT badge_key, jsonb_object_agg(tier, price) AS prices
             FROM badge_prices GROUP BY badge_key
         ) p ON p.badge_key = d.key
        ORDER BY d.sort_order`,
    ),
    getCurrencyName(db),
  ]);
  return NextResponse.json({ rows: res.rows, currencyName });
}

// ── Конструктор наград (этап 2): создание кастомного определения ─────────────
// key генерится транслит-слагом имени с префиксом custom_; конфликты ключей
// исключены числовым суффиксом. Ретро подхватит первый же пересчёт (ночной тик
// или кнопка) — отдельного механизма не нужно: пересчёт полный и идемпотентный.

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

function slugify(name: string): string {
  const slug = name.toLowerCase()
    .split('')
    .map(ch => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
    .replace(/_+$/g, '');
  return slug || 'badge';
}

/** Максимум символов в описании награды — см. комментарий у description. */
export const BADGE_DESC_MAX = 200;

export async function POST(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  let body: {
    name?: unknown; description?: unknown; icon?: unknown; enabled?: unknown;
    criteria?: unknown; prices?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  if (!name) return NextResponse.json({ error: 'Название не может быть пустым' }, { status: 400 });

  const v = validateCustomCriteria(body.criteria);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const criteria = v.criteria;

  const tiered = criteria.template === 'top_metric' && criteria.tieredScopes === true;
  const icon = typeof body.icon === 'string' && body.icon.trim() ? body.icon.trim().slice(0, 16) : '🏅';
  // Лимит описания — 200 символов (правка владельца 05.08: «при создании новой
  // введи лимит на символы»). Порог взят с запасом к боевому максимуму (161) и
  // согласован с вёрсткой карточки: 200 знаков — те же 4 строки в узкой сетке,
  // ничего не режется. Раньше стояло 1000 — такой текст карточку бы разорвал.
  const description = typeof body.description === 'string' && body.description.trim()
    ? body.description.trim().slice(0, BADGE_DESC_MAX)
    : describeCustom(criteria);
  const enabled = body.enabled !== false;
  // Секретная ачивка (миграция 152): не показывается в списке неполученных.
  const isSecret = (body as { isSecret?: unknown }).isSecret === true;

  // Цены при создании (по уровням для tiered): та же валидация, что в PATCH.
  const priceEntries: [string, number][] = [];
  if (body.prices !== undefined) {
    if (typeof body.prices !== 'object' || body.prices === null || Array.isArray(body.prices)) {
      return NextResponse.json({ error: 'prices: объект {tier: цена}' }, { status: 400 });
    }
    const allowed = tiered ? ['bronze', 'silver', 'gold', 'platinum'] : ['-'];
    for (const [tier, p] of Object.entries(body.prices as Record<string, unknown>)) {
      if (!allowed.includes(tier)) {
        return NextResponse.json({ error: `prices: неожиданный уровень «${tier}»` }, { status: 400 });
      }
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 1_000_000) {
        return NextResponse.json({ error: `prices.${tier}: целое число 0..1000000` }, { status: 400 });
      }
      priceEntries.push([tier, p]);
    }
  }

  const db = systemDb();
  // Уникальный key: custom_<слаг>[_N] — конфликты исключены проверкой по БД.
  const base = CUSTOM_PREFIX + slugify(name);
  const taken = new Set(
    (await db.query<{ key: string }>(`SELECT key FROM badge_definitions WHERE key LIKE $1 || '%'`, [base])).rows.map(r => r.key),
  );
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO badge_definitions (key, name, description, icon, category, tiered, criteria, enabled, is_secret, sort_order)
       VALUES ($1, $2, $3, $4, 'custom', $5, $6, $7, $8,
               200 + (SELECT count(*) FROM badge_definitions WHERE key LIKE '${CUSTOM_PREFIX}%'))`,
      [key, name, description, icon, tiered, JSON.stringify(criteria), enabled, isSecret],
    );
    for (const [tier, price] of priceEntries) {
      await client.query(
        `INSERT INTO badge_prices (badge_key, tier, price) VALUES ($1, $2, $3)`,
        [key, tier, price],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true, key });
}

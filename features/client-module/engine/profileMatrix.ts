import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { CLIENT_KEY_CASE_SQL } from '@/features/customers/engine/clientKey';
import type { CrossSellMatrix } from '@/features/customers/engine/crossSell';
import type { ClientProfileKind } from './recommend';

// Матрицы переходов «отгрузили X → следующей покупкой Y» ОТДЕЛЬНО по профилям
// клиентов (аудит 14.10, Fable: «данные частников давят подрядчиков» — в общей
// матрице после «Сухих смесей» идёт «Газобетон», что подрядчику, возящему ЖБИ и
// щебень, бессмысленно). Та же механика, что у общей матрицы «Моих заказчиков»
// (crossSell.ts, MATRIX_SQL: клиент — CLIENT_KEY_CASE_SQL, LEAD по продажам,
// услуги/доставка/«Разное» исключены), плюс деление клиентов на профили по
// составу ИХ покупок: > 50% суммы — ЖБИ/нерудка/бетон и т.п. → подрядчик.
// Список групп «подрядчика» — тот же, что в recommend.ts (CONTRACTOR_GROUPS).
// Тяжёлый full-scan → Redis на сутки; одновременные открытия ждут один расчёт.

const HEAVY_RE = '(жби|щебень|песок|бетон и раствор|дорожные плиты|аэродромные|асфальт|грунт|фбс|кольца|лотки|опоры|керамзит|вторичные|арматура|плиты перекрытия|прочий металлопрокат|трубы)';
const NUM = `CASE WHEN (p->>'sum') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (p->>'sum')::numeric ELSE 0 END`;

const SQL = `
WITH dg AS (
  SELECT * FROM (
    SELECT (${CLIENT_KEY_CASE_SQL}) AS client_key, d.sold_at, d.deal_id,
           array(SELECT DISTINCT (p->>'head_group_name') FROM jsonb_array_elements(d.products) p
                 WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
                   AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)') AS grps,
           (SELECT coalesce(sum(${NUM}), 0) FROM jsonb_array_elements(d.products) p
             WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') ~* '${HEAVY_RE}') AS heavy,
           (SELECT coalesce(sum(${NUM}), 0) FROM jsonb_array_elements(d.products) p
             WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
               AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)') AS goods
    FROM sa.deals d
    WHERE d.sold_at IS NOT NULL AND d.funnel_id IN (0,1,2,3)
  ) t
  WHERE client_key IS NOT NULL
), cls AS (
  SELECT client_key, CASE WHEN sum(goods) > 0 AND sum(heavy) / sum(goods) > 0.5 THEN 'contractor' ELSE 'builder' END AS kind
  FROM dg GROUP BY client_key
), seq AS (
  SELECT client_key, grps AS prev_grps,
         LEAD(grps) OVER (PARTITION BY client_key ORDER BY sold_at, deal_id) AS next_grps
  FROM dg
)
SELECT c.kind, x AS from_group, y AS to_group, count(*)::int AS cnt
FROM seq JOIN cls c USING (client_key), unnest(prev_grps) x, unnest(next_grps) y
WHERE next_grps IS NOT NULL
GROUP BY 1, 2, 3
`;

export type ProfileMatrices = Record<ClientProfileKind, CrossSellMatrix>;

const empty = (): CrossSellMatrix => ({ from: {}, globalTo: {}, globalTotal: 0 });
let inflight: Promise<ProfileMatrices> | null = null;

export function fetchProfileMatrices(): Promise<ProfileMatrices> {
  inflight ??= cached('client-module:matrix-by-profile:v1', 24 * 60 * 60, async () => {
    const res = await analyticsDb().query<{ kind: ClientProfileKind; from_group: string; to_group: string; cnt: number }>(SQL);
    const out: ProfileMatrices = { builder: empty(), contractor: empty() };
    for (const r of res.rows) {
      const m = out[r.kind] ?? out.builder;
      const f = (m.from[r.from_group] ??= { total: 0, to: {} });
      f.total += r.cnt;
      f.to[r.to_group] = (f.to[r.to_group] ?? 0) + r.cnt;
      m.globalTo[r.to_group] = (m.globalTo[r.to_group] ?? 0) + r.cnt;
      m.globalTotal += r.cnt;
    }
    return out;
  }).finally(() => { setTimeout(() => { inflight = null; }, 60_000); });
  return inflight;
}

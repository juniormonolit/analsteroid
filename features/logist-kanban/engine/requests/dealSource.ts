// Чтение сделки из Битрикса для черновика: шапка (crm.deal.get), товары (crm.deal.productrows.get),
// название заказчика. ТОЛЬКО чтение. Товарные группы позиций — из sa.deals.products (как у канбана больших чеков).
import { analyticsDb } from '@/lib/db/clients';
import { BRANCH_LABELS } from '@/lib/org/deptCategories';
import { read } from '@/features/repeat-kanban/engine/createDeal';
import { isPickupAddress, parseAddressCoords } from '@/lib/bitrix/addressUtils';
import type { ItemInput } from './contract';

export interface DealSnapshot {
  dealId: number; title: string | null; amount: number | null; categoryId: number | null; stageId: string | null;
  assignedBitrixId: string | null; clientRef: string | null; clientName: string | null;
  address: string | null;
  items: ItemInput[];
  /** товарные группы сделки (голова первой) — для очереди по умолчанию */
  productGroups: string[];
}

interface BxDeal { ID: string; TITLE?: string; OPPORTUNITY?: string; CATEGORY_ID?: string; STAGE_ID?: string; ASSIGNED_BY_ID?: string; CONTACT_ID?: string | null; COMPANY_ID?: string | null; [k: string]: unknown }
interface BxRow { ID?: string; PRODUCT_ID?: string | number; PRODUCT_NAME?: string; QUANTITY?: string | number; PRICE?: string | number; MEASURE_NAME?: string | null }

/** Адрес объекта сделки: «адрес||широта,долгота» (lib/bitrix/dealAddress.ts). «Париж» = самовывоз. */
const ADDRESS_FIELD = 'UF_ADDRESS_COORDS';

async function productGroupsOf(dealId: number): Promise<{ head: string | null; byProductName: Map<string, string>; all: string[] }> {
  const empty = { head: null, byProductName: new Map<string, string>(), all: [] as string[] };
  try {
    const r = await analyticsDb().query<{ head: string | null; products: { name?: string; head_group_name?: string; type?: string }[] | null }>(
      `SELECT head_group_name AS head, products FROM sa.deals WHERE deal_id = $1`, [dealId]);
    const row = r.rows[0];
    if (!row) return empty;
    const by = new Map<string, string>();
    const all: string[] = [];
    if (row.head) all.push(row.head);
    for (const p of row.products ?? []) {
      if (!p.head_group_name || p.type === 'услуга') continue;
      if (p.name) by.set(p.name.trim().toLowerCase(), p.head_group_name);
      if (!all.includes(p.head_group_name)) all.push(p.head_group_name);
    }
    return { head: row.head, byProductName: by, all: all.filter(g => !/^(доставка|перевозка|услуг|разное)/i.test(g)) };
  } catch (e) {
    console.warn('[logist-requests] sa.deals недоступна:', e instanceof Error ? e.message : e);
    return empty;
  }
}

export async function readDeal(dealId: number): Promise<DealSnapshot> {
  const [deal, rows, groups] = await Promise.all([
    read<BxDeal>('crm.deal.get', { id: dealId }),
    read<BxRow[]>('crm.deal.productrows.get', { id: dealId }).catch(() => [] as BxRow[]),
    productGroupsOf(dealId),
  ]);
  let clientRef: string | null = null, clientName: string | null = null;
  if (deal.COMPANY_ID && deal.COMPANY_ID !== '0') {
    clientRef = `k${deal.COMPANY_ID}`;
    const c = await read<{ TITLE?: string }>('crm.company.get', { id: Number(deal.COMPANY_ID) }).catch(() => null);
    clientName = c?.TITLE ?? null;
  } else if (deal.CONTACT_ID && deal.CONTACT_ID !== '0') {
    clientRef = `c${deal.CONTACT_ID}`;
    const c = await read<{ NAME?: string; LAST_NAME?: string; SECOND_NAME?: string }>('crm.contact.get', { id: Number(deal.CONTACT_ID) }).catch(() => null);
    clientName = c ? [c.LAST_NAME, c.NAME, c.SECOND_NAME].filter(Boolean).join(' ') || null : null;
  }
  const items: ItemInput[] = (rows ?? []).filter(r => r.PRODUCT_NAME).map(r => ({
    kind: 'deal_row',
    bxRowId: r.ID ? Number(r.ID) || null : null,
    bxProductId: r.PRODUCT_ID && Number(r.PRODUCT_ID) > 0 ? Number(r.PRODUCT_ID) : null,
    name: String(r.PRODUCT_NAME).trim().slice(0, 500),
    quantity: r.QUANTITY != null ? Number(r.QUANTITY) : null,
    measure: r.MEASURE_NAME ?? null,
    ourPrice: r.PRICE != null ? Number(r.PRICE) : null,
    productGroup: groups.byProductName.get(String(r.PRODUCT_NAME).trim().toLowerCase()) ?? null,
  }));
  const parsed = parseAddressCoords(typeof deal[ADDRESS_FIELD] === 'string' ? deal[ADDRESS_FIELD] as string : null);
  const address = parsed.address ? (isPickupAddress(parsed.address) ? 'Самовывоз' : parsed.address.slice(0, 500)) : null;
  return {
    dealId, title: deal.TITLE ?? null, amount: deal.OPPORTUNITY != null ? Number(deal.OPPORTUNITY) : null,
    categoryId: deal.CATEGORY_ID != null && deal.CATEGORY_ID !== '' ? Number(deal.CATEGORY_ID) : null,
    stageId: deal.STAGE_ID ?? null, assignedBitrixId: deal.ASSIGNED_BY_ID ?? null,
    clientRef, clientName, address,
    items, productGroups: [...new Set([...items.map(i => i.productGroup).filter((g): g is string => !!g), ...groups.all])],
  };
}

/** Регион менеджера (МСК/СПБ/КРД) по оргструктуре. */
export async function managerRegion(bitrixId: string): Promise<string | null> {
  try {
    const r = await analyticsDb().query<{ branch: string | null }>(
      `SELECT branch FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id::text = $1 AND is_active = true LIMIT 1`, [bitrixId]);
    const b = r.rows[0]?.branch;
    return b ? BRANCH_LABELS[b] ?? b : null;
  } catch {
    return null;
  }
}

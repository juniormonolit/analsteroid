// «Совет» на «Обзоре» (владелец 15.10) — короткие подсказки менеджеру, что делать
// с клиентом. Каждый вид совета — отдельное правило; новые владелец будет
// присылать по мере появления идей, они добавляются в RULES.
//
// Правило 1 «Повтор объекта»: если на текущем объекте клиент берёт ту же группу,
// что и на одном из прошлых, — предложить то, что на прошлом объекте он брал
// ПОСЛЕ неё. «На «Поварово» брал арматуру (как и сейчас), а после — бетон,
// утеплитель и газобетон. Скорее всего, строит то же самое».

import { type ClientModuleData, type ModuleDeal, objectStatus, EMPTY_OBJECT_PROFILE } from './types';

export interface Advice {
  id: string;
  /** Текст совета (готовая фраза). */
  text: string;
  /** Что предложить — для чипов. */
  groups: string[];
}

type Shipment = { group: string; at: string };

/** Отгрузки объекта по группам: первая дата каждой группы, по хронологии. */
function shipments(deals: ModuleDeal[]): Shipment[] {
  const first = new Map<string, string>();
  for (const d of deals) if (d.deliveredAt) for (const g of d.groups) {
    const prev = first.get(g);
    if (!prev || d.deliveredAt < prev) first.set(g, d.deliveredAt);
  }
  return [...first].map(([group, at]) => ({ group, at })).sort((a, b) => a.at.localeCompare(b.at));
}

/** Строчная первая буква; аббревиатуры («ЖБИ», «ОСП») не трогаем. */
const lc = (g: string) => (/^[А-ЯЁA-Z][а-яёa-z]/.test(g) ? g[0].toLowerCase() + g.slice(1) : g);

function repeatObject(data: ClientModuleData, short: (g: string) => string): Advice[] {
  const byObj = new Map<string, ModuleDeal[]>();
  for (const d of data.deals) if (d.objectKey) byObj.set(d.objectKey, [...(byObj.get(d.objectKey) ?? []), d]);
  const objs = data.objects.map(o => {
    const deals = byObj.get(o.key) ?? [];
    const prof = data.objectProfiles[o.key] ?? EMPTY_OBJECT_PROFILE;
    return { o, ship: shipments(deals), st: objectStatus(deals, { manual: o.manual, doneManual: prof.doneManual }, data.activeDays) };
  }).filter(x => x.ship.length > 0);

  const out: Advice[] = [];
  // Текущие — в работе/новые; по каждому (не больше двух) ищем лучший прошлый.
  const current = objs.filter(x => x.st !== 'done').sort((a, b) => b.ship[b.ship.length - 1].at.localeCompare(a.ship[a.ship.length - 1].at)).slice(0, 2);
  for (const cur of current) {
    const curGroups = new Set(cur.ship.map(s => s.group));
    const excluded = new Set([...data.dismissed.client, ...(data.dismissed.byObject[cur.o.key] ?? [])]);
    let best: { label: string; common: string[]; next: string[]; lastAt: string } | null = null;
    for (const prev of objs) {
      if (prev === cur || prev.ship[0].at >= cur.ship[0].at) continue;   // прошлый = начался раньше текущего
      const common = prev.ship.filter(s => curGroups.has(s.group));
      if (common.length === 0) continue;
      const from = common[0].at;
      const next = prev.ship.filter(s => s.at > from && !curGroups.has(s.group) && !excluded.has(s.group)).map(s => s.group);
      if (next.length === 0) continue;
      const lastAt = prev.ship[prev.ship.length - 1].at;
      // Лучший — больше общих групп, при равенстве — свежее.
      if (!best || common.length > best.common.length || (common.length === best.common.length && lastAt > best.lastAt)) {
        best = { label: prev.o.label, common: common.map(s => s.group), next, lastAt };
      }
    }
    if (!best) continue;
    const next = best.next.slice(0, 5);
    const sameLabel = best.label === cur.o.label;
    out.push({
      id: `repeat:${cur.o.key}`,
      groups: next,
      // Названия групп — в именительном (склонять «Бетон и раствор» нельзя):
      // списки в скобках и после двоеточия.
      text: `Обрати внимание: на ${sameLabel ? 'предыдущем объекте' : `объекте «${best.label}»`} заказчик брал то же, что и сейчас${current.length > 1 || !sameLabel ? ` на «${cur.o.label}»` : ''} (${best.common.slice(0, 3).map(g => lc(short(g))).join(', ')}), а после этого заказывал: ${next.map(g => lc(short(g))).join(', ')}. Скорее всего, строит то же самое — предложи эти материалы.`,
    });
  }
  return out;
}

const RULES: ((data: ClientModuleData, short: (g: string) => string) => Advice[])[] = [repeatObject];

export function buildAdvice(data: ClientModuleData, short: (g: string) => string = g => g): Advice[] {
  return RULES.flatMap(r => r(data, short));
}

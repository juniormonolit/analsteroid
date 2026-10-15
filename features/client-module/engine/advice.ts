// «Совет» на «Обзоре» (владелец 15.10) — короткие подсказки менеджеру, что делать
// с клиентом. Каждый вид совета — отдельное правило; новые владелец будет
// присылать по мере появления идей, они добавляются в RULES.
//
// Правило 1 «Повтор объекта»: если на текущем объекте клиент берёт ту же группу,
// что и на одном из прошлых, — предложить то, что на прошлом объекте он брал
// ПОСЛЕ неё. «На «Поварово» брал арматуру (как и сейчас), а после — бетон,
// утеплитель и газобетон. Скорее всего, строит то же самое».
//
// Правило 2 «Объект простаивает»: объект в работе, отгрузки не было ≥ 30 дней,
// сделок в работе нет — позвонить, узнать, как идёт стройка, и предложить
// следующую стадию по лестнице объекта.
//
// Правило 3 «Сигнал ухода»: из трёх последних закрытых сделок ≥2 — отказы
// «Уже заказали / Дорого / Передумали», и с последней покупки прошло больше
// обычного цикла (или циклов нет). Одного отказа мало — причины ставят небрежно.

import { type ClientModuleData, type ModuleDeal, objectStatus, isOpenDeal, EMPTY_OBJECT_PROFILE } from './types';
import { callTiming } from './callTiming';

export interface Advice {
  id: string;
  /** Текст совета (готовая фраза). */
  text: string;
  /** Что предложить — для чипов. */
  groups: string[];
  /** Тревожный совет (риск ухода) — красным. */
  alarm?: boolean;
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
      // Аудит 15.10: действие — первым словом, причина — следом (раньше главное
      // пряталось в конце шестистрочной фразы).
      text: `Предложи ${next.map(g => lc(short(g))).join(', ')}. На ${sameLabel ? 'предыдущем объекте' : `«${best.label}»`} после того же, что берёт сейчас${current.length > 1 || !sameLabel ? ` на «${cur.o.label}»` : ''} (${best.common.slice(0, 3).map(g => lc(short(g))).join(', ')}), он заказывал именно это — похоже, строит то же самое.`,
    });
  }
  return out;
}

const STALL_DAYS = 30;

function stalledObject(data: ClientModuleData, short: (g: string) => string): Advice[] {
  const out: (Advice & { last: string })[] = [];
  const now = Date.now();
  for (const o of data.objects) {
    const deals = data.deals.filter(d => d.objectKey === o.key);
    const prof = data.objectProfiles[o.key] ?? EMPTY_OBJECT_PROFILE;
    if (objectStatus(deals, { manual: o.manual, doneManual: prof.doneManual }, data.activeDays) !== 'active') continue;
    if (deals.some(isOpenDeal)) continue;
    const last = deals.reduce<string | null>((m, d) => (d.deliveredAt && (!m || d.deliveredAt > m) ? d.deliveredAt : m), null);
    if (!last) continue;
    const idle = Math.floor((now - new Date(last).getTime()) / 86_400_000);
    if (idle < STALL_DAYS) continue;
    const next = data.recommendations.byObject[o.key]?.next[0]?.group;
    out.push({
      last,
      id: `stall:${o.key}`,
      groups: next ? [next] : [],
      text: `Позвони про «${o.label}»: ${idle} дн. без отгрузки, сделок нет. Узнай, как идёт стройка${next ? ` — по цепочке дальше ${lc(short(next))}` : ''}.`,
    });
  }
  // Не больше одного — по самому свежему объекту (на 33 клиентах было 37 советов:
  // шум, «простаивает» почти любой активный объект).
  return out.sort((a, b) => b.last.localeCompare(a.last)).slice(0, 1).map(({ last: _l, ...a }) => a);
}

const CHURN_REASON = /уже заказ|дорого|передумал/i;

function churnSignal(data: ClientModuleData): Advice[] {
  // deals отсортированы по created_at ↓.
  const closed = data.deals.filter(d => d.stage === 'lost' || d.stage === 'shipped').slice(0, 3);
  const bad = closed.filter(d => d.stage === 'lost' && CHURN_REASON.test(d.stageName ?? ''));
  if (bad.length < 2) return [];
  const t = callTiming(data.deals);
  const lastShip = data.deals.reduce<string | null>((m, d) => (d.deliveredAt && (!m || d.deliveredAt > m) ? d.deliveredAt : m), null);
  const since = lastShip ? Math.floor((Date.now() - new Date(lastShip).getTime()) / 86_400_000) : null;
  if (t && since !== null && since <= t.cycle) return [];   // покупает в своём ритме — не паникуем
  const reasons = [...new Set(bad.map(d => d.stageName!))].map(r => `«${r}»`).join(', ');
  return [{
    id: 'churn',
    groups: [],
    alarm: true,
    text: `Риск ухода: узнай, где сейчас берёт и почему, — предложи условия лучше. ${bad.length} из ${closed.length} последних сделок — отказ (${reasons})${since !== null ? `, с последней покупки ${since} дн.${t ? ` при обычных ${t.cycle}` : ''}` : ''}.`,
  }];
}

const RULES: ((data: ClientModuleData, short: (g: string) => string) => Advice[])[] = [churnSignal, repeatObject, stalledObject];

export function buildAdvice(data: ClientModuleData, short: (g: string) => string = g => g): Advice[] {
  const all = RULES.flatMap(r => r(data, short));
  // По одному объекту — один совет: «повтор» конкретнее, чем «простаивает».
  const repeated = new Set(all.filter(a => a.id.startsWith('repeat:')).map(a => a.id.slice(7)));
  return all.filter(a => !(a.id.startsWith('stall:') && repeated.has(a.id.slice(6))));
}

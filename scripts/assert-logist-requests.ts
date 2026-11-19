/**
 * Assert-скрипт: канбан запросов логистам (S1) — чистые функции движка, БЕЗ БД.
 *  1. Рабочее время: дедлайн SLA через выходные/праздники/вечер, остаток и просрочка.
 *  2. Статусы: переходы и «кто может» (менеджер / логист очереди / держатель / РОП / админ), видимость черновика.
 *  3. Циклы по журналу: цикл 1 от отправки, возврат открывает новый, skip_take при ответе из «Новых».
 *  4. Приоритет: просрочка наверху, причины «почему горячий», закрытые — 0.
 *  5. Фильтры: разбор/сборка URL туда-обратно, matchFilters, сортировка.
 *  6. Варианты: суммы строк, «нет в наличии» не в сумме; проверка перед отправкой; очередь по умолчанию.
 *
 * Запуск: npm run test:logist-requests
 */
import { addWorkHours, workHoursBetween, workHoursLeft } from '../features/logist-kanban/engine/requests/worktime.ts';
import { allowedActions, canDo, canSee, type ActorCtx, type RequestPeople } from '../features/logist-kanban/engine/requests/status.ts';
import { buildCycles } from '../features/logist-kanban/engine/requests/cycles.ts';
import { DEFAULT_SETTINGS, computePriority, computeSla, mergeSettings } from '../features/logist-kanban/engine/requests/priority.ts';
import { filtersToSearchParams, matchFilters, parseFilters, sortComparator } from '../features/logist-kanban/engine/requests/filters.ts';
import { offerTotals, parseAction, parseOffer, sendProblems, InputError } from '../features/logist-kanban/engine/requests/validate.ts';
import { membersFromBitrix, pickDefaultQueue, queuesFromSupplyFacts, regionFromName } from '../features/logist-kanban/engine/requests/routing.ts';
import { computeTiles } from '../features/logist-kanban/engine/requests/tiles.ts';
import type { LogistQueue, QueueMember, RequestCard } from '../features/logist-kanban/engine/requests/contract.ts';
import { queueRecipients, recipientVerdict } from '../features/logist-kanban/engine/requests/recipients.ts';
import { attentionOf, buildAnalytics } from '../features/logist-kanban/engine/requests/my.ts';

let failures = 0, passed = 0;
function check(cond: boolean, label: string, extra?: unknown) {
  if (cond) { passed++; console.log(`  ok   ${label}`); } else { failures++; console.error(`  FAIL ${label}`, extra ?? ''); }
}
const throws = (fn: () => unknown) => { try { fn(); return false; } catch (e) { return e instanceof InputError; } };
/** МСК → ISO UTC */
const msk = (s: string) => new Date(`${s}:00+03:00`).toISOString();

// ── 1. рабочее время ────────────────────────────────────────────────────────────────────
console.log('рабочее время');
check(workHoursBetween(msk('2026-11-19T10:00'), msk('2026-11-19T12:30')) === 2.5, 'чт 10:00→12:30 = 2.5 ч');
check(workHoursBetween(msk('2026-11-20T17:00'), msk('2026-11-23T10:00')) === 2, 'пт 17:00 → пн 10:00 = 2 ч (выходные не считаются)');
check(addWorkHours(msk('2026-11-19T10:00'), 3).toISOString() === msk('2026-11-19T13:00'), 'SLA 3 ч от чт 10:00 → 13:00');
check(addWorkHours(msk('2026-11-20T16:30'), 3).toISOString() === msk('2026-11-23T10:30'), 'SLA 3 ч от пт 16:30 → пн 10:30');
check(addWorkHours(msk('2026-11-19T20:00'), 3).toISOString() === msk('2026-11-20T12:00'), 'отправка вечером → отсчёт с 9:00 следующего дня');
check(addWorkHours(msk('2026-11-03T17:00'), 3).toISOString() === msk('2026-11-05T11:00'), '04.11 — праздник: вт 17:00 + 3 ч → чт 11:00');
check(workHoursLeft(msk('2026-11-19T13:00'), msk('2026-11-19T12:00')) === 1, 'остаток 1 ч');
check(workHoursLeft(msk('2026-11-19T13:00'), msk('2026-11-19T15:30')) === -2.5, 'просрочка −2.5 ч');

// ── 2. статусы и права ──────────────────────────────────────────────────────────────────
console.log('статусы и права');
const actor = (p: Partial<ActorCtx>): ActorCtx => ({ bitrixId: null, login: 'x', canManage: false, queueIds: new Set(), leadQueueIds: new Set(), zone: new Set(), ...p });
const req = (p: Partial<RequestPeople>): RequestPeople => ({ status: 'new', managerBitrixId: '100', createdByLogin: 'mgr', logistBitrixId: null, queueId: 5, ...p });
const manager = actor({ bitrixId: '100', login: 'mgr' });
const logist = actor({ bitrixId: '200', login: 'lg', queueIds: new Set([5]) });
const otherLogist = actor({ bitrixId: '201', login: 'lg2', queueIds: new Set([7]) });
const rop = actor({ bitrixId: '300', login: 'rop', zone: new Set(['100']) });
const admin = actor({ bitrixId: '1', login: 'adm', canManage: true });
const stranger = actor({ bitrixId: '999', login: 'zz' });

check(canSee(manager, req({ status: 'draft' })), 'черновик видит автор');
check(!canSee(logist, req({ status: 'draft' })), 'черновик не видит логист очереди');
check(!canSee(rop, req({ status: 'draft' })), 'черновик не видит РОП');
check(canSee(admin, req({ status: 'draft' })), 'черновик видит админ');
check(canSee(logist, req({})) && canSee(rop, req({})), 'новый видят логист очереди и РОП зоны');
check(!canSee(otherLogist, req({})) && !canSee(stranger, req({})), 'чужая очередь и посторонний не видят');
check(canSee(otherLogist, req({ status: 'in_work', logistBitrixId: '201' })), 'держатель видит, даже если очередь сменилась');

check(canDo(manager, req({ status: 'draft' }), 'send').ok, 'менеджер отправляет черновик');
check(!canDo(logist, req({ status: 'draft' }), 'send').ok, 'логист не отправляет чужой черновик');
check(canDo(logist, req({}), 'take').ok, 'логист очереди берёт новый');
check(!canDo(otherLogist, req({}), 'take').ok, 'логист чужой очереди не берёт');
check(canDo(logist, req({}), 'take').ok && !canDo(logist, req({ status: 'in_work', logistBitrixId: '200' }), 'take').ok, 'взятый повторно не взять');
const inWork = req({ status: 'in_work', logistBitrixId: '200' });
check(canDo(logist, inWork, 'answer').ok && canDo(logist, inWork, 'release').ok, 'держатель отвечает и отпускает');
const inWorkOther = req({ status: 'in_work', logistBitrixId: '202' });
check(!canDo(logist, inWorkOther, 'answer').ok && !canDo(logist, inWorkOther, 'release').ok, 'чужой взятый: не ответить, не отпустить');
check(canDo(logist, req({}), 'answer').ok, 'ответ сразу из «Новых» логистом очереди');
const answered = req({ status: 'answered', logistBitrixId: '200' });
check(canDo(manager, answered, 'accept').ok && canDo(manager, answered, 'return').ok, 'менеджер принимает / возвращает');
check(!canDo(logist, answered, 'accept').ok, 'логист не принимает свой вариант');
check(canDo(logist, answered, 'answer').ok, '«ещё варианты» в статусе «Ждёт контроля»');
check(canDo(rop, answered, 'cancel').ok && canDo(manager, answered, 'cancel').ok, 'отменяют менеджер и РОП');
check(!canDo(logist, answered, 'cancel').ok, 'логист не отменяет');
check(canDo(rop, inWork, 'reassign').ok && !canDo(logist, inWork, 'reassign').ok, 'переназначает РОП, рядовой логист — нет');
check(canDo(actor({ bitrixId: '210', leadQueueIds: new Set([5]), queueIds: new Set([5]) }), inWork, 'reassign').ok, 'переназначает руководитель очереди');
const acc = canDo(manager, req({ status: 'accepted' }), 'cancel');
check(!acc.ok && acc.code === 'transition', 'принятый не отменить (transition)');
check(canDo(admin, req({ status: 'answered' }), 'accept').ok, 'админ может всё допустимое');
const can = allowedActions(manager, answered);
check(can.accept && can.return && can.message && !can.take, 'allowedActions для кнопок');

// ── 3. циклы ────────────────────────────────────────────────────────────────────────────
console.log('циклы');
const L = { bitrixId: '200', name: 'Логист' };
const cycles = buildCycles([
  { at: msk('2026-11-19T10:00'), kind: 'sent', actor: null },
  { at: msk('2026-11-19T10:30'), kind: 'taken', actor: L },
  { at: msk('2026-11-19T12:00'), kind: 'answered', actor: L },
  { at: msk('2026-11-19T12:10'), kind: 'answered', actor: L },
  { at: msk('2026-11-19T14:00'), kind: 'returned', actor: null },
  { at: msk('2026-11-19T15:00'), kind: 'answered', actor: L },
  { at: msk('2026-11-19T16:00'), kind: 'accepted', actor: null },
]);
check(cycles.length === 2, 'возврат открыл второй цикл');
check(cycles[0]!.takeH === 0.5 && cycles[0]!.execH === 1.5 && cycles[0]!.answerH === 2, 'цикл 1: взятие 0.5, выполнение 1.5, ответ 2 ч (первый ответ)', cycles[0]);
check(cycles[0]!.returnAt === msk('2026-11-19T14:00') && cycles[0]!.by?.bitrixId === '200', 'цикл 1 закрыт возвратом, ответил логист');
check(cycles[1]!.takeH === null && cycles[1]!.execH === 1 && cycles[1]!.answerH === 1 && cycles[1]!.cycleH === 2, 'цикл 2: от возврата, взятие не меряется', cycles[1]);
const skip = buildCycles([{ at: msk('2026-11-19T10:00'), kind: 'sent', actor: null }, { at: msk('2026-11-19T11:00'), kind: 'answered', actor: L }]);
check(skip[0]!.takeH === null && skip[0]!.execH === null && skip[0]!.answerH === 1, 'ответ из «Новых» — skip_take');
check(buildCycles([{ at: msk('2026-11-19T10:00'), kind: 'created', actor: null }]).length === 0, 'черновик — без циклов');

// ── 4. SLA и приоритет ──────────────────────────────────────────────────────────────────
console.log('SLA и приоритет');
const now = new Date(msk('2026-11-19T15:00'));
const slaOver = computeSla({ status: 'new', cycleStartedAt: msk('2026-11-19T10:00'), queueSlaHours: null }, DEFAULT_SETTINGS, now);
check(slaOver.state === 'overdue' && slaOver.leftHours === -2 && slaOver.deadline === msk('2026-11-19T13:00'), 'SLA 3 ч: в 15:00 просрочен на 2 ч', slaOver);
const slaHot = computeSla({ status: 'in_work', cycleStartedAt: msk('2026-11-19T12:30'), queueSlaHours: null }, DEFAULT_SETTINGS, now);
check(slaHot.state === 'hot' && slaHot.leftHours === 0.5, 'остаток 0.5 ч — горит');
check(computeSla({ status: 'new', cycleStartedAt: msk('2026-11-19T14:00'), queueSlaHours: 8 }, DEFAULT_SETTINGS, now).state === 'ok', 'SLA очереди 8 ч перекрывает настройку');
check(computeSla({ status: 'answered', cycleStartedAt: msk('2026-11-19T10:00'), queueSlaHours: null }, DEFAULT_SETTINGS, now).state === 'none', '«Ждёт контроля» — SLA не идёт');
const pOver = computePriority({ type: 'supply', status: 'new', amount: 50_000, deliveryDate: null, returnsCount: 0, lastEventAt: msk('2026-11-19T10:00'), sla: slaOver }, DEFAULT_SETTINGS, now);
const pCalm = computePriority({ type: 'supply', status: 'new', amount: 900_000, deliveryDate: null, returnsCount: 0, lastEventAt: msk('2026-11-19T14:50'), sla: { ...slaOver, state: 'ok', leftHours: 2.8 } }, DEFAULT_SETTINGS, now);
check(pOver.score > pCalm.score, 'просроченный выше крупного спокойного', [pOver.score, pCalm.score]);
check(pOver.hot && pOver.reasons[0]!.startsWith('SLA просрочен'), 'огонёк и первая причина — SLA', pOver.reasons);
const pMix = computePriority({ type: 'cheaper', status: 'in_work', amount: 2_000_000, deliveryDate: '2026-11-20', returnsCount: 2, lastEventAt: msk('2026-11-19T14:00'), sla: { ...slaOver, state: 'ok', leftHours: 2 } }, DEFAULT_SETTINGS, now);
check(pMix.reasons.length === 3 && pMix.factors.some(f => f.key === 'cheaper') && pMix.factors.some(f => f.key === 'delivery'), 'до 3 причин; учтены cheaper и поставка', pMix);
check(computePriority({ type: 'cheaper', status: 'accepted', amount: 1e7, deliveryDate: null, returnsCount: 5, lastEventAt: msk('2026-11-01T10:00'), sla: slaOver }, DEFAULT_SETTINGS, now).score === 0, 'принятый — 0');
const ms = mergeSettings({ slaHours: 5, weights: { cheaper: 99, junk: 1, perReturn: -3 } });
check(ms.slaHours === 5 && ms.weights.cheaper === 99 && ms.weights.perReturn === DEFAULT_SETTINGS.weights.perReturn, 'mergeSettings: переопределение и отсев мусора');

// ── 5. фильтры ──────────────────────────────────────────────────────────────────────────
console.log('фильтры');
const sp = new URLSearchParams('type=cheaper&queue=5&queue=7&pg=Газобетон, кирпич и прочие стеновые&mine=1&sla=hot&sumMin=1000&from=2026-11-01&q=штуцер&sort=sum&type=junk&queue=abc');
const f = parseFilters(sp);
check(f.types?.join() === 'cheaper' && f.queues?.join() === '5,7' && f.productGroups?.[0] === 'Газобетон, кирпич и прочие стеновые', 'списки повторными ключами, запятая в группе не режет', f);
check(f.mine === true && f.sla === 'hot' && f.sumMin === 1000 && f.createdFrom === '2026-11-01' && f.q === 'штуцер' && f.sort === 'sum', 'остальные поля');
check(JSON.stringify(parseFilters(filtersToSearchParams(f))) === JSON.stringify(f), 'сборка ↔ разбор туда-обратно');
const card = (p: Partial<RequestCard>): RequestCard => ({
  id: 1, type: 'supply', status: 'new', source: 'button', column: 'new', deal: { id: 555, title: 'Сделка', amount: 10_000, categoryId: 0, stageId: 'EXECUTING', url: '' },
  client: { ref: 'k1', name: 'ООО Ромашка' }, manager: { bitrixId: '100', name: 'М' }, logist: null,
  queue: { id: 5, groupId: 13, name: 'мск_Газобетон', region: 'МСК', dept: 'ОС' }, region: 'МСК', dept: 'ОС', productGroups: ['Газобетон, кирпич и прочие стеновые'],
  itemsPreview: 'Штуцер 10 шт', itemsCount: 1, ourTotal: 5000, competitorTotal: null, amount: 10_000, deliveryDate: null, address: null,
  cycle: 1, returnsCount: 0, offersCount: 0, createdAt: msk('2026-11-19T10:00'), sentAt: msk('2026-11-19T10:00'), takenAt: null, answeredAt: null,
  acceptedAt: null, cancelledAt: null, lastEventAt: msk('2026-11-19T10:00'), waitingHours: 1,
  sla: { hours: 3, deadline: null, leftHours: 0.5, state: 'hot' }, priority: { score: 10, reasons: [], factors: [], hot: false },
  dealOutcome: null, bxTaskId: 9001, bxSyncStatus: 'none', unread: 0, version: 0, ...p,
});
check(matchFilters(card({}), { types: ['supply'], queues: [5], sla: 'hot', q: 'штуцер' }, null), 'подходит: тип, очередь, горит, поиск по товару');
check(!matchFilters(card({}), { sla: 'overdue' }, null), 'горит ≠ просрочен');
check(matchFilters(card({}), { q: '555' }, null) && matchFilters(card({}), { q: '#1' }, null) && matchFilters(card({}), { q: '9001' }, null), 'поиск по № сделки, № запроса, № задачи');
check(matchFilters(card({}), { q: 'ромаш' }, null) && !matchFilters(card({}), { q: 'лютик' }, null), 'поиск по заказчику');
check(matchFilters(card({}), { mine: true }, '100') && !matchFilters(card({}), { mine: true }, '200'), '«Только мои»');
check(matchFilters(card({}), { untaken: true }, null) && !matchFilters(card({ logist: { bitrixId: '2', name: null }, status: 'in_work' }), { untaken: true }, null), '«Не взятые»');
check(!matchFilters(card({}), { sumMin: 20_000 }, null) && matchFilters(card({}), { sumMax: 10_000 }, null), 'сумма от–до');
check(matchFilters(card({}), { outcome: 'open' }, null) && !matchFilters(card({}), { outcome: 'sold' }, null), 'исход сделки');
check(!matchFilters(card({}), { createdFrom: '2026-11-20' }, null) && matchFilters(card({}), { createdTo: '2026-11-19' }, null), 'период создания (МСК)');
const sorted = [card({ id: 1, priority: { score: 5, reasons: [], factors: [], hot: false } }), card({ id: 2, priority: { score: 50, reasons: [], factors: [], hot: true } })].sort(sortComparator());
check(sorted[0]!.id === 2, 'по умолчанию — по огоньку');

// ── 6. варианты, отправка, очереди, плитки ──────────────────────────────────────────────
console.log('варианты, отправка, очереди, плитки');
const offer = parseOffer({ deliveryTrucks: 2, deliveryPrice: '5 000', lines: [
  { name: 'Штуцер', quantity: 10, price: 120.5 }, { name: 'Труба', quantity: 3, price: 1000, availability: 'none' }, { name: 'Аналог', quantity: 1, price: 99, availability: 'analog' },
] });
const t = offerTotals(offer);
check(t.lineSums.join() === '1205,3000,99' && t.goodsTotal === 1304 && t.deliveryTotal === 10_000 && t.total === 11_304, '«нет в наличии» не в сумме, доставка = машины × цена', t);
check(throws(() => parseOffer({ lines: [] })) && throws(() => parseOffer({ lines: [{ name: 'x', availability: 'maybe' }] })), 'пустой вариант и неизвестное наличие — ошибка');
check(throws(() => parseAction({ action: 'return', comment: '  ' })), 'возврат без комментария — ошибка');
check(throws(() => parseAction({ action: 'drop_table' })), 'неизвестное действие — ошибка');
check(parseAction({ action: 'transfer', queueId: '7', version: 3 }).action === 'transfer', 'transfer с версией');
check(sendProblems({ type: 'cheaper', queueId: 5, competitorTotal: null, items: [{ name: 'a', competitorPrice: null }] }).length === 1, 'cheaper без цены конкурента не отправить');
check(sendProblems({ type: 'cheaper', queueId: 5, competitorTotal: null, items: [{ name: 'a', competitorPrice: 10 }] }).length === 0, 'cheaper с ценой по позиции — можно');
check(sendProblems({ type: 'supply', queueId: null, competitorTotal: null, items: [] }).length === 2, 'без очереди и позиций — две проблемы');

const Qd = (p: Partial<LogistQueue>): LogistQueue => ({ id: 1, groupId: 1, name: '', region: null, dept: null, productGroups: [], slaHours: null, active: true, source: 'manual', sort: 0, members: [], ...p });
const queues = [
  Qd({ id: 1, name: 'мск_Газобетон, кирпич и прочие стеновые', region: 'МСК', productGroups: ['Газобетон, кирпич и прочие стеновые'] }),
  Qd({ id: 2, name: 'спб_Газобетон, кирпич и прочие стеновые', region: 'СПБ', productGroups: ['Газобетон, кирпич и прочие стеновые'] }),
  Qd({ id: 3, name: 'мск_Нерудка', region: 'МСК' }),
  Qd({ id: 4, name: 'мск_Металл', region: 'МСК', active: false, productGroups: ['Металлопрокат'] }),
];
check(pickDefaultQueue(queues, 'СПБ', ['Газобетон, кирпич и прочие стеновые'])?.id === 2, 'регион × группа');
check(pickDefaultQueue(queues, 'МСК', ['Нерудные материалы'])?.id === 3, 'группа по словам названия очереди');
check(pickDefaultQueue(queues, 'МСК', ['Металлопрокат']) === null, 'выключенная очередь не подбирается; один регион — не угадываем');
check(regionFromName('крд_Общестрой') === 'КРД' && regionFromName('Общестрой') === null, 'регион из названия проекта');
const seeds = queuesFromSupplyFacts({
  projects: { '13': { name: 'мск_Газобетон', region: 'МСК', dept: 'ОС' }, '99': { name: 'спб_Нерудка', region: null, dept: 'НЦ' }, '0': { name: 'x', region: null, dept: null } },
});
check(seeds.length === 2 && seeds.find(s => s.groupId === 99)?.region === 'СПБ', 'посев: проекты → очереди, регион из названия');
const mb = membersFromBitrix(
  [{ USER_ID: '2007', ROLE: 'K' }, { USER_ID: 5, ROLE: 'A' }, { USER_ID: '2007', ROLE: 'K' }, { USER_ID: '3000', ROLE: 'K' }, { USER_ID: '4000', ROLE: 'E' }, { USER_ID: 'bad' }],
  new Map([
    ['2007', { ID: '2007', NAME: 'Иван', LAST_NAME: 'Б', ACTIVE: true, WORK_POSITION: ' Логист ОС ' }],
    ['5', { ID: 5, NAME: 'Админ', ACTIVE: true }],
    ['3000', { ID: '3000', NAME: 'Уволен', ACTIVE: false }],
  ]),
);
check(mb.members.map(m => m.bitrixId).join() === '2007,5' && mb.inactive === 2, 'состав из проекта: без дублей, уволенные и не найденные — мимо', mb);
check(mb.members[0]!.name === 'Иван Б' && mb.members[0]!.workPosition === 'Логист ОС' && mb.members[1]!.bxRole === 'A', 'имя, должность, роль в проекте');

const tiles = computeTiles([
  { card: card({ id: 1, dealOutcome: 'sold' }), events: [
    { at: msk('2026-11-19T10:00'), kind: 'sent', actor: null }, { at: msk('2026-11-19T11:00'), kind: 'taken', actor: L },
    { at: msk('2026-11-19T13:00'), kind: 'answered', actor: L }, { at: msk('2026-11-19T14:00'), kind: 'returned', actor: null },
  ] },
  { card: card({ id: 2 }), events: [{ at: msk('2026-11-18T10:00'), kind: 'sent', actor: null }, { at: msk('2026-11-18T10:30'), kind: 'taken', actor: L }] },
], '2026-11-19', '2026-11-19');
check(tiles.newCount === 1 && tiles.reopenedCount === 1 && tiles.takeSpeedH === 1 && tiles.answerSpeedH === 3 && tiles.execSpeedH === 2, 'плитки за день', tiles);
check(tiles.salesSum === 10_000 && tiles.salesCount === 1, 'сумма продаж — по сделкам с исходом sold');

// ── S5: получатели уведомлений, «ждёт меня», разрез аналитики ───────────────────────────
console.log('S5');
const notify = mergeSettings({}).notify;
check(notify.positionPatterns.join() === 'логист,снабж', 'по умолчанию — «логист», «снабж»', notify);
check(mergeSettings({ notify: { positionPatterns: ['ЛОГИСТ', 7], includeBitrixIds: ['12', 'x'], excludeBitrixIds: 'bad' } }).notify.positionPatterns.join() === 'логист,7'
  && mergeSettings({ notify: { includeBitrixIds: ['12', 'x'] } }).notify.includeBitrixIds.join() === '12', 'настройки получателей чистятся');
const mem = (id: string, pos: string | null): QueueMember => ({ bitrixId: id, name: id, role: 'logist', source: 'bitrix', bxRole: 'K', workPosition: pos, syncedAt: null });
const members = [mem('1', 'Логист ОС'), mem('2', 'Генеральный директор'), mem('3', null), mem('4', 'Специалист по снабжению'), mem('5', 'Разработчик')];
check(queueRecipients(members, notify).join() === '1,4', 'рассылка — только логисты/снабженцы по должности');
const custom = { ...notify, includeBitrixIds: ['3'], excludeBitrixIds: ['4'] };
check(queueRecipients(members, custom, '1').join() === '3', 'ручное включение/исключение, автор действия — мимо');
check(recipientVerdict(members[1]!, notify) === 'other_position' && recipientVerdict(members[2]!, notify) === 'no_position', 'почему не получает');
check(queueRecipients(members, { ...notify, positionPatterns: [] }).length === 5, 'пустой список слов — всем');
check(attentionOf({ status: 'answered', unread: 0 }) === 'answered' && attentionOf({ status: 'in_work', unread: 2 }) === 'chat'
  && attentionOf({ status: 'draft', unread: 0 }) === 'draft' && attentionOf({ status: 'new', unread: 0 }) === null
  && attentionOf({ status: 'cancelled', unread: 3 }) === null, '«ждёт меня»: ответ, чат, черновик');
const L2 = { bitrixId: '2008', name: 'Пётр' };
const an = buildAnalytics([
  { card: card({ id: 1, logist: L }), events: [{ at: msk('2026-11-19T10:00'), kind: 'sent', actor: null }, { at: msk('2026-11-19T11:00'), kind: 'taken', actor: L }] },
  { card: card({ id: 2, logist: L2 }), events: [{ at: msk('2026-11-19T12:00'), kind: 'sent', actor: null }] },
  { card: card({ id: 3, region: 'СПБ', queue: null, sla: { hours: 3, deadline: null, leftHours: -1, state: 'overdue' } }), events: [{ at: msk('2026-11-19T12:00'), kind: 'sent', actor: null }] },
], '2026-11-19', '2026-11-19');
check(an.total.tiles.newCount === 3 && an.total.openNow === 3 && an.total.overdueNow === 1, 'итог разреза');
check(an.rows.find(r => r.key === 'МСК')!.tiles.newCount === 2 && an.rows.find(r => r.key === 'МСК|ОС|5')!.tiles.newCount === 2, 'регион и очередь');
check(an.rows.filter(r => r.level === 'logist' && r.parentKey === 'МСК|ОС|5').length === 2 && an.rows.find(r => r.key === 'МСК|ОС|5|200')!.tiles.takeSpeedH === 1, 'логисты очереди');
check(an.rows.find(r => r.key === 'СПБ|ОС|0')?.label === 'Без очереди' && an.rows.find(r => r.key === 'СПБ|ОС|0|0')?.label === 'Не взят', 'без очереди / не взят');

console.log(`\n${passed} ok, ${failures} fail`);
if (failures) process.exit(1);

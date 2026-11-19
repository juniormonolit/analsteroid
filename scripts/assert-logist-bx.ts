/**
 * Assert-скрипт: канбан запросов логистам, S4 (запись в Битрикс) — чистые функции, БЕЗ сети и БД.
 *  1. Выключатели (config.ts): по умолчанию всё выключено, тестовые списки проектов/сделок.
 *  2. Текст дубль-задачи (format.ts): заголовок «Товар | кол-во | адрес», описание как у бизнес-процесса.
 *  3. Комментарии: вариант логиста, сообщения чата, экранирование BB-кодов.
 *  4. «Принять вариант» → строки товаров сделки (planDealRows): замена/сохранение/добавление, доставка.
 *  5. Действие → шаги синка (ops.ts).
 *  6. Разбор тела accept с подтверждением предпросмотра.
 *
 * Запуск: npm run test:logist-bx
 */
import { bxFlags, dealRowsBlockedReason, tasksBlockedReason } from '../features/logist-kanban/engine/bitrix/config.ts';
import {
  bbSafe, messageComment, money, num, offerComment, planDealRows, rowsHash, ruDate, taskDescription, taskTitle, type BxProductRow,
} from '../features/logist-kanban/engine/bitrix/format.ts';
import { opsForChange } from '../features/logist-kanban/engine/bitrix/ops.ts';
import { parseAction } from '../features/logist-kanban/engine/requests/validate.ts';
import type { Offer, OfferLine, RequestDetails, RequestEvent, RequestItem } from '../features/logist-kanban/engine/requests/contract.ts';
import type { LogistHookCtx } from '../features/logist-kanban/engine/requests/hooks.ts';

let failures = 0, passed = 0;
function check(cond: boolean, label: string, extra?: unknown) {
  if (cond) { passed++; console.log(`  ok   ${label}`); } else { failures++; console.error(`  FAIL ${label}`, extra ?? ''); }
}

// ── фикстуры ────────────────────────────────────────────────────────────────────────────
const item = (p: Partial<RequestItem> & { id: number; name: string }): RequestItem => ({
  pos: p.id, kind: 'deal_row', bxRowId: null, bxProductId: null, quantity: null, measure: null, ourPrice: null, ourSum: null,
  productGroup: null, competitorPrice: null, comment: null, addedInCycle: 0, files: [], ...p,
});
const line = (p: Partial<OfferLine> & { id: number; name: string }): OfferLine => ({
  itemId: null, pos: p.id, availability: 'ok', bxProductId: null, quantity: null, measure: null, price: null, sum: null, comment: null, ...p,
});
const offer = (p: Partial<Offer> & { lines: OfferLine[] }): Offer => ({
  id: 70, n: 2, cycle: 1, author: { bitrixId: '2129', name: 'Лидия С.' }, supplier: 'ТН-Склад', paymentForm: 'Безнал',
  leadTime: '2 дня', readyDate: '2026-11-21', deliveryTrucks: null, deliveryPrice: null,
  goodsTotal: 0, deliveryTotal: 0, total: 0, comment: null, status: 'active', createdAt: '2026-11-19T10:00:00.000Z', files: [], ...p,
});
const ev = (id: number, kind: RequestEvent['kind'], fromStatus: RequestEvent['fromStatus'], data: Record<string, unknown> = {}): RequestEvent =>
  ({ id, at: '2026-11-19T10:00:00.000Z', kind, cycle: 1, fromStatus, toStatus: null, queueId: 5, actor: null, data });

const items: RequestItem[] = [
  item({ id: 1, name: 'Утеплитель Роквул Лайт Баттс 100 мм', bxRowId: 501, bxProductId: 9001, quantity: 50, measure: 'упак', ourPrice: 995, ourSum: 49750, productGroup: 'Утеплитель Минеральная вата и стекловата' }),
  item({ id: 2, name: 'Штуцер [/TABLE] латунный', kind: 'free', quantity: 10, measure: 'шт', competitorPrice: 120 }),
  item({ id: 3, name: 'Доставка без разгрузки', quantity: 1, measure: 'шт', ourPrice: 18500, ourSum: 18500 }),
];
const base = {
  id: 42, type: 'cheaper', status: 'new', source: 'button', column: 'new',
  deal: { id: 280744, title: 'Сделка', amount: 257365, categoryId: 0, stageId: 'X', url: '' },
  client: { ref: 'k1', name: 'ООО Ромашка' },
  manager: { bitrixId: '1952', name: 'Мария Смирнова' }, logist: null,
  queue: { id: 5, groupId: 5, name: 'Теплоизоляция', region: 'СПБ', dept: 'ОС' },
  region: 'СПБ', dept: 'ОС', productGroups: ['Утеплитель Минеральная вата и стекловата'],
  itemsPreview: '', itemsCount: 3, ourTotal: 0, competitorTotal: 242000, amount: 0,
  deliveryDate: '2026-11-18', address: '188640, Ленинградская обл, Всеволожский р-н, г Всеволожск, ул. Длинная очень, д. 1',
  cycle: 1, returnsCount: 0, offersCount: 0, createdAt: '', sentAt: '', takenAt: null, answeredAt: null, acceptedAt: null, cancelledAt: null,
  lastEventAt: '', waitingHours: 0,
  sla: { hours: 3, deadline: '2026-11-19T12:50:00.000Z', leftHours: 3, state: 'ok' },
  priority: { score: 0, reasons: [], factors: [], hot: false }, dealOutcome: null, bxTaskId: null, bxSyncStatus: 'none', unread: 0, version: 1,
  purpose: null, paymentForm: 'Нал', comment: 'общая цена с доставкой 242 тыс, что-то можно сделать?', competitorName: 'Петрович',
  acceptedOfferId: null, cancelReason: null, items, offers: [], messages: [], events: [], watchers: [], files: [], cycles: [],
  dealRowsStatus: 'none', dealRowsError: null, bxSyncError: null,
  can: {} as RequestDetails['can'], roles: {} as RequestDetails['roles'],
} as unknown as RequestDetails;
const ctx = (action: LogistHookCtx['action'], patch: Partial<RequestDetails> = {}, extra: Partial<LogistHookCtx> = {}): LogistHookCtx =>
  ({ action, request: { ...base, ...patch }, actor: { bitrixId: '1952', login: 'smirnova', name: 'Мария Смирнова' }, eventIds: [], ...extra });
const APP = 'https://monolitika.mlt-it.ru', PORTAL = 'https://td.monolit-crm.ru';

// ── 1. выключатели ──────────────────────────────────────────────────────────────────────
console.log('1. выключатели');
{
  const off = bxFlags({});
  check(!off.tasks && !off.dealRows && !off.onlyGroups && !off.onlyDeals, 'без env всё выключено');
  check(tasksBlockedReason(off, 5, 1) !== null, 'задачи: выключено → причина');
  const t = bxFlags({ LOGIST_BX_WRITE: '1', LOGIST_BX_ONLY_GROUPS: '777, x, 778', LOGIST_BX_DEAL_ROWS: '1', LOGIST_BX_ONLY_DEALS: '1001' });
  check(t.tasks && t.dealRows && t.onlyGroups?.size === 2, 'флаги и список проектов разобраны (мусор отброшен)');
  check(tasksBlockedReason(t, 5, 1001)?.includes('LOGIST_BX_ONLY_GROUPS') === true, 'боевой проект при тестовом списке — не пишем');
  check(tasksBlockedReason(t, 777, 1001) === null, 'тестовый проект + тестовая сделка — пишем');
  check(tasksBlockedReason(t, 777, 280744) !== null, 'тестовый проект, но боевая сделка — не пишем');
  check(dealRowsBlockedReason(t, 280744) !== null && dealRowsBlockedReason(t, 1001) === null, 'товары: только тестовая сделка');
  check(dealRowsBlockedReason(bxFlags({ LOGIST_BX_WRITE: '1' }), 1001) !== null, 'LOGIST_BX_WRITE не включает запись товаров');
}

// ── 2. текст задачи ─────────────────────────────────────────────────────────────────────
console.log('2. текст дубль-задачи');
{
  check(money(49750) === '49 750.00' && money(1234567.5) === '1 234 567.50' && money(0) === '0.00', 'деньги как у бизнес-процесса', money(49750));
  check(num(995) === '995' && num(12.5) === '12.5', 'цена без лишних нулей');
  check(ruDate('2026-11-18') === '18.11.2026' && ruDate(null) === null, 'дата ДД.ММ.ГГГГ');
  const title = taskTitle(base);
  check(title.startsWith('Утеплитель Минеральная вата и стекловата | 50 упак | 188640, Ленинградская'), 'заголовок: группа | кол-во | адрес', title);
  check(title.endsWith('...') && title.split(' | ')[2]!.length === 53, 'адрес обрезан до 50 + «...»', title);
  check(taskTitle({ ...base, address: null }) === 'Утеплитель Минеральная вата и стекловата | 50 упак', 'без адреса — две части');
  const d = taskDescription(base, { app: APP, portal: PORTAL });
  check(d.startsWith('[B]Менеджер:[/B] [URL=https://td.monolit-crm.ru/company/personal/user/1952/]Мария Смирнова[/URL]'), 'менеджер ссылкой');
  check(d.includes('[B]Дата поставки материала:[/B] 18.11.2026') && d.includes('[B]Для каких целей:[/B] -'), 'шапка, пустое — «-»');
  check(d.includes('[TD][B]Цена конкурента[/B][/TD]') && d.includes('[TD]50 упак[/TD][TD]995 руб[/TD][TD]49 750.00 руб[/TD][TD]не указана[/TD]'), 'таблица товаров');
  check(d.includes('[B]Доставка и услуги:[/B]') && d.includes('[TD]Доставка без разгрузки[/TD][TD]1 шт[/TD][TD]18500 руб[/TD]'), 'доставка — отдельной таблицей');
  check(d.includes('[TD]120 руб[/TD]'), 'цена конкурента по позиции');
  check(!d.includes('Штуцер [/TABLE]') && d.includes('Штуцер [ /TABLE] латунный'), 'BB-коды из текста менеджера не ломают таблицу');
  check(d.includes('[B]Конкурент:[/B] Петрович') && d.includes('[B]Сумма у конкурента:[/B] 242 000.00 руб'), 'cheaper: конкурент');
  check(d.includes('[B]Общая сумма по всем товарам:[/B] 49 750.00 руб') && d.includes('[B]Общая сумма по сделке:[/B] 257 365.00 руб'), 'итоги (товары без доставки)');
  check(d.includes(`[URL=${APP}/logist-kanban?request=42]№42[/URL]`), 'ссылка на запрос в Монолитике (маркер для поиска)');
}

// ── 3. комментарии ──────────────────────────────────────────────────────────────────────
console.log('3. комментарии');
{
  const o = offer({
    deliveryTrucks: 2, deliveryPrice: 5000, deliveryTotal: 10000, goodsTotal: 45000, total: 55000, comment: 'цена до пятницы',
    lines: [line({ id: 1, itemId: 1, name: 'Утеплитель Роквул', quantity: 50, measure: 'упак', price: 900, sum: 45000 }),
      line({ id: 2, itemId: 2, name: 'Штуцер', availability: 'none', quantity: 10 })],
  });
  const c = offerComment(o);
  check(c.startsWith('[B]Вариант №2[/B]\nПоставщик: ТН-Склад · Оплата: Безнал · Срок: 2 дня · Готовность: 21.11.2026'), 'шапка варианта', c);
  check(c.includes('• Утеплитель Роквул: 50 упак × 900 руб = 45 000.00 руб') && c.includes('Штуцер: 10 шт × цена — — [B]нет в наличии[/B]'), 'строки');
  check(c.includes('Доставка: 2 маш. × 5 000.00 = 10 000.00 руб') && c.includes('[B]Итого: 55 000.00 руб[/B]'), 'доставка и итог');
  check(!c.includes('[TABLE]'), 'без таблиц (в чате задачи не рисуются)');
  check(messageComment('есть ли [B]аналог?', 2, null) === 'есть ли [ B]аналог?\n[I]Файлы (2) — в карточке запроса в Монолитике.[/I]', 'сообщение: BB гасим, файлы — строкой');
  check(bbSafe('[url=http://x]y[/url]') === '[ url=http://x]y[ /url]', 'bbSafe гасит ссылки');
}

// ── 4. строки товаров сделки ────────────────────────────────────────────────────────────
console.log('4. «Принять вариант» → товары сделки');
{
  const before: BxProductRow[] = [
    { ID: '501', PRODUCT_ID: '9001', PRODUCT_NAME: 'Утеплитель Роквул Лайт Баттс 100 мм', PRICE: '995', QUANTITY: '50', MEASURE_CODE: '778', MEASURE_NAME: 'упак', TAX_RATE: '20', TAX_INCLUDED: 'Y' },
    { ID: '502', PRODUCT_ID: '9002', PRODUCT_NAME: 'Клей', PRICE: '450', QUANTITY: '4', DISCOUNT_TYPE_ID: '2', DISCOUNT_RATE: '10', DISCOUNT_SUM: '50', MEASURE_CODE: '796', MEASURE_NAME: 'шт' },
    { ID: '503', PRODUCT_ID: '0', PRODUCT_NAME: 'Доставка без разгрузки', PRICE: '18500', QUANTITY: '1' },
  ];
  const o = offer({
    deliveryTrucks: 2, deliveryPrice: 5000, deliveryTotal: 10000,
    lines: [
      line({ id: 1, itemId: 1, name: 'Утеплитель Роквул Лайт Баттс 100 мм', quantity: 50, measure: 'упак', price: 900 }),
      line({ id: 2, itemId: 2, name: 'Штуцер латунный ½', availability: 'analog', quantity: 10, measure: 'шт', price: 110 }),
      line({ id: 3, itemId: null, name: 'Фитинг новый', quantity: null, price: null }),
    ],
  });
  const p = planDealRows(before, items, o);
  check(p.rows.length === 5, 'строк: 3 сделки + 2 добавлены', p.rows);
  const r0 = p.rows[0]!;
  check(r0.PRODUCT_ID === 9001 && r0.PRICE === 900 && r0.QUANTITY === 50 && r0.MEASURE_CODE === 778 && r0.TAX_RATE === 20 && r0.TAX_INCLUDED === 'Y',
    'позиция с ответом: замена на месте, товар каталога и НДС сохранены', r0);
  check(p.changes[0]!.kind === 'replace' && p.changes[0]!.before!.price === 995 && p.changes[0]!.after!.price === 900, 'было/станет по замене');
  const r1 = p.rows[1]!;
  check(Number(r1.PRODUCT_ID) === 9002 && r1.DISCOUNT_RATE === '10' && r1.PRICE === '450' && p.changes[1]!.kind === 'keep', 'нетронутая строка — как была (со скидкой)', r1);
  const r2 = p.rows[2]!;
  check(r2.PRODUCT_NAME === 'Доставка без разгрузки' && r2.QUANTITY === 2 && r2.PRICE === 5000 && !('PRODUCT_ID' in r2), 'доставка варианта заменила строку доставки', r2);
  const r3 = p.rows[3]!;
  check(r3.PRODUCT_NAME === 'Штуцер латунный ½' && !('PRODUCT_ID' in r3) && r3.MEASURE_CODE === 796 && p.changes[3]!.kind === 'add', 'свободная позиция — строкой без PRODUCT_ID', r3);
  const r4 = p.rows[4]!;
  check(r4.QUANTITY === 1 && r4.PRICE === 0 && p.warnings.some(w => w.includes('нет количества')) && p.warnings.some(w => w.includes('нет цены')), 'новая позиция без кол-ва/цены — 1 × 0 с предупреждением');

  const none = planDealRows(before, items, offer({ lines: [line({ id: 1, itemId: 1, name: 'x', availability: 'none' })] }));
  check(none.rows.length === 3 && none.changes.every(c => c.kind === 'keep'), '«нет в наличии» — сделка без изменений');
  check(none.warnings.some(w => w.includes('строка сделки останется как была')) && none.warnings.some(w => w.includes('нет ни одной позиции')), 'и предупреждения об этом');

  const noDel = planDealRows(before.slice(0, 2), items, o);
  check(noDel.rows.at(-1)!.PRODUCT_NAME === 'Доставка' && noDel.changes.at(-1)!.kind === 'add', 'нет строки доставки в сделке — добавляется в конец');

  const two = planDealRows(before, items, offer({ lines: [
    line({ id: 1, itemId: 1, name: 'Роквул 100', quantity: 30, price: 900 }), line({ id: 2, itemId: 1, name: 'Технониколь 100 (аналог)', availability: 'analog', quantity: 20, price: 850 })] }));
  check(two.rows.length === 4 && two.changes[0]!.kind === 'replace' && two.changes[1]!.kind === 'add' && two.rows[1]!.PRODUCT_NAME === 'Технониколь 100 (аналог)',
    'две строки варианта на одну позицию — обе на её месте');
  check(two.rows[1]!.PRODUCT_ID === undefined, 'аналог без товара каталога');

  check(rowsHash(before) === rowsHash(before.map(r => ({ ...r }))) && rowsHash(before) !== rowsHash([{ ...before[0]!, QUANTITY: '51' }, ...before.slice(1)]),
    'отпечаток стабилен и ловит изменение');
}

// ── 5. действие → шаги синка ────────────────────────────────────────────────────────────
console.log('5. шаги синка');
{
  const send = opsForChange(ctx('send'), APP, PORTAL);
  const ct = send[0];
  check(send.length === 1 && ct?.op === 'create_task' && ct.groupId === 5 && ct.managerId === '1952' && ct.dealId === 280744
    && ct.deadline === '2026-11-19T12:50:00.000Z' && ct.marker === `${APP}/logist-kanban?request=42`, 'send → задача в проект очереди', ct);
  check(opsForChange(ctx('send', { queue: null }), APP, PORTAL).length === 0, 'send без очереди — ничего');
  check(opsForChange(ctx('create'), APP, PORTAL).length === 0 && opsForChange(ctx('update_draft'), APP, PORTAL).length === 0, 'черновик в Битрикс не пишется');
  const logist = { bitrixId: '2129', name: 'Лидия Скоробогатова' };
  const take = opsForChange(ctx('take', { logist }), APP, PORTAL);
  check(take.length === 1 && take[0]!.op === 'assign' && take[0]!.responsibleId === '2129' && take[0]!.start === true, 'take → исполнитель + «Выполняется»');
  const o = offer({ id: 71, n: 1, lines: [line({ id: 1, itemId: 1, name: 'x', quantity: 1, price: 1, sum: 1 })], total: 1, goodsTotal: 1 });
  const fromNew = opsForChange(ctx('answer', { logist, offers: [o], events: [ev(1, 'answered', 'new', { offerId: 71 })] }), APP, PORTAL);
  check(fromNew.map(x => x.op).join(',') === 'assign,comment,complete', 'ответ из «Новых»: исполнитель, комментарий, «Ждёт контроля»', fromNew);
  check(fromNew[1]!.op === 'comment' && fromNew[1]!.as === '2129', 'вариант — комментарием от логиста');
  const more = opsForChange(ctx('answer', { logist, offers: [o], events: [ev(1, 'answered', 'answered', { offerId: 71 })] }), APP, PORTAL);
  check(more.map(x => x.op).join(',') === 'comment', 'ещё вариант в «Ждёт контроля» — только комментарий');
  const ret = opsForChange(ctx('return', { events: [ev(2, 'returned', 'answered', { comment: 'дороговато' })] }), APP, PORTAL);
  check(ret.map(x => x.op).join(',') === 'comment,reopen' && ret[0]!.op === 'comment' && ret[0]!.comment.includes('дороговато') && ret[0]!.as === '1952', 'возврат: комментарий менеджера + возобновить');
  const acc = opsForChange(ctx('accept', { offers: [{ ...o, total: 55000 }], acceptedOfferId: 71 }), APP, PORTAL);
  check(acc.map(x => x.op).join(',') === 'comment,close' && acc[0]!.op === 'comment' && acc[0]!.comment.includes('№1 на 55 000.00 руб'), 'принят: комментарий + завершить', acc);
  const cancel = opsForChange(ctx('cancel', { cancelReason: 'клиент передумал' }), APP, PORTAL);
  check(cancel.map(x => x.op).join(',') === 'comment,close' && cancel[0]!.op === 'comment' && cancel[0]!.comment.includes('клиент передумал'), 'отмена: причина + закрыть');
  const msg = { id: 9, author: { bitrixId: '2129', name: 'Лидия' }, authorLogin: 'l', body: 'а объём точно 50?', createdAt: '', editedAt: null, deleted: false, files: [] };
  const m = opsForChange(ctx('message', { messages: [msg] }, { messageId: 9 }), APP, PORTAL);
  check(m.length === 1 && m[0]!.op === 'comment' && m[0]!.as === '2129' && m[0]!.messageId === 9, 'сообщение чата → комментарий от автора', m);
  check(opsForChange(ctx('message', { messages: [{ ...msg, deleted: true }] }, { messageId: 9 }), APP, PORTAL).length === 0, 'удалённое сообщение не шлём');
  const tr = opsForChange(ctx('transfer', { queue: { id: 6, groupId: 6, name: 'Кирпич', region: null, dept: null }, events: [ev(3, 'transferred', 'in_work', {})] }), APP, PORTAL);
  check(tr[1]?.op === 'assign' && tr[1].groupId === 6 && tr[1].responsibleId === '1952' && tr[1].pause === true, 'перенос в другую очередь — проект задачи и исполнитель = менеджер');
}

// ── 6. тело accept ──────────────────────────────────────────────────────────────────────
console.log('6. accept с подтверждением');
{
  const a = parseAction({ action: 'accept', offerId: 7, dealRows: { confirm: true, hash: 'abc:3' } });
  check(a.action === 'accept' && a.dealRows?.hash === 'abc:3', 'dealRows разобран');
  const b = parseAction({ action: 'accept', offerId: 7, dealRows: { confirm: 'yes', hash: 'abc' } });
  check(b.action === 'accept' && b.dealRows === undefined, 'confirm не true — без подтверждения');
  const c = parseAction({ action: 'accept', offerId: 7 });
  check(c.action === 'accept' && c.dealRows === undefined, 'без поля — без подтверждения (товары не трогаем)');
}

console.log(`\n${passed} ok, ${failures} fail`);
if (failures) process.exit(1);

/**
 * Интеграционный прогон движка канбана запросов логистам (S1) на ВРЕМЕННОЙ локальной БД: полный путь
 * черновик → отправка → взятие → варианты → чат → возврат → приёмка, передача, отмена, доска, плитки, настройки.
 * ОЧИЩАЕТ таблицы logist_* — запускать только на одноразовом Postgres, не на проде/стейдже (есть защита ниже).
 *
 * Подготовка (один раз):
 *   initdb -D /tmp/lr-pg -U postgres -A trust -E UTF8 && pg_ctl -D /tmp/lr-pg -o "-p 55432 -k /tmp" start
 *   psql -h /tmp -p 55432 -U postgres -c "CREATE ROLE app LOGIN; CREATE TABLE repeat_kanban_events(id int); GRANT INSERT, SELECT ON repeat_kanban_events TO app"
 *   psql -h /tmp -p 55432 -U postgres -f migrations/267_logist_requests.sql -f migrations/268_logist_queue_members_bitrix.sql
 * Запуск (очистка — суперюзером, сам прогон — ролью приложения, чтобы проверить гранты):
 *   psql -h /tmp -p 55432 -U postgres -c "ALTER TABLE logist_request_events DISABLE TRIGGER USER; TRUNCATE logist_queues, logist_requests, logist_request_events RESTART IDENTITY CASCADE; ALTER TABLE logist_request_events ENABLE TRIGGER USER"
 *   SYS_PG_HOST=/tmp SYS_PG_PORT=55432 SYS_PG_USER=app SYS_PG_PASSWORD=x YC_SYSTEM_DB=postgres \
 *     node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs scripts/smoke-logist-requests.ts
 */
if (process.env.SYS_PG_HOST !== '/tmp' && process.env.SYS_PG_HOST !== '127.0.0.1') {
  console.error('Только на локальной одноразовой БД: SYS_PG_HOST=/tmp или 127.0.0.1'); process.exit(2);
}
import { applyAction, createDraft, loadBoard, loadDetails, postMessage, listMessages, loadDealRequests, saveSettings } from '../features/logist-kanban/engine/requests/repo.ts';
import { upsertQueue, loadQueues } from '../features/logist-kanban/engine/requests/queues.ts';
import { systemDb } from '../lib/db/clients.ts';
import type { LogistActor } from '../features/logist-kanban/engine/requests/actor.ts';

const mk = (p: Partial<LogistActor>): LogistActor => {
  const a = { bitrixId: null, login: 'x', canManage: false, queueIds: new Set<number>(), leadQueueIds: new Set<number>(), zone: new Set<string>(), name: 'X', ...p } as LogistActor;
  a.info = { bitrixId: a.bitrixId, name: a.name, canManage: a.canManage, isLogist: a.queueIds.size > 0, isRop: false, queueIds: [...a.queueIds] };
  return a;
};
const ok = (c: boolean, l: string, x?: unknown) => { console.log(c ? '  ok  ' : '  FAIL', l, c ? '' : JSON.stringify(x)); if (!c) process.exitCode = 1; };
const expectErr = async (p: Promise<unknown>, code: string, l: string) => { try { await p; ok(false, l, 'no error'); } catch (e) { ok((e as { code?: string }).code === code, l, (e as Error).message); } };

const admin = mk({ bitrixId: '1', login: 'adm', canManage: true, name: 'Админ' });
const q1 = await upsertQueue({ groupId: 13, name: 'мск_Газобетон, кирпич', region: 'МСК', dept: 'ОС', productGroups: ['Газобетон'] }, 'adm');
await systemDb().query(`INSERT INTO logist_queue_members (queue_id, user_bitrix_id, user_name, source) VALUES ($1, '200', 'Логист', 'bitrix')`, [q1.id]);
const q2 = await upsertQueue({ groupId: 14, name: 'мск_Нерудка', region: 'МСК', dept: 'НЦ' }, 'adm');
ok((await loadQueues()).length === 2 && (await loadQueues()).find(q => q.id === q1.id)!.members[0]!.source === 'bitrix', 'очереди и участники');
const mgr = mk({ bitrixId: '100', login: 'mgr', name: 'Менеджер' });
const lg = mk({ bitrixId: '200', login: 'lg', name: 'Логист', queueIds: new Set([q1.id]) });
const lg2 = mk({ bitrixId: '201', login: 'lg2', name: 'Логист2', queueIds: new Set([q2.id]) });
const rop = mk({ bitrixId: '300', login: 'rop', name: 'РОП', zone: new Set(['100']) });

const { request: d, created } = await createDraft(mgr, {
  type: 'cheaper', source: 'robot', manager: { bitrixId: '100', name: 'Менеджер' }, managerRegion: 'МСК', createdByLogin: null,
  deal: { id: 777, title: 'Сделка 777', amount: 250000, categoryId: 0, stageId: 'UC_PU4HM2', clientRef: 'k5', clientName: 'ООО Ромашка', address: 'Москва' },
  header: {}, items: [{ kind: 'deal_row', name: 'Газоблок D500', quantity: 10, measure: 'м3', ourPrice: 6000, productGroup: 'Газобетон', bxRowId: 11, bxProductId: 501 }],
  productGroups: ['Газобетон'],
});
ok(created && d.status === 'draft' && d.queue?.id === q1.id && d.items.length === 1 && d.ourTotal === 60000, 'черновик с авто-очередью', d);
const again = await createDraft(mgr, { type: 'cheaper', source: 'robot', manager: { bitrixId: '100', name: 'М' }, managerRegion: 'МСК', createdByLogin: null, deal: { id: 777, title: null, amount: null, categoryId: null, stageId: null, clientRef: null, clientName: null, address: null }, header: {}, items: [], productGroups: [] });
ok(!again.created && again.request.id === d.id, 'робот повторно — тот же черновик');
await expectErr(loadDetails(lg, d.id), 'forbidden', 'логист не видит черновик');
await expectErr(applyAction(mgr, d.id, { action: 'send' }), 'invalid', 'cheaper без цены конкурента не уходит');
const upd = await applyAction(mgr, d.id, { action: 'update_draft', version: d.version, header: { competitorName: 'Леруа', deliveryDate: '2026-11-21' }, items: [{ id: d.items[0]!.id, kind: 'deal_row', name: 'Газоблок D500', quantity: 10, measure: 'м3', ourPrice: 6000, competitorPrice: 5500, productGroup: 'Газобетон' }, { name: 'Клей', quantity: 5, measure: 'меш' }] });
ok(upd.items.length === 2 && upd.items[0]!.competitorPrice === 5500 && upd.deliveryDate === '2026-11-21' && upd.version === d.version + 1, 'правка черновика', upd.items);
await expectErr(applyAction(mgr, d.id, { action: 'send', version: d.version }), 'conflict', 'устаревшая версия — 409');
const sent = await applyAction(mgr, d.id, { action: 'send' });
ok(sent.status === 'new' && sent.cycle === 1 && sent.sla.state !== 'none' && sent.sentAt !== null, 'отправлен', sent.sla);
await expectErr(applyAction(lg2, d.id, { action: 'take' }), 'forbidden', 'чужая очередь — не взять');
const taken = await applyAction(lg, d.id, { action: 'take' });
ok(taken.status === 'in_work' && taken.logist?.bitrixId === '200', 'взят');
const ans = await applyAction(lg, d.id, { action: 'answer', offer: { supplier: 'База 1', deliveryTrucks: 1, deliveryPrice: 7000, lines: [{ itemId: taken.items[0]!.id, name: 'Газоблок D500', quantity: 10, price: 5400 }, { itemId: taken.items[1]!.id, name: 'Клей', quantity: 5, price: 0, availability: 'none' }] } });
ok(ans.status === 'answered' && ans.offers.length === 1 && ans.offers[0]!.total === 61000 && ans.offers[0]!.lines[0]!.sum === 54000, 'ответ вариантом', ans.offers[0]);
const ans2 = await applyAction(lg, d.id, { action: 'answer', offer: { supplier: 'База 2', lines: [{ name: 'Газоблок аналог', quantity: 10, price: 5300, availability: 'analog' }] } });
ok(ans2.offers.length === 2 && ans2.offers[1]!.n === 2, 'ещё вариант');
const msg = await postMessage(lg, d.id, 'Есть ещё на складе в Химках', []);
ok(msg.message.body.startsWith('Есть'), 'сообщение');
const mgrView = await loadDetails(mgr, d.id, { markRead: false });
ok(mgrView.unread === 1 && mgrView.can.accept && mgrView.can.return && !mgrView.can.take, 'менеджер: непрочитанное и кнопки', mgrView.can);
const ret = await applyAction(mgr, d.id, { action: 'return', comment: 'Дорого, ищите ещё' });
ok(ret.status === 'in_work' && ret.cycle === 2 && ret.returnsCount === 1 && ret.cycles.length === 2, 'возврат → новый цикл', ret.cycles);
await applyAction(lg, d.id, { action: 'answer', offer: { supplier: 'База 3', lines: [{ name: 'Газоблок D500', quantity: 10, price: 5000 }] } });
const accepted = await applyAction(mgr, d.id, { action: 'accept', offerId: (await loadDetails(mgr, d.id)).offers[2]!.id });
ok(accepted.status === 'accepted' && accepted.dealRows?.status === 'skipped' && accepted.dealRowsStatus === 'skipped', 'принят, хук записи — заглушка', accepted.dealRows);
await expectErr(applyAction(rop, d.id, { action: 'cancel' }), 'transition', 'принятый не отменить');
const ev = accepted.events.map(e => e.kind).join(',');
ok(ev === 'created,draft_updated,sent,taken,answered,answered,message,returned,answered,accepted,deal_rows', 'журнал', ev);
try { await systemDb().query('DELETE FROM logist_request_events'); ok(false, 'журнал не удалить'); } catch { ok(true, 'журнал не удалить (нет прав у роли приложения)'); }

// второй запрос → передача, отмена РОПом
const { request: d2 } = await createDraft(mgr, { type: 'supply', source: 'button', manager: { bitrixId: '100', name: 'Менеджер' }, managerRegion: 'МСК', createdByLogin: 'mgr', deal: null, header: { queueId: q1.id }, items: [{ name: 'Штуцер', quantity: 10, measure: 'шт' }], productGroups: [] });
await applyAction(mgr, d2.id, { action: 'send' });
const tr = await applyAction(lg, d2.id, { action: 'transfer', queueId: q2.id, comment: 'не наш товар' });
ok(tr.queue?.id === q2.id && tr.status === 'new', 'передан в другую очередь');
await expectErr(loadDetails(lg, d2.id), 'forbidden', 'после передачи прежний логист не видит');
ok((await loadDetails(lg2, d2.id)).can.take, 'новый логист может взять');
const cn = await applyAction(rop, d2.id, { action: 'cancel', reason: 'клиент передумал' });
ok(cn.status === 'cancelled', 'РОП отменил');

// доска
const b = await loadBoard(lg, { view: 'board', filters: {} });
ok(b.columns.find(c => c.key === 'accepted')!.total === 1 && b.columns.find(c => c.key === 'new')!.total === 0, 'доска логиста', b.columns.map(c => [c.key, c.total]));
const bm = await loadBoard(mgr, { view: 'board', filters: { types: ['cheaper'] } });
ok(bm.columns.reduce((s, c) => s + c.total, 0) === 1 && bm.tiles.newCount === 1 && bm.tiles.reopenedCount === 1, 'доска менеджера + плитки', bm.tiles);
// без черновика: сразу в «Новые»
const direct = await createDraft(mgr, { type: 'supply', source: 'button', manager: { bitrixId: '100', name: 'М' }, managerRegion: 'МСК', createdByLogin: 'mgr', deal: null, header: { queueId: q1.id }, items: [{ name: 'Болт', quantity: 1 }], productGroups: [], sendNow: true });
ok(direct.request.status === 'new' && direct.request.cycle === 1 && direct.request.events.map(e => e.kind).join() === 'created,sent', 'сразу отправленный (без черновика)', direct.request.events.map(e => e.kind));
await expectErr(createDraft(mgr, { type: 'cheaper', source: 'button', manager: { bitrixId: '100', name: 'М' }, managerRegion: null, createdByLogin: 'mgr', deal: null, header: { queueId: q1.id }, items: [{ name: 'Болт' }], productGroups: [], sendNow: true }), 'invalid', 'сразу отправить cheaper без цены — ошибка, ничего не создано');
await applyAction(mgr, direct.request.id, { action: 'cancel' });
const { request: d3 } = await createDraft(mgr, { type: 'supply', source: 'button', manager: { bitrixId: '100', name: 'М' }, managerRegion: null, createdByLogin: 'mgr', deal: null, header: {}, items: [], productGroups: [] });
const bm2 = await loadBoard(mgr, { view: 'board', filters: {} });
ok(bm2.drafts.length === 1 && bm2.drafts[0]!.id === d3.id, 'черновики отдельно');
ok((await loadBoard(rop, { view: 'board', filters: {} })).drafts.length === 0, 'РОП черновиков не видит');
const dr = await loadDealRequests(mgr, 777);
ok(dr.requests.length === 1 && !dr.openByType.cheaper, 'запросы по сделке');
const lm = await listMessages(mgr, d.id, 0);
ok(lm.messages.length === 1 && lm.events.length > 5, 'сообщения + лента');
await systemDb().query(`UPDATE logist_requests SET deal_outcome = 'sold' WHERE id = $1`, [d.id]);
const deals = await loadBoard(admin, { view: 'deals', filters: {} });
ok(deals.columns[0]!.key === 'sold' && deals.columns[0]!.total === 1 && deals.columns[0]!.cards[0]!.column === 'sold', 'вид «Сделки»');
const s = await saveSettings({ slaHours: 4, weights: { cheaper: 50 } }, 'adm');
ok(s.slaHours === 4 && s.weights.cheaper === 50 && s.weights.perReturn === 15, 'настройки');
await systemDb().end();

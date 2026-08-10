// Чаты по сделкам: РОП (право action.deal_chats) пишет ответственному менеджеру
// через бота «Аналитик»; ответы менеджера прилетают в вебхук событий бота и
// складываются тредами. Механика корреляции подтверждена спайком 2026-07-20
// (WORKLOG): реплай (REPLY_ID) → номер сделки в тексте → единственный открытый
// тред → кнопки выбора (команда bind_deal, зарегистрирована в Битриксе).

import { systemDb, analyticsDb } from '@/lib/db/clients';
import { sendBitrixBotMessage, type BotKeyboardButton } from '@/lib/bitrix/notify';
import { loadManagerInfoMap } from '@/lib/marketing/sources';

const CRM_DEAL_URL = (dealId: number) => `https://td.monolit-crm.ru/crm/deal/details/${dealId}/`;

export type DealChatStatus = 'sent' | 'replied';

export interface DealChatRow {
  id: number;
  deal_id: number;
  deal_name: string | null;
  manager_bitrix_user_id: string;
  created_by_user_id: string;
  created_by_name: string;
  status: DealChatStatus;
  has_unread_reply: boolean;
  created_at: string;
  last_message_at: string;
}

export interface DealChatMessageRow {
  id: number;
  chat_id: number;
  direction: 'out' | 'in';
  author_name: string;
  text: string;
  created_at: string;
}

// ── Отправка (РОП → менеджер) ──────────────────────────────────────────────────────

export async function sendDealChatMessage(opts: {
  dealId: number;
  authorUserId: string;
  authorName: string;
  text: string;
}): Promise<{ chatId: number }> {
  const { dealId, authorUserId, authorName, text } = opts;

  // Менеджер и название — из sa.deals (истина), а не из клиента.
  const dealRes = await analyticsDb().query<{ deal_name: string | null; manager_id: string | null }>(
    'SELECT deal_name, current_manager_id::text AS manager_id FROM deals WHERE deal_id = $1',
    [dealId],
  );
  if (!dealRes.rows.length) throw new Error(`Сделка #${dealId} не найдена`);
  const { deal_name, manager_id } = dealRes.rows[0];
  if (!manager_id) throw new Error(`У сделки #${dealId} не назначен менеджер — отправлять некому`);

  const db = systemDb();
  const chatRes = await db.query<{ id: number; status: string }>(
    `INSERT INTO deal_chats (deal_id, deal_name, manager_bitrix_user_id, created_by_user_id, created_by_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (deal_id, created_by_user_id) DO UPDATE
       SET last_message_at = NOW(), manager_bitrix_user_id = EXCLUDED.manager_bitrix_user_id
     RETURNING id, status`,
    [dealId, deal_name, manager_id, authorUserId, authorName],
  );
  const chatId = chatRes.rows[0].id;

  const message = [
    `[b]Вопрос по сделке [URL=${CRM_DEAL_URL(dealId)}]#${dealId}${deal_name ? ` — ${deal_name}` : ''}[/URL][/b]`,
    `[b]От кого:[/b] ${authorName}`,
    '',
    text,
    '',
    '[i]Ответьте на это сообщение (стрелка «Ответить») — ответ уйдёт автору вопроса.[/i]',
  ].join('\n');

  const bitrixMessageId = await sendBitrixBotMessage(manager_id, message, undefined, 'deal_chats');

  await db.query(
    `INSERT INTO deal_chat_messages (chat_id, direction, author_name, text, bitrix_message_id)
     VALUES ($1, 'out', $2, $3, $4)`,
    [chatId, authorName, text, bitrixMessageId || null],
  );
  return { chatId };
}

// ── Чтение (списки, тред, статусы для индикации) ───────────────────────────────────

/** Статусы тредов текущего автора по набору сделок (индикация кнопки в списке сделок). */
export async function getDealChatStatuses(authorUserId: string, dealIds: number[]): Promise<Record<number, { status: DealChatStatus; unread: boolean }>> {
  if (dealIds.length === 0) return {};
  const res = await systemDb().query<{ deal_id: number; status: DealChatStatus; has_unread_reply: boolean }>(
    `SELECT deal_id, status, has_unread_reply FROM deal_chats
      WHERE created_by_user_id = $1 AND deal_id = ANY($2::bigint[])`,
    [authorUserId, dealIds],
  );
  const out: Record<number, { status: DealChatStatus; unread: boolean }> = {};
  for (const r of res.rows) out[r.deal_id] = { status: r.status, unread: r.has_unread_reply };
  return out;
}

/** Треды автора для раздела «Чаты»: непрочитанные сверху, потом по свежести. */
export async function listDealChats(authorUserId: string): Promise<(DealChatRow & { last_text: string | null; last_direction: string | null; manager_name: string | null })[]> {
  const res = await systemDb().query<DealChatRow & { last_text: string | null; last_direction: string | null }>(
    `SELECT c.*, lm.text AS last_text, lm.direction AS last_direction
       FROM deal_chats c
       LEFT JOIN LATERAL (
         SELECT text, direction FROM deal_chat_messages
          WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1
       ) lm ON true
      WHERE c.created_by_user_id = $1
      ORDER BY c.has_unread_reply DESC, c.last_message_at DESC
      LIMIT 500`,
    [authorUserId],
  );
  const mgrInfo = await loadManagerInfoMap();
  return res.rows.map(r => ({
    ...r,
    manager_name: mgrInfo.get(r.manager_bitrix_user_id)?.name ?? `#${r.manager_bitrix_user_id}`,
  }));
}

/** Тред с сообщениями; открытие гасит красную индикацию. */
export async function getDealChatThread(authorUserId: string, chatId: number): Promise<{ chat: DealChatRow & { manager_name: string | null }; messages: DealChatMessageRow[] } | null> {
  const db = systemDb();
  const chatRes = await db.query<DealChatRow>(
    'SELECT * FROM deal_chats WHERE id = $1 AND created_by_user_id = $2',
    [chatId, authorUserId],
  );
  if (!chatRes.rows.length) return null;
  const chat = chatRes.rows[0];

  const [messages, mgrInfo] = await Promise.all([
    db.query<DealChatMessageRow>(
      'SELECT id, chat_id, direction, author_name, text, created_at FROM deal_chat_messages WHERE chat_id = $1 ORDER BY created_at',
      [chatId],
    ),
    loadManagerInfoMap(),
  ]);

  if (chat.has_unread_reply) {
    await db.query('UPDATE deal_chats SET has_unread_reply = false WHERE id = $1', [chatId]);
    chat.has_unread_reply = false;
  }

  return {
    chat: { ...chat, manager_name: mgrInfo.get(chat.manager_bitrix_user_id)?.name ?? `#${chat.manager_bitrix_user_id}` },
    messages: messages.rows,
  };
}

// ── Входящие от менеджера (вызывается из /api/bitrix/events) ───────────────────────

interface OpenChat { id: number; deal_id: number; deal_name: string | null }

async function openChatsOfManager(managerId: string): Promise<OpenChat[]> {
  const res = await systemDb().query<OpenChat>(
    `SELECT id, deal_id, deal_name FROM deal_chats
      WHERE manager_bitrix_user_id = $1
      ORDER BY last_message_at DESC LIMIT 10`,
    [managerId],
  );
  return res.rows;
}

async function attachReply(chatId: number, managerName: string, text: string): Promise<void> {
  const db = systemDb();
  await db.query(
    `INSERT INTO deal_chat_messages (chat_id, direction, author_name, text) VALUES ($1, 'in', $2, $3)`,
    [chatId, managerName, text],
  );
  await db.query(
    `UPDATE deal_chats SET status = 'replied', has_unread_reply = true, last_message_at = NOW() WHERE id = $1`,
    [chatId],
  );
}

async function managerDisplayName(managerId: string): Promise<string> {
  const mgrInfo = await loadManagerInfoMap();
  return mgrInfo.get(managerId)?.name ?? `#${managerId}`;
}

/**
 * Текстовое сообщение менеджера боту (ONIMBOTMESSAGEADD, личка).
 * Возвращает true, если сообщение относилось к чатам по сделкам (иначе пусть
 * обрабатывают другие подсистемы — например, будущая Phase 2 NL-бота).
 */
export async function handleIncomingBotMessage(opts: {
  fromUserId: string;
  text: string;
  replyToBitrixMessageId: number | null;
}): Promise<boolean> {
  const { fromUserId, text, replyToBitrixMessageId } = opts;
  const db = systemDb();

  // 1. Реплай: REPLY_ID → наше исходящее сообщение → тред. Самый точный путь.
  if (replyToBitrixMessageId) {
    const res = await db.query<{ chat_id: number }>(
      `SELECT m.chat_id FROM deal_chat_messages m
        JOIN deal_chats c ON c.id = m.chat_id
       WHERE m.bitrix_message_id = $1 AND c.manager_bitrix_user_id = $2
       LIMIT 1`,
      [replyToBitrixMessageId, fromUserId],
    );
    if (res.rows.length) {
      await attachReply(res.rows[0].chat_id, await managerDisplayName(fromUserId), text);
      await sendBitrixBotMessage(fromUserId, '✅ Передал автору вопроса.', undefined, 'deal_chats');
      return true;
    }
  }

  const open = await openChatsOfManager(fromUserId);
  if (open.length === 0) return false; // не наш кейс — у менеджера нет тредов

  // 2. Номер сделки в тексте (например «226895 всё отгрузили» или «по #226895 ...»).
  const idMatches = [...text.matchAll(/#?(\d{5,8})/g)].map(m => Number(m[1]));
  const byId = open.find(c => idMatches.includes(c.deal_id));
  if (byId) {
    await attachReply(byId.id, await managerDisplayName(fromUserId), text);
    await sendBitrixBotMessage(fromUserId, `✅ Передал автору вопроса (сделка #${byId.deal_id}).`, undefined, 'deal_chats');
    return true;
  }

  // 3. Единственный открытый тред — привязываем без вопросов.
  if (open.length === 1) {
    await attachReply(open[0].id, await managerDisplayName(fromUserId), text);
    await sendBitrixBotMessage(fromUserId, `✅ Передал автору вопроса (сделка #${open[0].deal_id}).`, undefined, 'deal_chats');
    return true;
  }

  // 4. Несколько тредов: паркуем текст и спрашиваем кнопками (клик → ONIMCOMMANDADD bind_deal).
  await db.query(
    `INSERT INTO deal_chat_pending_replies (manager_bitrix_user_id, text)
     VALUES ($1, $2)
     ON CONFLICT (manager_bitrix_user_id) DO UPDATE SET text = EXCLUDED.text, created_at = NOW()`,
    [fromUserId, text],
  );
  const buttons: BotKeyboardButton[] = open.map(c => ({
    TEXT: `#${c.deal_id}${c.deal_name ? ` ${c.deal_name.slice(0, 40)}` : ''}`,
    COMMAND: 'bind_deal',
    COMMAND_PARAMS: String(c.id),
    DISPLAY: 'LINE',
    BG_COLOR: '#29619b',
    TEXT_COLOR: '#fff',
  }));
  await sendBitrixBotMessage(fromUserId, '❓ У вас несколько открытых вопросов. К какой сделке относится ответ?', buttons, 'deal_chats');
  return true;
}

/** Клик по кнопке выбора сделки (ONIMCOMMANDADD bind_deal, COMMAND_PARAMS = chat id). */
export async function handleBindDealCommand(opts: { fromUserId: string; chatId: number }): Promise<void> {
  const { fromUserId, chatId } = opts;
  const db = systemDb();

  const pending = await db.query<{ text: string }>(
    'DELETE FROM deal_chat_pending_replies WHERE manager_bitrix_user_id = $1 RETURNING text',
    [fromUserId],
  );
  if (!pending.rows.length) {
    await sendBitrixBotMessage(fromUserId, 'Не нашёл ответа для привязки — напишите его ещё раз, пожалуйста.', undefined, 'deal_chats');
    return;
  }

  const chat = await db.query<{ id: number; deal_id: number }>(
    'SELECT id, deal_id FROM deal_chats WHERE id = $1 AND manager_bitrix_user_id = $2',
    [chatId, fromUserId],
  );
  if (!chat.rows.length) {
    await sendBitrixBotMessage(fromUserId, 'Этот вопрос уже не активен. Напишите ответ ещё раз, пожалуйста.', undefined, 'deal_chats');
    return;
  }

  await attachReply(chatId, await managerDisplayName(fromUserId), pending.rows[0].text);
  await sendBitrixBotMessage(fromUserId, `✅ Передал автору вопроса (сделка #${chat.rows[0].deal_id}).`, undefined, 'deal_chats');
}

import crypto from 'crypto';
import type { NextRequest } from 'next/server';
import { redisReady } from '@/lib/cache/redis';
import { getSession } from '@/lib/auth/session';
import { canUseModules, canSessionSeeClientRef } from '@/lib/auth/modulesAccess';

// Пропуск виджета «Карточка клиента» во вкладке карточки контакта/компании
// Битрикса (задача владельца 13.10). Почему не cookie, как у /api/bitrix/app:
// браузеры режут cookie внутри чужого iframe (Safari, Яндекс.Браузер, десктопный
// Битрикс24 — инцидент 21.09), а уводить менеджера из карточки клиента «в
// отдельную вкладку» для виджета неприемлемо. Поэтому при открытии вкладки
// сервер сам проверяет сотрудника и его право видеть ЭТОГО клиента (через его
// же AUTH_ID — Битрикс отвечает по правам сотрудника) и выдаёт ключ, привязанный
// к сотруднику и к клиенту. Виджет передаёт ключ заголовком X-Widget-Token.
// Ключ живёт 8 часов (рабочий день с открытой карточкой).

const TTL_SEC = 8 * 3600;
const key = (token: string) => `bxwidget:grant:${token}`;
export const WIDGET_TOKEN_HEADER = 'x-widget-token';

export interface WidgetGrant { userId: string; actor: string; ref: string }

export async function mintWidgetGrant(g: WidgetGrant): Promise<string | null> {
  const r = await redisReady();
  if (!r) return null;
  const token = crypto.randomBytes(24).toString('base64url');
  const ok = await r.set(key(token), JSON.stringify(g), 'EX', TTL_SEC).then(() => true).catch(() => false);
  return ok ? token : null;
}

export async function readWidgetGrant(token: string | null | undefined): Promise<WidgetGrant | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const r = await redisReady();
  if (!r) return null;
  const raw = await r.get(key(token)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as WidgetGrant; } catch { return null; }
}

/**
 * Кто вызывает API модуля и вправе ли он трогать клиента `ref`:
 *  — сессия Монолитики с доступом к «Модулям» (админ/право роли) — любой клиент;
 *  — пропуск виджета из Битрикса — только тот клиент, для которого он выдан.
 * `ref` = null — проверка без привязки к клиенту (геокодер: любой пропуск годится).
 * Возвращает подпись автора правки (updated_by) или null — доступа нет.
 */
export async function moduleActor(req: NextRequest, ref: string | null): Promise<string | null> {
  const session = await getSession().catch(() => null);
  if (session && canUseModules(session)) return session.login;
  // Единая карточка клиента в приложении: менеджер/РОП видит «своих» клиентов по сессии.
  if (session && ref !== null && await canSessionSeeClientRef(session, ref)) return session.login;
  const grant = await readWidgetGrant(req.headers.get(WIDGET_TOKEN_HEADER));
  if (!grant) return null;
  if (ref !== null && grant.ref !== ref) return null;
  return grant.actor;
}

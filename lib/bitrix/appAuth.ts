import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { analyticsDb, systemDb } from '@/lib/db/clients';

// SSO для встроенного в Битрикс приложения (задача владельца 30.07).
//
// Как это работает. Битрикс открывает наш обработчик в iframe POST-запросом и
// передаёт в теле AUTH_ID — OAuth access token ТЕКУЩЕГО сотрудника. Мы дёргаем
// этим токеном REST-метод `profile`, и Битрикс сам отвечает, чей это токен.
// Подделать нельзя: токен выдал Битрикс, и проверяем мы его у Битрикса.
//
// ГЛАВНОЕ ПРАВИЛО БЕЗОПАСНОСТИ: REST зовём по адресу портала ИЗ ОКРУЖЕНИЯ, а НЕ по
// DOMAIN из тела запроса. Иначе злоумышленник поднимает свой Битрикс, присылает нам
// свой токен и свой DOMAIN — его сервер отвечает «да, это юзер 1860», и он получает
// чужую карточку. При проверке у НАШЕГО портала посторонний токен просто не пройдёт.

/** Адрес портала: явный BITRIX_PORTAL_URL либо origin существующего вебхука. */
export function bitrixPortalOrigin(): string | null {
  const explicit = process.env.BITRIX_PORTAL_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const wh = process.env.BITRIX_WEBHOOK_URL || process.env.BITRIX_BOT_WEBHOOK_URL || '';
  try {
    return wh ? new URL(wh).origin : null;
  } catch {
    return null;
  }
}

export interface BitrixIdentity {
  bitrixUserId: string;
  name: string;
  isAdmin: boolean;
}

/**
 * Проверяет AUTH_ID у портала и возвращает, чей это токен. null — токен невалиден,
 * выдан другим порталом, или портал недоступен.
 */
export async function identifyByAuthId(authId: string): Promise<BitrixIdentity | null> {
  const origin = bitrixPortalOrigin();
  if (!origin || !authId) return null;

  try {
    const res = await fetch(`${origin}/rest/profile.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth: authId }),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = await res.json();
    const r = body?.result;
    const id = r?.ID != null ? String(r.ID) : '';
    if (!/^\d+$/.test(id)) return null;
    const name = [r?.NAME, r?.LAST_NAME].filter(Boolean).join(' ').trim();
    return { bitrixUserId: id, name: name || `Сотрудник ${id}`, isAdmin: r?.ADMIN === true };
  } catch {
    return null;
  }
}

export interface ResolvedAppUser {
  userId: string;
  created: boolean;
}

/**
 * Находит наш аккаунт по bitrix_user_id, при отсутствии — создаёт («Вариант Б»,
 * решение владельца: ЛК доступен всем менеджерам из Битрикса).
 *
 * У созданного аккаунта:
 *   * роль «Пользователь» — пустой набор прав, ни один раздел приложения не открыт;
 *     ЛК (/manager/me) и /profile правами не гейтятся, этого достаточно;
 *   * пароль — bcrypt-хеш от случайной строки, которую никто не знает: войти через
 *     форму /login невозможно, вход только через Битрикс (так автосоздание не плодит
 *     аккаунтов с паролем, который надо было бы кому-то выдавать). Именно валидный
 *     хеш, а не маркер-строка: bcryptjs на мусорном значении вернул бы false, но
 *     нативный bcrypt бросает — не хочу, чтобы смена библиотеки превратила попытку
 *     входа в 500. Признак SSO-аккаунта — префикс логина `bx`.
 * Имя берём из оргструктуры (там ФИО в принятом в компании виде), иначе из Битрикса.
 */
export async function resolveOrCreateAppUser(identity: BitrixIdentity): Promise<ResolvedAppUser | null> {
  const db = systemDb();

  const existing = await db.query<{ id: string; is_active: boolean }>(
    'SELECT id, is_active FROM users WHERE bitrix_user_id = $1 LIMIT 1',
    [identity.bitrixUserId],
  );
  if (existing.rows.length > 0) {
    if (!existing.rows[0].is_active) return null; // уволенный/отключённый — не пускаем
    return { userId: existing.rows[0].id, created: false };
  }

  // Имя из оргструктуры (sa), если сотрудник там есть
  let displayName = identity.name;
  try {
    const org = await analyticsDb().query<{ manager_name: string | null }>(
      `SELECT manager_name FROM sa.org_resolved_hierarchy
        WHERE manager_bitrix_user_id::text = $1 AND is_active = true LIMIT 1`,
      [identity.bitrixUserId],
    );
    if (org.rows[0]?.manager_name) displayName = org.rows[0].manager_name;
  } catch {
    /* оргструктура недоступна — не повод не пустить, останется имя из Битрикса */
  }

  // Логин с префиксом bx, чтобы не столкнуться с людьми, заведёнными вручную
  const login = `bx${identity.bitrixUserId}`;
  const res = await db.query<{ id: string }>(
    `INSERT INTO users (login, password_hash, display_name, bitrix_user_id, is_active, is_admin, is_superadmin, role_id)
     VALUES ($1, $2, $3, $4, true, false, false, (SELECT id FROM roles WHERE name = 'Пользователь'))
     ON CONFLICT (login) DO UPDATE SET bitrix_user_id = EXCLUDED.bitrix_user_id
     RETURNING id`,
    [login, bcrypt.hashSync(crypto.randomUUID() + crypto.randomUUID(), 10), displayName, identity.bitrixUserId],
  );
  return { userId: res.rows[0].id, created: true };
}

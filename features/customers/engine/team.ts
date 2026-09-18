import type { SessionUser } from '@/lib/auth/session';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { fetchManagerCustomers, type CustomerRow } from './customers';

// Агрегированный вид «Мои заказчики» для РОПа и выше (решение владельца 17.09:
// «для ропов и выше показывать агрегированно, логично же»). Ростер — менеджеры
// подконтрольных отделов (та же managed-depts механика, что «Моя команда» и
// /api/customers/team); чужие сюда не попадают by construction. Списки берутся из
// пер-менеджерского кэша движка, поэтому очередь и правила — те же, что у самого
// менеджера, только на всех разом.

export interface TeamManager { id: string; name: string; departmentName: string | null }

/**
 * Ростер команды. anchorBitrixId — чей отдел (по умолчанию — сам смотрящий):
 * руководитель, открывший кабинет РОПа, видит команду ЭТОГО РОПа (правка владельца
 * 18.09: «Алёна Андреева — РОП, видит только своих»). Сам РОП в ростер входит —
 * его заказчики тоже часть отдела.
 */
export async function fetchTeamRoster(session: SessionUser, anchorBitrixId?: string | null): Promise<TeamManager[]> {
  const anchor = anchorBitrixId ?? session.bitrixUserId;
  if (!anchor) return [];
  const managed = await getCallControlManagedDepts(anchor);
  if (!managed.length) return [];
  const managers = await resolveManagersForDepartments(managed.map(d => d.deptId));
  const deptNames = new Map(managed.map(d => [d.deptId, d.deptName ?? null]));
  const seen = new Set<string>();
  const out: TeamManager[] = [];
  for (const m of managers) {
    const id = String(m.managerId);
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: m.name || m.login || id, departmentName: deptNames.get(m.deptUuid) ?? null });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return out;
}

export type TeamCustomerRow = CustomerRow & { managerId: string; managerName: string };

/** Заказчики всей команды — конкатенация пер-менеджерских списков (кэш движка). */
export async function fetchTeamCustomers(roster: TeamManager[]): Promise<TeamCustomerRow[]> {
  const out: TeamCustomerRow[] = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < roster.length; i += CONCURRENCY) {
    const chunk = roster.slice(i, i + CONCURRENCY);
    const lists = await Promise.all(chunk.map(m => fetchManagerCustomers(Number(m.id)).then(rows => rows.map(r => ({ ...r, managerId: m.id, managerName: m.name })))));
    for (const l of lists) out.push(...l);
  }
  return out;
}

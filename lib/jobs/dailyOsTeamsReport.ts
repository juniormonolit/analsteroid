// Ежедневный отчёт «ОБЩЕСТРОЙ по командам» — для Леонида Коваленко (bitrix 1923),
// задача владельца 03.08: «то же самое, что мне, но не ОС/НЦ/ЖБИ в Москве, а
// команды Общестроя».
//
// Состав команд подтверждён владельцем по его же ручному отчёту (5 групп):
//   Осипов, Уханова, Руденко, Подчаший (= отдел «Спецназ Монолит»), Зианбетова.
// «Отдел перспективы ОС» — тоже ребёнок «Департамента ОС», но в отчёт владельца
// НЕ входит (это пул перспективы, не боевая команда), поэтому в списке его нет.
//
// Почему список отделов — константа, а не «дети Департамента ОС» из БД: в
// оргструктуре Битрикса РОПы этих команд проставлены неверно (за Коваленко
// закреплены только 3 из 5 — ровно та причина, по которой у робота «Контроль
// звонков» есть ручные назначения). Брать «всех детей департамента» тоже нельзя —
// затянуло бы перспективу. Список правится здесь при изменении структуры отдела.

import { analyticsDb } from '@/lib/db/clients';
import { buildGroupReport, sendGroupReport, type GroupReportConfig, type GroupReportData } from './dailyGroupReport';

/** Отделы sa.org_resolved_hierarchy.department_name → подпись в отчёте. */
const TEAMS: { department: string; title: string }[] = [
  { department: 'Команда Осипов',      title: 'Осипов' },
  { department: 'Команда Ухановой',    title: 'Уханова' },
  { department: 'Команда Руденко',     title: 'Руденко' },
  { department: 'Спецназ Монолит',     title: 'Подчаший' },
  { department: 'Команда Зианбетовой', title: 'Зианбетова' },
];

const RECIPIENT_BITRIX_ID = '1923'; // Леонид Коваленко

export async function buildOsTeamsConfig(): Promise<GroupReportConfig> {
  const res = await analyticsDb().query<{ department_name: string; manager_id: string }>(
    `SELECT department_name, manager_bitrix_user_id::text AS manager_id
       FROM sa.org_resolved_hierarchy
      WHERE is_active = true AND department_name = ANY($1)`,
    [TEAMS.map(t => t.department)],
  );

  const byDept = new Map<string, Set<string>>();
  for (const row of res.rows) {
    if (!byDept.has(row.department_name)) byDept.set(row.department_name, new Set());
    byDept.get(row.department_name)!.add(row.manager_id);
  }

  return {
    header: 'Отчет КОВАЛЕНКО',
    totalTitle: 'ОБЩЕСТРОЙ',
    // Суммы итогового блока — в рублях, как в ручном отчёте владельца отдела.
    totalsInRubles: true,
    groups: TEAMS.map(t => ({
      key: t.department,
      title: t.title,
      managerIds: byDept.get(t.department) ?? new Set<string>(),
    })),
  };
}

export async function buildOsTeamsReport(reportDate?: string): Promise<GroupReportData> {
  return buildGroupReport(await buildOsTeamsConfig(), reportDate);
}

export async function sendOsTeamsReport(dialogId?: string, reportDate?: string): Promise<GroupReportData> {
  const recipient = dialogId || process.env.OS_TEAMS_REPORT_BITRIX_USER_ID || RECIPIENT_BITRIX_ID;
  return sendGroupReport(recipient, await buildOsTeamsConfig(), reportDate);
}

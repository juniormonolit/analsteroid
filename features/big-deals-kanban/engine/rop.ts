// РОП исполнителя задачи по оргструктуре (РОП Осипов 18.11): при назначении менеджера РОП нового исполнителя
// всегда становится наблюдателем; в чате — кнопка «Отметить РОПа» (упоминание [USER=id]). Резолвер — тот же,
// что у канбана повторных (ropOfManager: sa.org_resolved_hierarchy, ближайший предок с UF_HEAD).
import { read, ropOfManager } from '@/features/repeat-kanban/engine/createDeal';

export async function responsibleRop(responsibleId: string): Promise<{ id: string; name: string } | null> {
  const id = await ropOfManager(responsibleId);
  if (!id || id === responsibleId) return null;
  const u = await read<{ NAME?: string; LAST_NAME?: string }[]>('user.get', { ID: id }).catch(() => null);
  const name = [u?.[0]?.NAME, u?.[0]?.LAST_NAME].filter(Boolean).join(' ').trim();
  return { id, name: name || `сотрудник ${id}` };
}

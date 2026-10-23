// Файлы и картинки в комментарии задачи (владелец 23.10: «добавление файлов и изображений (в том числе
// через обычную вставку в текстовое поле) в комментарий к задаче», по образцу «Есть идея»).
// Битрикс прикрепляет к комментарию только файлы своего Диска: грузим в папку «Монолитика — вложения
// задач» на диске владельца вебхука (disk.folder.uploadfile), в task.commentitem.add отдаём
// UF_FORUM_MESSAGE_DOC: ['n<id>'] — дальше права даёт сам Битрикс (видят участники задачи).
// Загрузка — отдельным запросом прямо перед действием (POST /api/repeat-kanban/attachments): брошенная
// форма ничего не грузит. Клиенту — одноразовый токен (память процесса, 30 мин), не id файла: чужой
// файл Диска по подобранному id к задаче не прикрепить.
import { randomUUID } from 'crypto';
import { DealCreateError, read, taskWebhook, writeOnce } from './createDeal';

export const ATTACH_MAX_COUNT = 6;
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const FOLDER_NAME = 'Монолитика — вложения задач';
const TTL_MS = 30 * 60_000;

let folderId: Promise<number> | null = null;
async function folder(): Promise<number> {
  folderId ??= (async () => {
    const me = await read<{ ID: string }>('user.current', {});
    const storages = await read<{ ID: string }[]>('disk.storage.getlist', { filter: { ENTITY_TYPE: 'user', ENTITY_ID: Number(me.ID) } });
    const storage = Number(storages?.[0]?.ID);
    if (!storage) throw new DealCreateError('Нет Диска у пользователя вебхука');
    const found = await read<{ ID: string; TYPE: string }[]>('disk.storage.getchildren', { id: storage, filter: { NAME: FOLDER_NAME } });
    const f = found?.find(x => x.TYPE === 'folder');
    if (f) return Number(f.ID);
    const made = await writeOnce<{ ID: string }>(taskWebhook(), 'disk.storage.addfolder', { id: storage, data: { NAME: FOLDER_NAME } });
    return Number(made.ID);
  })().catch(e => { folderId = null; throw e; });
  return folderId;
}

const tokens = new Map<string, { diskId: number; login: string; name: string; at: number }>();

/** Файл → Диск Битрикса; возвращает токен для действия. */
export async function uploadAttachment(login: string, name: string, data: Buffer): Promise<{ token: string; name: string }> {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '_').slice(-120) || 'file';
  const res = await writeOnce<{ ID: string }>(taskWebhook(), 'disk.folder.uploadfile', {
    id: await folder(), data: { NAME: safe }, fileContent: [safe, data.toString('base64')], generateUniqueName: true,
  });
  const now = Date.now();
  for (const [k, v] of tokens) if (now - v.at > TTL_MS) tokens.delete(k);
  const token = randomUUID();
  tokens.set(token, { diskId: Number(res.ID), login, name: safe, at: now });
  return { token, name: safe };
}

/** Токены → id файлов Диска (только свои и свежие; одноразовые). */
export function takeAttachments(login: string, raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const t of raw.slice(0, ATTACH_MAX_COUNT)) {
    const v = typeof t === 'string' ? tokens.get(t) : undefined;
    if (!v || v.login !== login || Date.now() - v.at > TTL_MS) continue;
    tokens.delete(t as string);
    out.push(v.diskId);
  }
  return out;
}

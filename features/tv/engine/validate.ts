// Валидация тела запросов админки телевизоров. Возвращает либо нормализованный
// ввод, либо строку ошибки для 400.

import { normalizeSettings, type TvMessageInput, type TvMessageKind, type TvScreenInput } from '../shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseScreenInput(body: unknown): TvScreenInput | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = String(b.name ?? '').trim().slice(0, 80);
  if (!name) return 'Укажите название экрана';
  const comment = typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim().slice(0, 300) : null;
  const deptRaw = Array.isArray(b.departmentIds) ? b.departmentIds : [];
  const departmentIds = [...new Set(deptRaw.map(String).filter(id => UUID_RE.test(id)))];
  if (departmentIds.length === 0) return 'Выберите хотя бы один отдел';
  if (departmentIds.length > 12) return 'Не больше 12 отделов на экран';
  const mode = b.mode === 'merged' ? 'merged' : 'carousel';
  const theme = b.theme === 'light' ? 'light' : 'dark';
  const rotateNum = Number(b.rotateSec);
  const rotateSec = Number.isFinite(rotateNum) ? Math.min(300, Math.max(5, Math.round(rotateNum))) : 20;
  const tickerText = typeof b.tickerText === 'string' && b.tickerText.trim() ? b.tickerText.trim().slice(0, 500) : null;
  const settings = normalizeSettings(b.settings);
  const tickerEnabled = b.tickerEnabled === true && (!!tickerText || Object.keys(settings.deptTickers).length > 0);
  return { name, comment, departmentIds, mode, theme, rotateSec, tickerText, tickerEnabled, settings };
}

export function parseMessageInput(body: unknown): (TvMessageInput & { endsAtDate: Date }) | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const kind: TvMessageKind = b.kind === 'banner' || b.kind === 'fullscreen' ? b.kind : 'ticker';
  const text = String(b.text ?? '').trim().slice(0, kind === 'ticker' ? 500 : 300);
  const imageId = kind === 'fullscreen' && typeof b.imageId === 'string' && UUID_RE.test(b.imageId) ? b.imageId : null;
  if (!text && !imageId) return 'Введите текст сообщения' + (kind === 'fullscreen' ? ' или добавьте картинку' : '');
  let targetScreenIds: string[] | null = null;
  if (Array.isArray(b.targetScreenIds)) {
    targetScreenIds = [...new Set(b.targetScreenIds.map(String).filter(id => UUID_RE.test(id)))];
    if (targetScreenIds.length === 0) return 'Выберите хотя бы один экран или «все экраны»';
  }
  let endsAtDate: Date;
  if (typeof b.endsAt === 'string' && !Number.isNaN(Date.parse(b.endsAt))) {
    endsAtDate = new Date(b.endsAt);
  } else {
    const minutes = Number(b.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 7) return 'Длительность — от 1 минуты до 7 дней';
    endsAtDate = new Date(Date.now() + minutes * 60_000);
  }
  if (endsAtDate.getTime() <= Date.now()) return 'Время окончания уже прошло';
  return { kind, text, targetScreenIds, endsAtDate, imageId };
}

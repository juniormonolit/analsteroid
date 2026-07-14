// Фича «Идеи и планы» (владелец, макет ideas-backlog-mock.html) — бэклог идей от
// пользователей, та же механика, что changelog (миграция 059). См. app/api/ideas/*.

export type IdeaStatus = 'proposed' | 'planned' | 'in_progress' | 'done' | 'rejected';

export interface IdeaAttachment {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  uploadedBy: string;
  createdAt: string; // ISO
}

export interface Idea {
  id: string;
  title: string;
  body: string;
  status: IdeaStatus;
  authorLogin: string;
  authorName: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  attachments: IdeaAttachment[]; // скриншоты, миграция 101
}

export interface IdeasListResponse {
  planned: Idea[]; // status IN (planned, in_progress) — «ЗАПЛАНИРОВАНО», in_progress выше planned
  proposed: Idea[]; // status = proposed — «ПРЕДЛОЖЕНО»
}

export interface IdeaSubmitInput {
  title: string;
  body: string;
}

export const IDEA_TITLE_MAX_LEN = 200;
export const IDEA_BODY_MAX_LEN = 4000;

export const IDEA_ADMIN_STATUSES: IdeaStatus[] = ['planned', 'in_progress', 'done', 'rejected'];

// Ограничения вложений-скриншотов (MVP): только картинки, до 8 МБ каждая, до 6 на идею.
export const IDEA_ATTACH_MAX_BYTES = 8 * 1024 * 1024;
export const IDEA_ATTACH_MAX_COUNT = 6;
export const IDEA_ATTACH_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

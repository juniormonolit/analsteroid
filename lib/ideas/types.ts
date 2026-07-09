// Фича «Идеи и планы» (владелец, макет ideas-backlog-mock.html) — бэклог идей от
// пользователей, та же механика, что changelog (миграция 059). См. app/api/ideas/*.

export type IdeaStatus = 'proposed' | 'planned' | 'in_progress' | 'done' | 'rejected';

export interface Idea {
  id: string;
  title: string;
  body: string;
  status: IdeaStatus;
  authorLogin: string;
  authorName: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
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

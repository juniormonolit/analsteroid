import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import type { Idea, IdeasListResponse, IdeaSubmitInput } from '@/lib/ideas/types';
import { IDEA_TITLE_MAX_LEN, IDEA_BODY_MAX_LEN } from '@/lib/ideas/types';

type IdeaRow = {
  id: string;
  title: string;
  body: string;
  status: Idea['status'];
  author_login: string;
  author_name: string | null;
  created_at: Date;
  updated_at: Date;
};

function toIdea(r: IdeaRow): Idea {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    status: r.status,
    authorLogin: r.author_login,
    authorName: r.author_name,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

// Лента «Идеи и планы» (макет ideas-backlog-mock.html): «ЗАПЛАНИРОВАНО»
// (planned + in_progress, в работе выше запланированных) и «ПРЕДЛОЖЕНО» (proposed).
// done/rejected сознательно НЕ показываются в основной ленте (решение по простоте —
// см. owners-inbox/, бриф задачи) — история решённых идей доступна прямым запросом
// к БД при необходимости, отдельный экран не делаем.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = systemDb();
  const [plannedRes, proposedRes] = await Promise.all([
    db.query<IdeaRow>(
      `SELECT id, title, body, status, author_login, author_name, created_at, updated_at
         FROM ideas
        WHERE status IN ('in_progress', 'planned')
        ORDER BY (status = 'in_progress') DESC, updated_at DESC`
    ),
    db.query<IdeaRow>(
      `SELECT id, title, body, status, author_login, author_name, created_at, updated_at
         FROM ideas
        WHERE status = 'proposed'
        ORDER BY created_at DESC`
    ),
  ]);

  const result: IdeasListResponse = {
    planned: plannedRes.rows.map(toIdea),
    proposed: proposedRes.rows.map(toIdea),
  };
  return NextResponse.json(result);
}

// Подать идею — любой залогиненный пользователь, автор = текущая сессия.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: Partial<IdeaSubmitInput> = await req.json().catch(() => ({}));
  const title = (body.title ?? '').trim();
  const text = (body.body ?? '').trim();

  if (!title || !text) {
    return NextResponse.json({ error: 'Название и описание обязательны' }, { status: 400 });
  }
  if (title.length > IDEA_TITLE_MAX_LEN) {
    return NextResponse.json({ error: `Название длиннее ${IDEA_TITLE_MAX_LEN} символов` }, { status: 400 });
  }
  if (text.length > IDEA_BODY_MAX_LEN) {
    return NextResponse.json({ error: `Описание длиннее ${IDEA_BODY_MAX_LEN} символов` }, { status: 400 });
  }

  const res = await systemDb().query<{ id: string }>(
    `INSERT INTO ideas (title, body, author_login, author_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [title, text, session.login, session.displayName]
  );
  return NextResponse.json({ ok: true, id: res.rows[0]?.id ?? null });
}

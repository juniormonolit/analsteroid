import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { parseClientRef } from '@/features/client-module/engine/clientModule';
import { activatePrompt, builtinPrompt, getActivePrompt, listPrompts, savePrompt, validatePrompt } from '@/features/ai-analysis/engine/promptStore';
import { enqueue } from '@/features/ai-analysis/engine/store';
import { kickAiWorker } from '@/features/ai-analysis/engine/worker';

// Редактор промпта ИИ-анализа (этап 2): только супер-админы («промпт правят только админы»).
// GET — активная версия, встроенная из кода, история. POST:
//   { action: 'test', body, contactId|companyId } — тест-прогон черновика (очередь, is_test);
//   { action: 'save', body, note, activate } — новая версия;
//   { action: 'activate', id | null } — включить версию / вернуть встроенный.
export async function GET() {
  const session = await getSession().catch(() => null);
  const err = superadminError(session);
  if (err) return err;
  const [active, versions] = await Promise.all([getActivePrompt(), listPrompts().catch(() => [])]);
  return NextResponse.json({ active, builtin: builtinPrompt(), versions });
}

export async function POST(req: NextRequest) {
  const session = await getSession().catch(() => null);
  const err = superadminError(session);
  if (err || !session) return err ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const b = await req.json().catch(() => ({})) as { action?: string; body?: string; note?: string; activate?: boolean; id?: number | null; contactId?: string; companyId?: string };
  try {
    if (b.action === 'activate') {
      await activatePrompt(typeof b.id === 'number' ? b.id : null);
      return NextResponse.json({ ok: true });
    }
    const body = typeof b.body === 'string' ? b.body : '';
    const invalid = validatePrompt(body);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    if (b.action === 'test') {
      const ref = parseClientRef(b.contactId ?? null, b.companyId ?? null);
      if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании для теста' }, { status: 400 });
      const id = await enqueue({ clientRef: ref, promptVersion: 'draft', by: { login: session.login, name: session.displayName }, test: { body } });
      kickAiWorker();
      return NextResponse.json({ id });
    }
    if (b.action === 'save') {
      const id = await savePrompt({ body, note: b.note?.trim().slice(0, 500) || null, by: session.login, activate: !!b.activate });
      return NextResponse.json({ id, version: `db${id}` });
    }
    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
  } catch (e) {
    console.error('[ai-analysis/prompts]', e);
    return NextResponse.json({ error: 'Не удалось выполнить действие' }, { status: 500 });
  }
}

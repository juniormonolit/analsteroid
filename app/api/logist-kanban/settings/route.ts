import { NextRequest, NextResponse } from 'next/server';
import type { SettingsResponse } from '@/features/logist-kanban/engine/requests/contract';
import { NO_STORE, err, jsonBody, withActor } from '@/features/logist-kanban/engine/requests/http';
import { loadSettings, saveSettings } from '@/features/logist-kanban/engine/requests/repo';

// GET /api/logist-kanban/settings → LogistSettings; PUT частичный SettingsBody (canManageLogistKanban).
export const dynamic = 'force-dynamic';

export async function GET() {
  return withActor('settings', async () => NextResponse.json((await loadSettings()) satisfies SettingsResponse, { headers: NO_STORE }), { zone: false });
}

export async function PUT(req: NextRequest) {
  return withActor('settings:put', async a => {
    if (!a.canManage) return err('Веса и SLA — только руководителю логистики', 403, 'forbidden');
    return NextResponse.json(await saveSettings(await jsonBody(req), a.login), { headers: NO_STORE });
  }, { zone: false });
}

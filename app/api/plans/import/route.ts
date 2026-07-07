import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import * as XLSX from 'xlsx';

interface ConflictItem {
  login: string;
  name: string;
  existing: number;
  incoming: number;
}

interface CleanItem {
  login: string;
  name: string;
  amount: number;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const month = formData.get('month') as string | null;

  if (!file || !month) {
    return NextResponse.json({ error: 'Missing file or month' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }) as unknown[][];

  // Parse rows: col 0 = login, col 1 = name, col 2 = amount; skip header (row 0)
  const parsed: { login: string; name: string; amount: number }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    const login = String(row[0] ?? '').trim();
    if (!login) continue;
    const name = String(row[1] ?? '').trim();
    const rawAmount = row[2];
    if (rawAmount === undefined || rawAmount === null || rawAmount === '') continue;
    const amount = Number(rawAmount);
    if (isNaN(amount)) continue;
    parsed.push({ login, name, amount });
  }

  if (parsed.length === 0) {
    return NextResponse.json({ conflicts: [], clean: [] });
  }

  // Check existing records for this month
  const monthDate = `${month}-01`;
  const db = systemDb();
  const logins = parsed.map(p => p.login);
  const existing = await db.query<{ manager_login: string; plan_shipments: string }>(
    `SELECT manager_login, plan_shipments FROM manager_plans WHERE month = $1 AND manager_login = ANY($2)`,
    [monthDate, logins],
  );
  const existingMap = new Map(existing.rows.map(r => [r.manager_login, parseFloat(r.plan_shipments)]));

  const conflicts: ConflictItem[] = [];
  const clean: CleanItem[] = [];

  for (const p of parsed) {
    if (existingMap.has(p.login)) {
      conflicts.push({ login: p.login, name: p.name, existing: existingMap.get(p.login)!, incoming: p.amount });
    } else {
      clean.push({ login: p.login, name: p.name, amount: p.amount });
    }
  }

  return NextResponse.json({ conflicts, clean });
}

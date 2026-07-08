import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { analyticsDb } from '@/lib/db/clients';

export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const db = analyticsDb();

  const tablesRes = await db.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'sa' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  const tables: { name: string; count: number }[] = [];

  for (const { table_name } of tablesRes.rows) {
    try {
      const countRes = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM sa."${table_name}"`
      );
      tables.push({ name: table_name, count: parseInt(countRes.rows[0].count, 10) });
    } catch {
      tables.push({ name: table_name, count: -1 });
    }
  }

  return NextResponse.json(tables);
}

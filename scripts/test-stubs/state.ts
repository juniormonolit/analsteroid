// Общее состояние заглушек (одно на процесс теста).
export type QueryHandler = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } | undefined;

export interface StubState {
  session: unknown;
  query: QueryHandler;
  queries: { sql: string; params: unknown[] }[];
  invites: { userId: string }[];
  redis: unknown;
}

const g = globalThis as unknown as { __stub?: StubState };
export function stub(): StubState {
  if (!g.__stub) g.__stub = { session: null, query: () => ({ rows: [] }), queries: [], invites: [], redis: null };
  return g.__stub;
}

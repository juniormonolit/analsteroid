// «Большой брат» → «Использование» (поток E): контракт API /api/big-brother/usage ↔ страница. Клиент-безопасно.

export type ReportKind = 'sales' | 'saved' | 'marketing' | 'realizations';

export interface UsageReportRow {
  section: string;              // 'sales/by-managers' | 'sales/saved/<uuid>' | 'marketing/<x>' | 'realizations/<x>'
  label: string;
  kind: ReportKind;
  people30: number;
  people90: number;
  minutes30: number;
  minutes90: number;
  visits: number;               // заходы (mono_view) за 90 дней
  bounceKnown: number;          // заходов, у которых известна длительность
  bounces: number;              // из них «отскок»: < 1 мин, ≤ 1 загрузки, без drill/выгрузки
  lastAt: string | null;
  soleViewer: string | null;    // единственный зритель за 90 дней
}

export interface SavedOrphanRow {
  id: string;
  name: string;
  reportSlug: string;
  owner: string;
  ownerLeft: boolean;           // владелец неактивен в оргструктуре
  shared: boolean;
  createdAt: string;
  visits: number;
  people: number;
  lastAt: string | null;
}

export interface DepthSteps {
  visits: number;
  loaded: number;               // была хоть одна загрузка
  changedParams: number;        // > 1 загрузки с разными параметрами
  changedPeriod: number;        // загрузки с разными периодами
  drilled: number;
  exported: number;
  toManager: number;            // следующим шагом — карточка менеджера /manager/<id>
}

export interface UsageParams {
  loads: number;
  metrics: Array<{ id: string; label: string; loads: number; people: number }>;
  groupings: Array<{ key: string; loads: number }>;
  periodLength: Array<{ bucket: string; loads: number }>;
  scopes: Array<{ key: string; loads: number }>;
}

export interface QualityRow {
  section: string;
  label: string;
  loads: number;
  withTiming: number;           // загрузок с duration_ms
  slow: number;                 // > 10 с
  empty: number;                // rows = 0
  withRows: number;             // загрузок с полем rows
  errors: number;               // report_error
  p50ms: number | null;
}

export interface SurfaceRow {
  surface: string;
  visits: number;
  bounceKnown: number;
  bounces: number;
  minutes: number;
  people: number;
  worst: Array<{ section: string; label: string; visits: number; bounceKnown: number; bounces: number }>;
}

export interface ChangelogFunnelRow {
  id: string;
  title: string;
  publishedAt: string;
  section: string | null;
  seen: number;                 // открыли «Что изменилось?» после публикации
  opened7: number;              // из увидевших — зашли в раздел за 7 дней
  returnedW2: number;           // из зашедших — вернулись на 8–14 день
  weekTwoDone: boolean;         // вторая неделя уже прошла
}

/** С какой даты копится каждый вид данных (null — ещё не начал). */
export interface UsageDataSince {
  journal: string | null;       // любые события
  viewDuration: string | null;  // mono_view.total_ms
  loadTiming: string | null;    // report_load.duration_ms
  loadRows: string | null;      // report_load.rows
  metricIds: string | null;     // report_load.metric_ids
  errors: string | null;        // report_error
  changelogSection: boolean;    // колонка changelog_entries.section
  changelogOpen: string | null; // события changelog_open
}

export interface UsageDto {
  generatedAt: string;
  since: UsageDataSince;
  reports: UsageReportRow[];
  orphans: SavedOrphanRow[];
  depth: DepthSteps;
  depthByReport: Array<{ section: string; label: string } & DepthSteps>;
  params: UsageParams;
  quality: QualityRow[];
  surfaces: SurfaceRow[];
  changelog: ChangelogFunnelRow[];
}

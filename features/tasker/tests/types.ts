// Тесты Задачника (TASKER_SPEC.md «Тесты», миграция 300). Типы общие для API и UI.

export type TestStatus = 'draft' | 'published' | 'archived';
export type QuestionKind = 'single' | 'multi';

export interface TestOption { id: string; text: string; correct: boolean }
export interface TestQuestion {
  id: string;
  kind: QuestionKind;
  text: string;
  imageUrl: string | null;
  /** Пояснение к правильному ответу — видит только тренер (менеджеру не показываем: ответы утекут коллегам). */
  explanation: string;
  options: TestOption[];
}

export interface TestSettings {
  title: string;
  description: string;
  metricId: string | null;
  passPercent: number;
  timeLimitMin: number | null;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  isCertification: boolean;
}

/** Строка списка тестов. */
export interface TestSummary extends TestSettings {
  id: number;
  status: TestStatus;
  questionCount: number;
  version: number | null;
  /** Есть правки, не попавшие в опубликованную версию. */
  hasUnpublished: boolean;
  assigned: number;
  completed: number;
  passed: number;
  avgScore: number | null;
  updatedAt: string;
}

/** Полный тест для редактора (только тем, кто ведёт тесты). */
export interface TestFull extends TestSummary { questions: TestQuestion[] }

export interface TestsListResponse {
  tests: TestSummary[];
  canManage: boolean;
  canAssign: boolean;
}
export interface TestResponse { test: TestFull }
export interface TestSaveRequest extends Partial<TestSettings> {
  questions?: TestQuestion[];
  /** Сменить статус: publish = опубликовать текущую копию (новая версия, если по старой уже есть попытки). */
  action?: 'publish' | 'archive' | 'unarchive';
}

// ── Назначения и результаты ────────────────────────────────────────────────

export type AssignmentState = 'assigned' | 'in_progress' | 'passed' | 'failed' | 'overdue' | 'cancelled';

export interface TestAttemptResult {
  id: number;
  version: number;
  startedAt: string;
  submittedAt: string | null;
  autoSubmitted: boolean;
  scorePercent: number | null;
  correct: number | null;
  total: number | null;
  passed: boolean | null;
}

export interface TestAssignmentRow {
  id: number;
  testId: number;
  testTitle: string;
  manager: { id: number; name: string };
  departmentName: string | null;
  source: 'manual' | 'training';
  trainingEventId: number | null;
  trainingTitle: string | null;
  assignedBy: string | null;
  assignedAt: string;
  dueAt: string;
  retakesAllowed: number;
  state: AssignmentState;
  attempts: TestAttemptResult[];
  /** Последняя завершённая попытка — она идёт в результаты. */
  last: TestAttemptResult | null;
  canRetake: boolean;
}

export interface TestQuestionStat { questionId: string; text: string; answered: number; wrong: number }

export interface TestResultsResponse {
  test: TestSummary;
  rows: TestAssignmentRow[];
  hardest: TestQuestionStat[];
  /** Видит всех (тренер) или только своих (РОП). */
  scope: 'all' | 'own';
}

export interface TestAssignRequest {
  managerIds?: number[];
  departmentIds?: string[];
  dueDays?: number;
}
export interface TestAssignResponse { created: number; skipped: number }

export interface TestDeptOption { id: string; name: string; path: string | null }
export interface TestAssignOptionsResponse {
  managers: { id: number; name: string; departmentName: string | null }[];
  departments: TestDeptOption[];
}

// ── Обучения ───────────────────────────────────────────────────────────────

export interface TrainingTestLink { eventId: number; testId: number; testTitle: string; afterDays: number; dueDays: number }
export interface TrainingTestStats {
  eventId: number;
  link: TrainingTestLink | null;
  assigned: number;
  completed: number;
  passed: number;
  avgScore: number | null;
}
export interface TrainingTestStatsResponse { stats: TrainingTestStats[] }
export interface TrainingTestPeriodRow extends TrainingTestStats { title: string; startsAt: string; testTitles: string[] }
export interface TrainingTestPeriodResponse { rows: TrainingTestPeriodRow[] }

// ── ЛК менеджера ───────────────────────────────────────────────────────────

export interface MyTestRow {
  assignmentId: number;
  testTitle: string;
  description: string;
  questionCount: number;
  timeLimitMin: number | null;
  passPercent: number;
  dueAt: string;
  state: AssignmentState;
  trainingTitle: string | null;
  last: TestAttemptResult | null;
  canStart: boolean;
}
export interface MyTestsResponse { rows: MyTestRow[]; pending: number }

/** Вопрос для прохождения — без признаков правильности и пояснений. */
export interface TakeQuestion { id: string; kind: QuestionKind; text: string; imageUrl: string | null; options: { id: string; text: string }[] }

export interface TakeAttempt {
  id: number;
  startedAt: string;
  deadlineAt: string | null;
  questions: TakeQuestion[];
  answers: Record<string, string[]>;
}

export interface TakeReviewItem { n: number; text: string; correct: boolean }

export interface MyTestDetailResponse {
  row: MyTestRow;
  attempt: TakeAttempt | null;
  /** После отправки: по каким вопросам ошибка (без правильных ответов). */
  review: TakeReviewItem[] | null;
}

export interface ManagerTestsResponse { rows: TestAssignmentRow[] }

import { MyTestsPage } from '@/features/tasker/tests/ui/MyTestsPage';

// ЛК → «Тесты» (TASKER_SPEC «Тесты»): назначенные и пройденные тесты менеджера. Правами не гейтится (ЛК открыт
// всем вошедшим) — API отдаёт только свои назначения (по bitrix id сессии).
export const metadata = {
  title: 'Тесты — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default function Page() {
  return <MyTestsPage />;
}

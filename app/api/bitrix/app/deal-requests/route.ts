import { NextRequest } from 'next/server';
import { bitrixAppEntry, bitrixAppHtml } from '@/lib/bitrix/appEntry';
import { bxApp } from '@/lib/bitrix/appToken';

// Вкладка «Запросы логисту» в карточке сделки Битрикса (CRM_DEAL_DETAIL_TAB, владелец 19.11).
// Битрикс открывает URL в iframe POST-запросом: AUTH_ID сотрудника, PLACEMENT и PLACEMENT_OPTIONS = {"ID":"<id сделки>"}.
// Вход — общий bitrixAppEntry (AUTH_ID → сессия → /bx/deal-requests?deal=…; браузер зарезал cookie — одноразовый
// ключ t для обычной вкладки). До входа — crm.deal.get ТОКЕНОМ СОТРУДНИКА: Битрикс отвечает по его правам, подделать
// ID в POST и открыть чужую сделку не выйдет (как у вкладки «Карточка клиента»). Видимость самих запросов — правила
// канбана (менеджер — свои, логист — свои очереди, руководство — зона), см. GET /api/logist-kanban/deal/:id.
// Привязка вкладки к порталу — /api/admin/bitrix/logist-deal-tab (супер-админ, «Настройки»).

export function POST(req: NextRequest) {
  return bitrixAppEntry(req, '/bx/deal-requests', 'Загружаем запросы логисту…', async ({ authId, placement, options }) => {
    const id = String(options.ID ?? '');
    if (placement !== 'CRM_DEAL_DETAIL_TAB' || !/^\d{1,12}$/.test(id)) {
      return { error: 'Эта вкладка работает в карточке сделки.', status: 400 };
    }
    const check = await bxApp(authId, 'crm.deal.get', { id: Number(id) });
    if (!check.ok) {
      console.warn('[bitrix/deal-requests] нет доступа к сделке', { id, error: check.error });
      return /scope/i.test(check.error)
        ? { error: 'У приложения «Монолитика» нет права на CRM. Администратору портала: добавьте приложению право «CRM» и переустановите его.', status: 403 }
        : { error: 'Эта сделка вам недоступна в Битриксе.', status: 403 };
    }
    return { params: { deal: id } };
  });
}

export function GET() {
  return bitrixAppHtml('<p>Это вкладка «Запросы логисту» приложения «Монолитика» для карточки сделки Битрикс24.</p>');
}

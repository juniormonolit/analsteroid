import { redirect } from 'next/navigation';

// Опрос по погоде переехал внутрь настроек «Аналитика» (правка владельца 09.09:
// это функция того же бота, а не отдельный бот). Старый адрес остаётся редиректом —
// на него могли остаться закладки.
export default function Page() {
  redirect('/settings/bots/analitik');
}

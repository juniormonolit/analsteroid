import { redirect } from 'next/navigation';

// «Что предложить» переехал из «Настроек» в «Ещё» (правка владельца 22.10) —
// старые ссылки на /settings/cross-sell ведут на новый адрес.
export default function CrossSellMovedPage() {
  redirect('/cross-sell');
}

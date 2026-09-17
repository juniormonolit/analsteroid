// Типы и подписи ручных контактов — без импортов БД: этот файл тянут клиентские
// компоненты (QueueParts.tsx), а contacts.ts с pg в клиентский бандл нельзя
// (сборка 17.09 упала на «Can't resolve 'dns'/'fs'/'net'»).
export type ContactChannel = 'messenger' | 'email' | 'meeting' | 'phone_other';
export const CONTACT_CHANNEL_LABELS: Record<ContactChannel, string> = {
  messenger: 'Мессенджер',
  email: 'Почта',
  meeting: 'Лично / на объекте',
  phone_other: 'Звонок с другого номера',
};

export interface CustomerContact {
  contactedAt: string;   // ISO
  channel: ContactChannel;
  note: string;
  createdBy: string;
}

export type ExclusionStatus = 'pending' | 'approved' | 'rejected';
export interface ExclusionRequest {
  id: number;
  clientKey: string;
  managerBitrixId: string;
  requestedBy: string;
  reason: string;
  status: ExclusionStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  createdAt: string;
}

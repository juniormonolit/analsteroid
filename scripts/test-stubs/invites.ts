import { stub } from './state.ts';
export async function createAndSendInvite(userId: string) {
  stub().invites.push({ userId });
  return { link: 'https://example.test/invite/SECRET-LINK', delivered: false };
}

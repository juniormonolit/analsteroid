import { stub } from './state.ts';
export const SESSION_COOKIE = 'as_session';
export const SESSION_TTL_DAYS = 7;
export async function getSession() { return stub().session; }
export async function createSession() { return 'test-session-token'; }

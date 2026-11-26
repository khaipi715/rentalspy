import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined;

/** null when the site is built without Supabase settings (public data still works; adding is disabled). */
export const sb: SupabaseClient | null = url && key ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

export type Status = { signed_in: boolean; confirmed_18: boolean; is_admin: boolean; unlocked: boolean; entries: number };

export async function getStatus(): Promise<Status | null> {
  if (!sb) return null;
  const { data: s } = await sb.auth.getSession();
  if (!s.session) return { signed_in: false, confirmed_18: false, is_admin: false, unlocked: false, entries: 0 };
  const { data, error } = await sb.rpc('my_status');
  if (error) return null;
  return data as Status;
}

/** Make sure there's a session. No email needed: an anonymous account is created on this device. */
export async function ensureSession() {
  if (!sb) throw new Error('RentalSpy is not connected to its database yet.');
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session;
  const { data: d, error } = await sb.auth.signInAnonymously();
  if (error) throw new Error('Could not start a session: ' + error.message);
  return d.session;
}

export function niceError(e: unknown): string {
  const m = (e as { message?: string })?.message || String(e);
  if (/duplicate key|unique/i.test(m)) return "You've already added this address. You can delete your old entry on My places and add it again.";
  if (/check constraint/i.test(m)) return 'Some answers look out of range. Please check the numbers.';
  return m.replace(/^.*?ERROR:\s*/, '');
}

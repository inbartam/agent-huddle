/**
 * Settings → Phone access (M6, F26): the `phone.addresses` question on `huddle:query`. Like settings-query.ts, the
 * answer is checked here: a result of the wrong shape reads as `failed`, a missing bridge as "unavailable in this
 * build", and the core's own refusals (sample data: `unsupported`) come through with their message.
 */
import type { PhoneAddress, QueryResult } from '@huddle/shared';
import { ask } from './history-query.js';
import { QUERY_FAILED, type QueryFn } from './query.js';

type Failed = Extract<QueryResult, { ok: false }>;

const failed: Failed = { ok: false, code: 'failed', message: QUERY_FAILED };

export type AddressesAnswer = { ok: true; addresses: PhoneAddress[] } | Failed;

/** The private LAN IPv4 addresses phone access may listen on, read from the adapters now. */
export async function loadPhoneAddresses(query: QueryFn | null): Promise<AddressesAnswer> {
  const r = await ask(query, { type: 'phone.addresses' });
  if (!r.ok) return r;
  const list: unknown = r.r['addresses'];
  if (!Array.isArray(list)) return failed;
  const addresses: PhoneAddress[] = [];
  for (const a of list.slice(0, 64)) {
    if (typeof a !== 'object' || a === null) return failed;
    const v = a as Record<string, unknown>;
    if (typeof v['ip'] !== 'string' || typeof v['interfaceName'] !== 'string') return failed;
    addresses.push({ ip: v['ip'], interfaceName: v['interfaceName'] });
  }
  return { ok: true, addresses };
}

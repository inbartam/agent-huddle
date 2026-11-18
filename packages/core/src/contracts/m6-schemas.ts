/**
 * zod schemas for the M6 contracts (F26 phone access, F27 self-report registration): the commands and the read-only
 * queries. Same rules as the
 * M3-M5 schema files: `z.looseObject` keeps unknown fields, a wrong shape fails `safeParse` (the `parse*` helpers
 * return null, never throw); desktop main joins them into its unions (`validate.ts`).
 *
 * The address is checked for shape here (dotted-quad IPv4); whether it is a private LAN address this computer has is
 * checked by the core when it enables (phone/address.ts), because that depends on the adapters at that moment.
 */
import { z } from 'zod';
import { PHONE_PORT_MAX, PHONE_PORT_MIN, type HuddleCommand, type HuddleQuery } from '@huddle/shared';
import { parseIPv4 } from '../phone/address.js';
import { command } from './schema-parts.js';

const ipv4 = z
  .string()
  .max(15)
  .refine((s) => parseIPv4(s) !== null, { message: 'not an IPv4 address' });
const port = z.number().int().min(PHONE_PORT_MIN).max(PHONE_PORT_MAX);
/** Device ids are 32 lower-case hex characters (phone/devices.ts); 'all' revokes every phone. */
const deviceIdOrAll = z.union([z.string().regex(/^[0-9a-f]{32}$/), z.literal('all')]);
/** A self-report preview's fingerprint (sha256, hex; setup/mcp-register.ts). */
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);

export const m6CommandSchemas = [
  command('phone.enable', { ip: ipv4, port: port.optional() }),
  command('phone.disable', {}),
  command('phone.pair', {}),
  command('phone.revoke', { deviceId: deviceIdOrAll }),
  // F27 (ADR-025): the opt-in registration of the self-report MCP server for attached sessions.
  command('setup.selfReport.register', { fingerprint }),
  command('setup.selfReport.unregister', { fingerprint }),
] as const;

export const M6_COMMAND_TYPES = [
  'phone.enable',
  'phone.disable',
  'phone.pair',
  'phone.revoke',
  'setup.selfReport.register',
  'setup.selfReport.unregister',
] as const satisfies readonly HuddleCommand['type'][];

export type M6CommandType = (typeof M6_COMMAND_TYPES)[number];
export type M6Command = Extract<HuddleCommand, { type: M6CommandType }>;

const m6CommandSchema = z.discriminatedUnion('type', [...m6CommandSchemas]);

/** Parse an untrusted M6 command. Returns null instead of throwing. */
export function parseM6Command(input: unknown): M6Command | null {
  const result = m6CommandSchema.safeParse(input);
  if (!result.success) return null;
  const parsed: M6Command = result.data;
  return parsed;
}

const M6_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(M6_COMMAND_TYPES);

export function isM6Command(cmd: { type: string }): cmd is M6Command {
  return M6_COMMAND_TYPE_SET.has(cmd.type);
}

// --- query ----------------------------------------------------------------------------------------------------------

export const m6QuerySchemas = [
  command('phone.addresses', {}),
  command('setup.selfReportPreview', { mode: z.enum(['register', 'unregister']) }),
] as const;

export type M6Query = Extract<HuddleQuery, { type: 'phone.addresses' | 'setup.selfReportPreview' }>;

export function isM6Query(q: { type: string }): q is M6Query {
  return q.type === 'phone.addresses' || q.type === 'setup.selfReportPreview';
}

const m6QuerySchema = z.discriminatedUnion('type', [...m6QuerySchemas]);

/** Parse an untrusted M6 query. Returns null instead of throwing. */
export function parseM6Query(input: unknown): M6Query | null {
  const result = m6QuerySchema.safeParse(input);
  const parsed: M6Query | null = result.success ? result.data : null;
  return parsed;
}

/**
 * Which addresses phone access may listen on (M6, F26). Pure over what `os.networkInterfaces()` returned, so tests
 * pass their own adapters.
 *
 * Only a private LAN IPv4 the computer has right now: RFC 1918 (10/8, 172.16/12, 192.168/16) or link-local
 * (169.254/16), on a non-internal adapter. Never 0.0.0.0 (every adapter), never loopback (the hook port's world, and
 * it would make the Host check meaningless), never a public address (the listener would face the internet).
 */
import type { NetworkInterfaceInfo } from 'node:os';
import type { PhoneAddress } from '@huddle/shared';

/** Dotted-quad IPv4 with no leading zeros, or null. */
export function parseIPv4(text: string): [number, number, number, number] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  const [a, b, c, d] = out;
  return a === undefined || b === undefined || c === undefined || d === undefined ? null : [a, b, c, d];
}

/** RFC 1918 or link-local IPv4. */
export function isPrivateLanIPv4(text: string): boolean {
  const ip = parseIPv4(text);
  if (ip === null) return false;
  const [a, b] = ip;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** The private LAN IPv4 addresses of non-internal adapters, sorted by adapter name then address; no duplicates. */
export function lanAddresses(interfaces: NetworkInterfaces): PhoneAddress[] {
  const out: PhoneAddress[] = [];
  const seen = new Set<string>();
  for (const [interfaceName, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      // Node 18+ reports family as 'IPv4'; some versions reported the number 4.
      const family: unknown = info.family;
      if ((family !== 'IPv4' && family !== 4) || info.internal) continue;
      if (!isPrivateLanIPv4(info.address) || seen.has(info.address)) continue;
      seen.add(info.address);
      out.push({ ip: info.address, interfaceName });
    }
  }
  return out.sort((x, y) =>
    x.interfaceName === y.interfaceName ? (x.ip < y.ip ? -1 : 1) : x.interfaceName < y.interfaceName ? -1 : 1,
  );
}

/** Why an address is refused for phone access, or null when it may be used now. */
export function addressProblem(ip: string, interfaces: NetworkInterfaces): string | null {
  if (parseIPv4(ip) === null) return 'That is not an IPv4 address.';
  if (!isPrivateLanIPv4(ip)) {
    return 'Phone access listens only on a private home or office network address (10.x, 172.16-31.x, 192.168.x).';
  }
  if (!lanAddresses(interfaces).some((a) => a.ip === ip)) {
    return 'That address is not one of this computer’s network addresses right now.';
  }
  return null;
}

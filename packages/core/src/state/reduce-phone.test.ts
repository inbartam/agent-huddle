/**
 * Phone events in the reducer (M6, F26): `phone.access_changed` and `phone.device_changed` build `HuddleState.phone`,
 * leave the tree alone (their envelope is the Huddle's own phone session), and survive a JSON round trip.
 */
import { describe, expect, it } from 'vitest';
import type { EventOfType, HuddleEvent } from '@huddle/shared';
import { fixtureEvents } from '../test/replay-fixture.js';
import { PHONE_SESSION_ID } from './huddle-sessions.js';
import { reduce, replay, toHuddleState } from './reduce.js';

let n = 0;
const base = (ts: number) => {
  n += 1;
  return {
    id: `ph-${String(n)}`,
    ts,
    sessionId: PHONE_SESSION_ID,
    agentKey: PHONE_SESSION_ID,
    source: 'huddle' as const,
  };
};
const access = (ts: number, enabled: boolean, reason?: EventOfType<'phone.access_changed'>['reason']) =>
  ({
    ...base(ts),
    type: 'phone.access_changed',
    enabled,
    url: enabled ? 'http://192.168.1.23:47835/' : null,
    ...(reason !== undefined ? { reason } : {}),
  }) satisfies EventOfType<'phone.access_changed'>;
const device = (
  ts: number,
  deviceId: string,
  change: EventOfType<'phone.device_changed'>['change'],
  extra: Partial<EventOfType<'phone.device_changed'>> = {},
) =>
  ({
    ...base(ts),
    type: 'phone.device_changed',
    deviceId,
    name: 'Pixel 9',
    change,
    ...extra,
  }) satisfies EventOfType<'phone.device_changed'>;

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

describe('reduce: phone events', () => {
  it('builds phone state from access and device events', () => {
    const s = replay([
      device(1, A, 'known', { pairedAt: 0 }),
      access(10, true, 'user'),
      device(20, B, 'paired', { pairedAt: 20 }),
      device(30, B, 'connected'),
    ]);
    expect(toHuddleState(s).phone).toEqual({
      enabled: true,
      url: 'http://192.168.1.23:47835/',
      changedAt: 10,
      reason: 'user',
      devices: [
        { deviceId: A, name: 'Pixel 9', pairedAt: 0, lastSeenAt: null, connected: false },
        { deviceId: B, name: 'Pixel 9', pairedAt: 20, lastSeenAt: 30, connected: true },
      ],
    });
    const off = reduce(s, access(40, false, 'idle'));
    expect(off.phone).toMatchObject({ enabled: false, url: null, reason: 'idle', changedAt: 40 });
    expect(off.phone?.devices.every((d) => !d.connected)).toBe(true);
    const revoked = reduce(off, device(50, B, 'revoked', { reason: 'user' }));
    expect(revoked.phone?.devices.map((d) => d.deviceId)).toEqual([A]);
    expect(JSON.parse(JSON.stringify(toHuddleState(revoked)))).toEqual(toHuddleState(revoked));
  });

  it('ignores a connect, disconnect or revoke for a phone it does not list, and an unknown change', () => {
    const s = replay([access(1, true)]);
    expect(reduce(s, device(2, A, 'connected')).phone).toEqual(s.phone);
    expect(reduce(s, device(3, A, 'revoked')).phone).toEqual(s.phone);
    const odd = { ...device(4, A, 'paired'), change: 'teleported' } as unknown as HuddleEvent;
    expect(reduce(s, odd).phone).toEqual(s.phone);
  });

  it('leaves the tree of a recorded session exactly as without them, and makes no node for the phone session', () => {
    const events = fixtureEvents('permission-allow.jsonl');
    const plain = toHuddleState(replay(events));
    const mixed: HuddleEvent[] = [];
    events.forEach((e, i) => {
      mixed.push(e);
      if (i === 2) mixed.push(access(e.ts, true, 'user'), device(e.ts, A, 'paired'));
      if (i === 6) mixed.push(device(e.ts, A, 'connected'));
    });
    const withPhone = toHuddleState(replay(mixed));
    expect(withPhone.agents).toEqual(plain.agents);
    expect(withPhone.rootKeys).toEqual(plain.rootKeys);
    expect(withPhone.inbox).toEqual(plain.inbox);
    expect(Object.hasOwn(withPhone.agents, PHONE_SESSION_ID)).toBe(false);
    expect(withPhone.phone?.devices).toHaveLength(1);
  });

  it('a state without phone events has no phone field (older logs replay as before)', () => {
    expect('phone' in toHuddleState(replay(fixtureEvents('single-agent.jsonl')))).toBe(false);
  });

  it('carries the optional via on approval.resolved without changing the inbox handling', () => {
    const events = fixtureEvents('permission-allow.jsonl');
    const withVia = events.map((e) => (e.type === 'approval.resolved' ? { ...e, via: 'phone' as const } : e));
    expect(toHuddleState(replay(withVia)).inbox).toEqual(toHuddleState(replay(events)).inbox);
  });
});

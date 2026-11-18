// @vitest-environment happy-dom
/**
 * Settings → Phone access (M6, F26) with real DOM events: the addresses come from `phone.addresses`, Turn on sends
 * `phone.enable` with the picked address and port, Pair a phone shows the code from the command result and clears it
 * when a phone pairs, Revoke sends `phone.revoke`, Revoke all asks first, and sample data shows its refusal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_SETTINGS,
  type CommandResult,
  type HuddleCommand,
  type HuddleQuery,
  type HuddleState,
  type PhoneState,
  type QueryResult,
} from '@huddle/shared';
import { PhoneSettings } from './components/PhoneSettings.js';
import { byText, click, flush, mount, type, type Mounted } from './testing/dom.js';
import { interactState } from './testing/interact-fixture.js';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const DEV_A = 'a'.repeat(32);
const DEV_B = 'b'.repeat(32);
const ADDRS = [
  { ip: '192.168.1.20', interfaceName: 'Wi-Fi' },
  { ip: '10.0.0.5', interfaceName: 'Ethernet' },
];

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

function stateWith(phone?: PhoneState): HuddleState {
  const s = interactState();
  s.settings = { ...DEFAULT_USER_SETTINGS, phone: { ip: null, port: 47835 } };
  if (phone) s.phone = phone;
  return s;
}

const ON: PhoneState = {
  enabled: true,
  url: 'http://192.168.1.20:47835/',
  changedAt: NOW,
  reason: 'user',
  devices: [{ deviceId: DEV_A, name: 'iPhone', pairedAt: NOW - 1000, lastSeenAt: null, connected: false }],
};

function harness(answer: (cmd: HuddleCommand) => CommandResult, queryAnswer?: QueryResult) {
  const sent: HuddleCommand[] = [];
  const asked: HuddleQuery[] = [];
  return {
    sent,
    asked,
    onCommand: (cmd: HuddleCommand) => {
      sent.push(cmd);
      return Promise.resolve(answer(cmd));
    },
    query: (q: HuddleQuery): Promise<QueryResult> => {
      asked.push(q);
      return Promise.resolve(queryAnswer ?? { ok: true, type: 'phone.addresses', addresses: ADDRS });
    },
  };
}

describe('Phone access settings, interactions', () => {
  it('asks for the addresses, then turns on with the picked address and the typed port', async () => {
    const h = harness(() => ({ ok: true, detail: 'http://10.0.0.5:50000/' }));
    mounted = await mount(<PhoneSettings state={stateWith()} onCommand={h.onCommand} query={h.query} now={NOW} />);
    await flush();
    expect(h.asked).toEqual([{ type: 'phone.addresses' }]);
    const select = mounted.container.querySelector<HTMLSelectElement>('#phone-address');
    expect(select?.options.length).toBe(2);
    if (select) {
      select.value = '10.0.0.5';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await type(mounted.container.querySelector('#phone-port'), '50000');
    await click(byText(mounted.container, 'button', 'Turn on'));
    await flush();
    expect(h.sent).toEqual([{ type: 'phone.enable', ip: '10.0.0.5', port: 50000 }]);
  });

  it('keeps the newest address answer when an older one lands after it', async () => {
    const h = harness(() => ({ ok: true }));
    const pending: ((r: QueryResult) => void)[] = [];
    const query = (): Promise<QueryResult> =>
      new Promise((resolve) => {
        pending.push(resolve);
      });
    mounted = await mount(<PhoneSettings state={stateWith()} onCommand={h.onCommand} query={query} now={NOW} />);
    await click(byText(mounted.container, 'button', 'Look again'));
    expect(pending).toHaveLength(2);
    const answer = (ip: string): QueryResult => ({
      ok: true,
      type: 'phone.addresses',
      addresses: [{ ip, interfaceName: 'Wi-Fi' }],
    });
    pending[1]?.(answer('10.0.0.5'));
    await flush();
    pending[0]?.(answer('192.168.1.20'));
    await flush();
    const select = mounted.container.querySelector<HTMLSelectElement>('#phone-address');
    expect([...(select?.options ?? [])].map((o) => o.value)).toEqual(['10.0.0.5']);
  });

  it('refuses a port out of range without sending', async () => {
    const h = harness(() => ({ ok: true }));
    mounted = await mount(<PhoneSettings state={stateWith()} onCommand={h.onCommand} query={h.query} now={NOW} />);
    await flush();
    await type(mounted.container.querySelector('#phone-port'), '80');
    await click(byText(mounted.container, 'button', 'Turn on'));
    await flush();
    expect(h.sent).toEqual([]);
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe('Pick a port from 1024 to 65535.');
  });

  it('shows the code from Pair a phone and clears it when a phone pairs', async () => {
    const h = harness((cmd) =>
      cmd.type === 'phone.pair'
        ? { ok: true, detail: '654321', phonePairing: { code: '654321', expiresAt: NOW + 120_000 } }
        : { ok: true },
    );
    const el = (s: HuddleState) => <PhoneSettings state={s} onCommand={h.onCommand} query={h.query} now={NOW} />;
    mounted = await mount(el(stateWith(ON)));
    await click(byText(mounted.container, 'button', 'Pair a phone'));
    await flush();
    expect(h.sent).toEqual([{ type: 'phone.pair' }]);
    expect(mounted.container.querySelector('.phone-code-digits')?.textContent).toBe('654 321');
    expect(mounted.container.querySelector('.phone-countdown')?.textContent).toBe('2:00 left');

    const paired: PhoneState = {
      ...ON,
      devices: [
        ...ON.devices,
        { deviceId: DEV_B, name: 'Pixel', pairedAt: NOW + 5000, lastSeenAt: null, connected: false },
      ],
    };
    await mounted.render(el(stateWith(paired)));
    await flush();
    expect(mounted.container.querySelector('.phone-code-digits')).toBeNull();
    expect(mounted.container.textContent).toContain('Paired: Pixel.');
  });

  it('revokes one phone in one click, and all phones only after the question', async () => {
    const h = harness(() => ({ ok: true }));
    const two: PhoneState = {
      ...ON,
      devices: [...ON.devices, { deviceId: DEV_B, name: 'Pixel', pairedAt: null, lastSeenAt: null, connected: true }],
    };
    mounted = await mount(<PhoneSettings state={stateWith(two)} onCommand={h.onCommand} query={h.query} now={NOW} />);
    await click(mounted.container.querySelector('[aria-label="Revoke Pixel"]'));
    await flush();
    expect(h.sent).toEqual([{ type: 'phone.revoke', deviceId: DEV_B }]);
    await click(byText(mounted.container, 'button', 'Revoke all…'));
    expect(h.sent).toHaveLength(1);
    await click(byText(mounted.container, 'button', 'Revoke all'));
    await flush();
    expect(h.sent[1]).toEqual({ type: 'phone.revoke', deviceId: 'all' });
  });

  it('shows a refusal from the core (sample data) in words', async () => {
    const h = harness(
      () => ({ ok: false, code: 'unsupported', message: 'Phone access is not available with sample data.' }),
      { ok: false, code: 'unsupported', message: 'Phone access is not available with sample data.' },
    );
    mounted = await mount(<PhoneSettings state={stateWith()} onCommand={h.onCommand} query={h.query} now={NOW} />);
    await flush();
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe(
      'Phone access is not available with sample data.',
    );
  });
});

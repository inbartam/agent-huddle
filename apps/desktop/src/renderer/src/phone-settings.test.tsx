/**
 * Settings → Phone access (M6, F26), rendered to a string: off (address picker, port, reasons for off, empty and
 * failed address lists), on (URL, Pair a phone, Turn off), a pairing code with its countdown, the paired phones with
 * Revoke and Revoke all, hostile device names as text; and the title bar's phone mark. The pure helpers too.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS, type HuddleState, type PhoneState } from '@huddle/shared';
import { PhoneSettings, type PhoneSettingsProps } from './components/PhoneSettings.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { TitleBar } from './components/Shell.js';
import { loadPhoneAddresses } from './phone-query.js';
import { interactState } from './testing/interact-fixture.js';
import { XSS } from './testing/fixture.js';
import {
  countdownWords,
  offReasonWords,
  pairingOutcome,
  parsePort,
  phoneMark,
  preferredAddress,
  PHONE_SETTINGS_WORDS as W,
} from './view/phone.js';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const ok = () => Promise.resolve({ ok: true as const });
const noop = () => undefined;
const ADDRS = [
  { ip: '192.168.1.20', interfaceName: 'Wi-Fi' },
  { ip: '10.0.0.5', interfaceName: 'Ethernet' },
];
const DEV_A = 'a'.repeat(32);
const DEV_B = 'b'.repeat(32);

function withPhone(phone: PhoneState | undefined, ip: string | null = null, port = 47835): HuddleState {
  const state = interactState();
  state.settings = { ...DEFAULT_USER_SETTINGS, phone: { ip, port } };
  if (phone !== undefined) state.phone = phone;
  return state;
}

const ON: PhoneState = {
  enabled: true,
  url: 'http://192.168.1.20:47835/',
  changedAt: NOW - 60_000,
  reason: 'user',
  devices: [
    { deviceId: DEV_A, name: 'iPhone', pairedAt: NOW - 86_400_000, lastSeenAt: NOW - 30_000, connected: true },
    { deviceId: DEV_B, name: XSS, pairedAt: null, lastSeenAt: null, connected: false },
  ],
};

function render(state: HuddleState, initial: PhoneSettingsProps['initial'] = {}) {
  return renderToStaticMarkup(
    <PhoneSettings
      state={state}
      onCommand={ok}
      query={null}
      now={NOW}
      initial={{ addresses: { kind: 'loaded', addresses: ADDRS }, ...initial }}
    />,
  );
}

describe('Settings, Phone access: off', () => {
  it('says what it does and the risk, and is off with nothing paired by default', () => {
    const html = render(withPhone(undefined));
    expect(html).toContain('plain HTTP on your home network: use it only on a network you trust');
    expect(html).toContain('turns itself off after 8 hours unused');
    expect(html).toMatch(/role="status"><span class="glyph" aria-hidden="true">○<\/span> Off/);
    expect(html).toContain(W.noDevices);
    expect(html).not.toContain('Pair a phone');
  });

  it('offers the addresses with their adapter names, the last one chosen first, and the port', () => {
    const html = render(withPhone(undefined, '10.0.0.5', 50000));
    expect(html).toContain('<option value="192.168.1.20">Wi-Fi · 192.168.1.20</option>');
    expect(html).toContain('<option value="10.0.0.5" selected="">Ethernet · 10.0.0.5</option>');
    expect(html).toMatch(/id="phone-port"[^>]*value="50000"/);
    expect(html).toContain('>Turn on</button>');
  });

  it('explains an empty address list, keeps Turn on off with a reason, and shows a failed lookup', () => {
    const empty = render(withPhone(undefined), { addresses: { kind: 'loaded', addresses: [] } });
    expect(empty).toContain(W.noAddress);
    expect(empty).toMatch(/aria-disabled="true" title="Pick an address first\."[^>]*>Turn on</);
    const failed = render(withPhone(undefined), {
      addresses: { kind: 'error', message: 'Phone access is not available with sample data.' },
    });
    expect(failed).toContain('role="alert">Phone access is not available with sample data.');
    const loading = render(withPhone(undefined), { addresses: { kind: 'loading' } });
    expect(loading).toContain(W.looking);
  });

  it('says why it went off: idle, address gone, failed; nothing for the user turning it off', () => {
    const off = (reason: PhoneState['reason']) =>
      render(withPhone({ enabled: false, url: null, changedAt: NOW, reason, devices: [] }));
    expect(off('idle')).toContain('turned itself off after 8 hours without a phone using it');
    expect(off('address_gone')).toContain('its address is no longer on this computer');
    expect(off('failed')).toContain('could not keep listening');
    expect(off('user')).not.toContain('phone-reason');
  });

  it('keeps paired phones listed while off, with Revoke', () => {
    const html = render(withPhone({ ...ON, enabled: false, url: null, reason: 'user' }));
    expect(html).toContain('>iPhone</span>');
    expect(html).toContain('aria-label="Revoke iPhone"');
  });
});

describe('Settings, Phone access: on', () => {
  it('shows the URL to type, Pair a phone and Turn off, and no address picker', () => {
    const html = render(withPhone(ON));
    expect(html).toContain('On your phone, open');
    expect(html).toContain('<span class="code phone-url" id="phone-url">http://192.168.1.20:47835/</span>');
    expect(html).toContain('>Pair a phone</button>');
    expect(html).toContain('>Turn off</button>');
    expect(html).not.toContain('id="phone-address"');
  });

  it('shows a pairing code split in two with a countdown', () => {
    const html = render(withPhone(ON), {
      pairing: { code: '123456', expiresAt: NOW + 102_000, knownDeviceIds: [DEV_A, DEV_B] },
    });
    expect(html).toContain('Type this code on the phone');
    expect(html).toContain('>123 456</p>');
    expect(html).toContain('1:42 left');
  });

  it('shows no code once it ran out', () => {
    const html = render(withPhone(ON), {
      pairing: { code: '123456', expiresAt: NOW - 1, knownDeviceIds: [DEV_A, DEV_B] },
    });
    expect(html).not.toContain('123 456');
  });

  it('lists the paired phones: name as text, paired, last seen, connected dot and word', () => {
    const html = render(withPhone(ON));
    expect(html).toContain('<span class="glyph" aria-hidden="true">●</span> connected');
    expect(html).toContain('<span class="glyph" aria-hidden="true">○</span> not connected');
    expect(html).toContain('paired 15 Nov');
    expect(html).toContain('last seen —');
    expect(html).toContain('paired —');
    // A device name came from the network: escaped text, never markup.
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('>Revoke all…</button>');
  });

  it('asks before revoking all', () => {
    const html = render(withPhone(ON), { confirmRevokeAll: true });
    expect(html).toContain('role="group" aria-labelledby="phone-revoke-all-q"');
    expect(html).toContain('Revoke all 2 paired phones?');
    expect(html).toContain('class="control control-danger">Revoke all</button>');
  });
});

describe('Settings panel and title bar', () => {
  it('has a Phone access section noted off by default', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        state={withPhone(undefined)}
        onCommand={ok}

        now={NOW}
        phoneInitial={{ addresses: { kind: 'loaded', addresses: ADDRS } }}
      />,
    );
    expect(html).toContain('id="settings-phone"');
    expect(html).toMatch(/Phone access<span class="section-note">Off by default<\/span>/);
  });

  it('marks the title bar: filled while a phone is connected, outline while on, nothing while off', () => {
    const bar = (s: HuddleState) => renderToStaticMarkup(<TitleBar counts={null} onSearch={noop} state={s} />);
    expect(bar(withPhone(ON))).toContain('<span class="glyph" aria-hidden="true">▮</span> phone connected');
    const none = { ...ON, devices: ON.devices.map((d) => ({ ...d, connected: false })) };
    expect(bar(withPhone(none))).toContain('▯</span> phone access on');
    expect(bar(withPhone({ ...ON, enabled: false }))).not.toContain('phone-mark');
    expect(bar(withPhone(undefined))).not.toContain('phone-mark');
  });
});

describe('phone settings helpers', () => {
  it('parses ports in range only', () => {
    expect(parsePort('47835')).toEqual({ port: 47835 });
    expect(parsePort(' 1024 ')).toEqual({ port: 1024 });
    for (const bad of ['80', '65536', '4.5', '', 'abc', '-1']) expect(parsePort(bad)).toHaveProperty('error');
  });

  it('prefers the last address when it is still there', () => {
    expect(preferredAddress(ADDRS, '10.0.0.5')).toBe('10.0.0.5');
    expect(preferredAddress(ADDRS, '172.16.0.1')).toBe('192.168.1.20');
    expect(preferredAddress([], null)).toBeNull();
  });

  it('counts the code down and stops at zero', () => {
    expect(countdownWords(NOW + 120_000, NOW)).toBe('2:00 left');
    expect(countdownWords(NOW + 1, NOW)).toBe('0:01 left');
    expect(countdownWords(NOW, NOW)).toBeNull();
  });

  it('clears the code when a phone pairs with it, when it runs out, or when access goes off', () => {
    const shown = { code: '123456', expiresAt: NOW + 60_000, knownDeviceIds: [DEV_A] };
    const one = { ...ON, devices: ON.devices.slice(0, 1) };
    expect(pairingOutcome(shown, one, NOW)).toEqual({ kind: 'shown' });
    expect(pairingOutcome(shown, ON, NOW)).toEqual({ kind: 'paired', name: XSS });
    expect(pairingOutcome(shown, one, NOW + 60_000)).toEqual({ kind: 'expired' });
    expect(pairingOutcome(shown, { ...one, enabled: false }, NOW)).toEqual({ kind: 'off' });
  });

  it('has words for every reason it can go off', () => {
    expect(offReasonWords('shutdown')).toContain('always starts off');
    expect(offReasonWords(null)).toBeNull();
  });

  it('the phone mark counts several phones', () => {
    const two = { ...ON, devices: ON.devices.map((d) => ({ ...d, connected: true })) };
    expect(phoneMark(withPhone(two))?.text).toBe('2 phones connected');
    expect(phoneMark(null)).toBeNull();
  });

  it('checks the phone.addresses answer', async () => {
    const answer = (r: unknown) => () => Promise.resolve(r as never);
    expect(await loadPhoneAddresses(answer({ ok: true, type: 'phone.addresses', addresses: ADDRS }))).toEqual({
      ok: true,
      addresses: ADDRS,
    });
    expect((await loadPhoneAddresses(answer({ ok: true, type: 'phone.addresses', addresses: [{ ip: 1 }] }))).ok).toBe(
      false,
    );
    expect(await loadPhoneAddresses(answer({ ok: false, code: 'unsupported', message: 'Sample data.' }))).toEqual({
      ok: false,
      code: 'unsupported',
      message: 'Sample data.',
    });
    expect((await loadPhoneAddresses(null)).ok).toBe(false);
  });
});

/**
 * Settings → Phone access (M6, F26). Off by default. While off: what it does and the risk, an address picker
 * (`phone.addresses`), the port, Turn on, and why it last went off. While on: the URL to type on the phone, Turn off,
 * Pair a phone (the 6-digit code from the command result, with its 2-minute countdown; never stored, cleared when it
 * runs out, when a phone pairs with it or when access goes off). The paired phones show either way, with Revoke and
 * Revoke all. Every change is a command through the existing send path; main validates it.
 */
import { useEffect, useRef, useState } from 'react';
import type { CommandResult, HuddleCommand, HuddleState, PhoneAddress } from '@huddle/shared';
import type { QueryFn } from '../query.js';
import { loadPhoneAddresses } from '../phone-query.js';
import { useNow } from '../useNow.js';
import {
  addressLabel,
  codeWords,
  countdownWords,
  currentPhone,
  deviceRow,
  DISABLE_COMMAND,
  enableCommand,
  lastIp,
  lastPort,
  offReasonWords,
  PAIR_COMMAND,
  pairControl,
  pairedWords,
  pairingOutcome,
  parsePort,
  PHONE_SETTINGS_WORDS as W,
  preferredAddress,
  revokeAllQuestion,
  revokeCommand,
  turnOnControl,
  type ShownPairing,
} from '../view/phone.js';
import { ControlButton } from './ControlButton.js';

export type AddressesState =
  { kind: 'loading' } | { kind: 'loaded'; addresses: PhoneAddress[] } | { kind: 'error'; message: string };

export interface PhoneSettingsProps {
  state: HuddleState;
  onCommand: (cmd: HuddleCommand) => Promise<CommandResult>;
  query: QueryFn | null;
  /** Tests pass a fixed clock; otherwise it ticks every second while a code shows. */
  now?: number;
  /** Starting state (tests: render-to-string runs no effect). */
  initial?: { addresses?: AddressesState; pairing?: ShownPairing; confirmRevokeAll?: boolean };
}

export function PhoneSettings({ state, onCommand, query, now: fixedNow, initial }: PhoneSettingsProps) {
  const phone = currentPhone(state);
  const [addresses, setAddresses] = useState<AddressesState>(initial?.addresses ?? { kind: 'loading' });
  const [ip, setIp] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pairing, setPairing] = useState<ShownPairing | null>(initial?.pairing ?? null);
  const [confirmAll, setConfirmAll] = useState(initial?.confirmRevokeAll ?? false);
  const ticking = useNow(fixedNow === undefined && pairing !== null ? 1000 : null);
  const now = fixedNow ?? ticking;

  const lookSeq = useRef(0);
  const look = () => {
    const n = ++lookSeq.current;
    setAddresses({ kind: 'loading' });
    void loadPhoneAddresses(query).then((r) => {
      if (n !== lookSeq.current) return; // a newer look is on its way
      setAddresses(r.ok ? { kind: 'loaded', addresses: r.addresses } : { kind: 'error', message: r.message });
    });
  };
  useEffect(() => {
    if (initial?.addresses === undefined) look();
    // Once, on open; "Look again" asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only: `look` is a new function every render and `initial` is a test seed
  }, []);

  // The code on screen: gone when it ran out, when a phone paired with it, or when access went off.
  const outcome = pairing === null ? null : pairingOutcome(pairing, phone, now);
  const outcomeKind = outcome?.kind ?? null;
  const pairedName = outcome?.kind === 'paired' ? outcome.name : null;
  useEffect(() => {
    if (outcomeKind === null || outcomeKind === 'shown') return;
    setPairing(null);
    if (pairedName !== null) setNotice(pairedWords(pairedName));
    else if (outcomeKind === 'expired') setNotice(W.codeExpired);
  }, [outcomeKind, pairedName]);

  const list = addresses.kind === 'loaded' ? addresses.addresses : [];
  const chosenIp = ip !== null && list.some((a) => a.ip === ip) ? ip : preferredAddress(list, lastIp(state));
  const portText = portDraft ?? String(lastPort(state));
  const offReason = phone.enabled ? null : offReasonWords(phone.reason);

  const run = (cmd: HuddleCommand, after?: (r: CommandResult) => void) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    void onCommand(cmd).then((r) => {
      setBusy(false);
      if (!r.ok) setError(r.message);
      after?.(r);
    });
  };

  const turnOn = () => {
    if (chosenIp === null) return;
    const port = parsePort(portText);
    if ('error' in port) {
      setError(port.error);
      return;
    }
    run(enableCommand(chosenIp, port.port), (r) => {
      if (r.ok) setPortDraft(null);
    });
  };

  const pair = () => {
    run(PAIR_COMMAND, (r) => {
      if (r.ok && r.phonePairing !== undefined) {
        setPairing({ ...r.phonePairing, knownDeviceIds: phone.devices.map((d) => d.deviceId) });
      }
    });
  };

  const countdown = pairing === null ? null : countdownWords(pairing.expiresAt, now);
  const rows = phone.devices.map((d) => deviceRow(d, now));

  return (
    <div className="phone-settings">
      <p className="setting-help">{W.what}</p>
      <p className="setting-help phone-risk">
        <span className="glyph tone-needs-you" aria-hidden="true">
          ▲
        </span>{' '}
        {W.risk}
      </p>

      <p className={`phone-state ${phone.enabled ? 'tone-working' : 'tone-idle'}`} role="status">
        <span className="glyph" aria-hidden="true">
          {phone.enabled ? '●' : '○'}
        </span>{' '}
        {phone.enabled ? W.isOn : W.isOff}
        {offReason !== null && <span className="phone-reason"> · {offReason}</span>}
      </p>

      {phone.enabled ? (
        <>
          <p className="phone-url-lead">
            {W.urlLead}{' '}
            <span className="code phone-url" id="phone-url">
              {phone.url ?? '—'}
            </span>
          </p>
          <p className="setting-help">{W.urlHelp}</p>
          <div className="phone-actions">
            <ControlButton control={pairControl(phone)} onPress={pair} variant="primary" busy={busy}>
              {W.pair}
            </ControlButton>
            <ControlButton
              control={{ enabled: true, reason: null }}
              onPress={() => {
                setPairing(null);
                run(DISABLE_COMMAND);
              }}
              busy={busy}
            >
              {W.turnOff}
            </ControlButton>
          </div>
          {pairing !== null && countdown !== null && (
            <div className="phone-code" role="group" aria-labelledby="phone-code-lead">
              <p id="phone-code-lead" className="setting-help">
                {W.codeLead}
              </p>
              <p className="phone-code-digits code" aria-live="polite">
                {codeWords(pairing.code)}
              </p>
              <p className="setting-help phone-countdown">{countdown}</p>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="setting-row">
            <label htmlFor="phone-address" className="setting-label">
              {W.addressLabel}
            </label>
            <span className="setting-value">
              {addresses.kind === 'loaded' && list.length > 0 ? (
                <select
                  id="phone-address"
                  className="text-input phone-select"
                  value={chosenIp ?? ''}
                  onChange={(e) => {
                    setIp(e.target.value);
                  }}
                >
                  {list.map((a) => (
                    <option key={a.ip} value={a.ip}>
                      {addressLabel(a)}
                    </option>
                  ))}
                </select>
              ) : (
                <span id="phone-address" className="muted">
                  {addresses.kind === 'loading' ? W.looking : '—'}
                </span>
              )}
              <button type="button" className="control control-quiet" onClick={look}>
                {W.lookAgain}
              </button>
            </span>
          </div>
          {addresses.kind === 'loaded' && list.length === 0 && <p className="setting-help">{W.noAddress}</p>}
          {addresses.kind === 'error' && (
            <p className="inline-error" role="alert">
              {addresses.message}
            </p>
          )}
          <div className="setting-row">
            <label htmlFor="phone-port" className="setting-label">
              {W.portLabel}
            </label>
            <span className="setting-value">
              <input
                id="phone-port"
                className="text-input number-input"
                type="number"
                inputMode="numeric"
                min={1024}
                max={65535}
                step={1}
                value={portText}
                onChange={(e) => {
                  setPortDraft(e.target.value);
                }}
              />
            </span>
          </div>
          <div className="phone-actions">
            <ControlButton control={turnOnControl(chosenIp, busy)} onPress={turnOn} variant="primary" busy={busy}>
              {busy ? W.turningOn : W.turnOn}
            </ControlButton>
          </div>
        </>
      )}

      {error !== null && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {notice !== null && (
        <p className="setting-help" role="status">
          {notice}
        </p>
      )}

      <h3 className="phone-devices-title">{W.devicesTitle}</h3>
      {rows.length === 0 ? (
        <p className="setting-help">{W.noDevices}</p>
      ) : (
        <>
          <ul className="phone-devices">
            {rows.map((r) => (
              <li key={r.deviceId} className="phone-device">
                <span className="phone-device-name">{r.name}</span>
                <span className={`phone-device-conn ${r.connected ? 'tone-working' : 'tone-idle'}`}>
                  <span className="glyph" aria-hidden="true">
                    {r.glyph}
                  </span>{' '}
                  {r.connectedWord}
                </span>
                <span className="phone-device-meta muted">
                  {r.paired} · {r.lastSeen}
                </span>
                <button
                  type="button"
                  className="control control-plain"
                  aria-label={`${W.revoke} ${r.name}`}
                  onClick={() => {
                    run(revokeCommand(r.deviceId));
                  }}
                >
                  {W.revoke}
                </button>
              </li>
            ))}
          </ul>
          {confirmAll ? (
            <div className="phone-confirm" role="group" aria-labelledby="phone-revoke-all-q">
              <p id="phone-revoke-all-q">{revokeAllQuestion(rows.length)}</p>
              <span className="phone-actions">
                <button
                  type="button"
                  className="control control-danger"
                  onClick={() => {
                    setConfirmAll(false);
                    run(revokeCommand('all'));
                  }}
                >
                  {W.revokeAll}
                </button>
                <button
                  type="button"
                  className="control control-plain"
                  onClick={() => {
                    setConfirmAll(false);
                  }}
                >
                  {W.revokeAllBack}
                </button>
              </span>
            </div>
          ) : (
            rows.length > 1 && (
              <button
                type="button"
                className="control control-plain"
                onClick={() => {
                  setConfirmAll(true);
                }}
              >
                {W.revokeAll}…
              </button>
            )
          )}
        </>
      )}
    </div>
  );
}

/**
 * Test support: a consent record as `HuddleCore` saves it after the owner approved the first-run change, so a test
 * can start a core that attaches by itself. The fingerprint is the one a start with default options would plan
 * (all events, telemetry on, the default timeouts); port and token do not enter it.
 */
import path from 'node:path';
import type { HuddleSettings } from '../runtime/huddle-settings.js';
import { FORWARDER_FILENAME, HUDDLE_DIRNAME, planInstall, type InstallOptions } from '../setup/install-hooks.js';

/** The consent fingerprint of the change a default start would write into `<claudeDir>/settings.json`. */
export function defaultConsentFingerprint(
  claudeDir: string,
  current: Record<string, unknown> = {},
  options: Partial<InstallOptions> = {},
): string {
  const plan = planInstall(current, {
    port: 47821,
    token: 'fingerprint-token',
    forwarderPath: path.join(path.resolve(claudeDir), HUDDLE_DIRNAME, FORWARDER_FILENAME),
    events: 'all',
    otel: true,
    timeouts: {},
    ...options,
  });
  if (!plan.ok) throw new Error(plan.error);
  return plan.consentFingerprint;
}

/** A consent on record for `settingsPath` (inside `claudeDir`) and the default change. */
export function consentRecord(
  claudeDir: string,
  settingsPath: string = path.join(claudeDir, 'settings.json'),
  extra: Record<string, unknown> = {},
): HuddleSettings {
  return {
    consentedAt: '2026-11-13T10:00:00.000Z',
    consentedFor: settingsPath,
    consentedFingerprint: defaultConsentFingerprint(claudeDir),
    extra,
  };
}

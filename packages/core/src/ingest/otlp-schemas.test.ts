import { describe, expect, it } from 'vitest';
import { listTelemetryFixtureFiles, readFixture } from '../test/fixtures.js';
import { DROPPED_ATTRIBUTE_KEYS, parseOtlpLogs, TELEMETRY_ROUTES } from './otlp-schemas.js';

const fixtureFiles = listTelemetryFixtureFiles();

function record(attributes: unknown[], extra: Record<string, unknown> = {}) {
  return { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes, ...extra }] }] }] };
}

describe('parseOtlpLogs on recorded fixtures', () => {
  describe.each(fixtureFiles)('%s', (file) => {
    const lines = readFixture(file).filter((line) => line.kind === 'otlp-logs');

    it('parses every otlp-logs line without skipping a record', () => {
      expect(lines.length).toBeGreaterThan(0);
      for (const [index, line] of lines.entries()) {
        expect(line.event).toBeNull();
        const result = parseOtlpLogs(line.payload);
        if (!result.ok) throw new Error(`otlp line ${String(index)} failed: ${result.error}`);
        expect(result.records.length).toBeGreaterThan(0);
        expect(result.skipped).toBe(0);
      }
    });

    it('never keeps prompt, response or account attributes', () => {
      for (const line of lines) {
        const result = parseOtlpLogs(line.payload);
        if (!result.ok) throw new Error(result.error);
        for (const rec of result.records) {
          for (const key of Object.keys(rec.attributes)) {
            expect(DROPPED_ATTRIBUTE_KEYS.has(key)).toBe(false);
            expect(key.startsWith('user.')).toBe(false);
          }
        }
      }
    });
  });

  it('reads the event name, session id and typed values of an api_request', () => {
    const lines = readFixture('interactive-helpers.jsonl').filter((line) => line.kind === 'otlp-logs');
    const records = lines.flatMap((line) => {
      const result = parseOtlpLogs(line.payload);
      return result.ok ? result.records : [];
    });
    const apiRequest = records.find((rec) => rec.name === 'api_request');
    expect(apiRequest).toBeDefined();
    expect(typeof apiRequest?.attributes['session.id']).toBe('string');
    expect(typeof apiRequest?.attributes.model).toBe('string');
    expect(typeof apiRequest?.attributes.input_tokens).toBe('number');
    expect(typeof apiRequest?.attributes.cost_usd).toBe('number');
    expect(apiRequest?.resource['service.name']).toBe('claude-code');
  });
});

describe('parseOtlpLogs on hand-built bodies', () => {
  it.each([
    ['null', null],
    ['a string', 'resourceLogs'],
    ['a number', 42],
    ['an array', [{ resourceLogs: [] }]],
    ['resourceLogs that is not an array', { resourceLogs: { scopeLogs: [] } }],
  ])('rejects %s with a typed failure', (_label, body) => {
    const result = parseOtlpLogs(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error).toBe('string');
  });

  it('accepts an empty export request (protobuf JSON omits empty arrays)', () => {
    expect(parseOtlpLogs({})).toEqual({ ok: true, records: [], skipped: 0 });
  });

  it('skips unreadable records and attributes instead of failing the batch', () => {
    const body = {
      resourceLogs: [
        'not an object',
        {
          scopeLogs: [
            {
              logRecords: [
                42,
                { attributes: 'nope' },
                { attributes: [{ key: 'event.name', value: { stringValue: 'x' } }] },
              ],
            },
            { logRecords: 'nope' },
          ],
        },
      ],
    };
    const result = parseOtlpLogs(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.name).toBe('x');
    expect(result.skipped).toBeGreaterThanOrEqual(3);
  });

  it('drops attributes with an unreadable value but keeps the rest of the record', () => {
    const result = parseOtlpLogs(
      record([
        { key: 'event.name', value: { stringValue: 'api_request' } },
        { key: 'weird', value: { arrayValue: { values: [] } } },
        { nokey: true },
        { key: 'model', value: { stringValue: 'claude-opus-5-5' } },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records[0]?.attributes).toEqual({ 'event.name': 'api_request', model: 'claude-opus-5-5' });
  });

  it('reads int64 sent as a string and keeps unsafe integers as strings', () => {
    const result = parseOtlpLogs(
      record([
        { key: 'a', value: { intValue: '1206' } },
        { key: 'b', value: { intValue: '18446744073709551615' } },
        { key: 'c', value: { boolValue: true } },
        { key: 'd', value: { doubleValue: 0.5 } },
      ]),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.records[0]?.attributes).toEqual({ a: 1206, b: '18446744073709551615', c: true, d: 0.5 });
  });

  it('falls back to the body for the event name and never keeps the body', () => {
    const result = parseOtlpLogs(record([], { body: { stringValue: 'claude_code.api_request' } }));
    if (!result.ok) throw new Error(result.error);
    expect(result.records[0]?.name).toBe('api_request');
    expect('body' in (result.records[0] ?? {})).toBe(false);
  });

  it('drops prompt text, response text, account ids and over-long strings', () => {
    const result = parseOtlpLogs(
      record([
        { key: 'prompt', value: { stringValue: 'secret prompt' } },
        { key: 'prompt_text', value: { stringValue: 'secret prompt' } },
        { key: 'response', value: { stringValue: 'secret answer' } },
        { key: 'user.email', value: { stringValue: 'a@b.c' } },
        { key: 'organization.id', value: { stringValue: 'org' } },
        { key: 'long', value: { stringValue: 'x'.repeat(5000) } },
        { key: 'prompt_length', value: { stringValue: '130' } },
      ]),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.records[0]?.attributes).toEqual({ prompt_length: '130' });
  });

  it('never throws on a hostile object', () => {
    const hostile = {
      get resourceLogs(): never {
        throw new Error('boom');
      },
    };
    const result = parseOtlpLogs(hostile);
    expect(result.ok).toBe(false);
  });
});

describe('TELEMETRY_ROUTES', () => {
  it('sends logs to the log parser and discards metrics and traces', () => {
    expect(TELEMETRY_ROUTES['/v1/logs']).toBe('logs');
    expect(TELEMETRY_ROUTES['/v1/metrics']).toBe('discard');
    expect(TELEMETRY_ROUTES['/v1/traces']).toBe('discard');
  });
});

/**
 * PhoneServer (M6, F26): the LAN listener a paired phone talks to. node:http only.
 *
 * It binds the one address it is given (PhoneHost checks it is a private LAN IPv4 of this computer; tests pass
 * 127.0.0.1) and checks every request, in this order, before anything else happens:
 *  1. rate limits per remote address: a general bucket, a stricter one for pairing, and one for failed
 *     authentication (when it is empty every request from that address is refused) -> 429;
 *  2. `Host` must be exactly `<ip>:<port>` (DNS rebinding: a page on another name that resolves here) -> 403;
 *  3. an `Origin`, when present, must be exactly `http://<ip>:<port>`, the listener's own origin. This is the
 *     documented exception to "reject any Origin" (ADR-024): the phone page is served from here, so its own requests
 *     carry its own origin. The 127.0.0.1 hook server keeps refusing every Origin. No CORS headers, ever;
 *  4. the API needs `Authorization: Bearer <device token>` (a wrong, malformed or revoked token -> 401);
 *  5. JSON bodies only (`Content-Type: application/json`), at most MAX_BODY_BYTES (MAX_ACT_BODY_BYTES on `/api/act`)
 *     -> 415 / 413.
 * Every response carries the security headers (CSP default-src 'self', frame-ancestors 'none', no-store, nosniff,
 * no referrer).
 *
 * Routes:
 *   GET  /, /<file>      the phone page from `staticDir` (no token: the page holds no data)
 *   POST /api/pair       {code, name} -> {deviceId, token}; no token, the pairing code is the credential
 *   GET  /api/state      the phone view (token)
 *   GET  /api/stream     the phone view as server-sent events: `event: view` on connect and on change (throttled),
 *                        a comment heartbeat, closed after `streamMaxMs` (the page reconnects) (token)
 *   POST /api/decide     {requestId, decision: 'allow' | 'deny'} for an approval held now (token)
 *   POST /api/act        one action from the explicit allowlist PHONE_ACTION_TYPES (ADR-030): answer a held question,
 *                        message, pause, resume or stop an agent (token, its own rate limit). A well-formed body whose
 *                        `type` is not on the list is 403 and never reaches the consumer; a wrong shape is 400.
 * Nothing else: no launch, rules, budgets, settings, history or Ask.
 *
 * The server holds no data of its own: the device list, the view and the decision all come from its consumer.
 * Clock injected.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import {
  PHONE_ACTION_TYPES,
  PHONE_DEVICE_NAME_MAX,
  PHONE_OPTIONS_MAX,
  PHONE_PAIR_CODE_DIGITS,
  PHONE_QUESTIONS_MAX,
  PHONE_TEXT_MAX,
  type PhoneAction,
  type PhoneView,
} from '@huddle/shared';
import { agentKeyText, idText } from '../contracts/schema-parts.js';
import { RateLimiter, type BucketSpec } from './rate-limit.js';
import { readStaticFile } from './static-files.js';

export const MAX_BODY_BYTES = 4 * 1024;
/**
 * `/api/act` alone: a question.answer may carry PHONE_QUESTIONS_MAX typed answers of PHONE_TEXT_MAX UTF-16 units each.
 * One unit is at most 6 bytes on the wire (`\uXXXX`, the worst JSON escape; UTF-8 is at most 3 bytes per unit), and
 * MAX_BODY_BYTES more covers the choices, the ids and the keys. Zod still refuses any text past PHONE_TEXT_MAX.
 */
export const MAX_ACT_BODY_BYTES = PHONE_QUESTIONS_MAX * PHONE_TEXT_MAX * 6 + MAX_BODY_BYTES;
export const PHONE_MAX_CONNECTIONS = 64;
export const PHONE_MAX_STREAMS = 16;
export const DEFAULT_HEARTBEAT_MS = 20_000;
export const DEFAULT_STREAM_MAX_MS = 15 * 60_000;
/**
 * Unsent bytes a live stream may pile up (a phone that stopped reading: asleep, out of range). Past this the stream is
 * ended; the page reconnects by itself and gets the current view. A view frame can be larger than the socket's 16 KB
 * high-water mark, so a false from write() alone is normal and not a reason to cut.
 */
export const DEFAULT_STREAM_BUFFER_BYTES = 1024 * 1024;
export const DEFAULT_THROTTLE_MS = 500;

export const RATE_LIMITS = {
  /** Every request from one address. */
  general: { capacity: 120, refillPerSec: 2 },
  /** Pairing attempts from one address (the code itself also dies after 5 wrong tries). */
  pair: { capacity: 5, refillPerSec: 1 / 12 },
  /** Failed authentications (wrong token, wrong code) from one address; empty = everything refused for a while. */
  fail: { capacity: 10, refillPerSec: 1 / 30 },
  /** Actions (answer, message, pause, resume, stop) from one address: a burst of 20, then one every 3 s (ADR-030). */
  act: { capacity: 20, refillPerSec: 1 / 3 },
} as const satisfies Record<string, BucketSpec>;

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
};

export type PairOutcome =
  | { ok: true; deviceId: string; token: string }
  | { ok: false; status: 400 | 401 | 403 | 409 | 500; error: string; failedAuth: boolean };

export type DecideOutcome = { ok: true } | { ok: false; status: 400 | 404 | 409 | 503; error: string };

/** The consumer's answer to an action; `error` and `detail` are the Huddle's words for the user, shown as text. */
export type ActOutcome =
  { ok: true; detail?: string } | { ok: false; status: 400 | 403 | 404 | 409 | 503; error: string };

export interface PhoneServerOptions {
  host: string;
  /** 0 picks a free port (tests). */
  port: number;
  now: () => number;
  /** The phone page's folder; null: only the API is served (static requests are 404). */
  staticDir: string | null;
  /** The device a token belongs to now, or null. Called on every API request (revocation is immediate). */
  authenticate: (token: string) => { deviceId: string } | null;
  pair: (code: string, name: string) => Promise<PairOutcome>;
  /** The phone view as JSON-ready data; `generatedAt` is ignored when telling whether it changed. */
  view: () => PhoneView;
  decide: (deviceId: string, requestId: string, decision: 'allow' | 'deny') => DecideOutcome;
  /** One allowlisted action (ADR-030), already checked for shape here. Absent: `/api/act` is 404. */
  act?: (deviceId: string, action: PhoneAction) => Promise<ActOutcome>;
  /**
   * An authenticated API request arrived. `action` is true only for what a person did (a fresh page open,
   * `GET /api/state?open=1`, and every successful action: Allow, Deny and the ADR-030 actions); stream reconnects
   * and refreshes are presence only. Every request updates "last seen"; only an action keeps phone access from
   * turning itself off (owner, 2026-11-16).
   */
  onActivity?: (deviceId: string, action: boolean) => void;
  /** A device's first live stream opened (true) or its last one closed (false). */
  onStreamChange?: (deviceId: string, connected: boolean) => void;
  heartbeatMs?: number;
  streamMaxMs?: number;
  throttleMs?: number;
  /** Unsent bytes a stream may hold before it is ended (default DEFAULT_STREAM_BUFFER_BYTES). */
  streamBufferBytes?: number;
}

interface Stream {
  deviceId: string;
  res: http.ServerResponse;
  timers: NodeJS.Timeout[];
}

export class PhoneServerError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PhoneServerError';
    this.code = code;
  }
}

const pairBody = z.looseObject({
  code: z.string().regex(new RegExp(`^[0-9]{${String(PHONE_PAIR_CODE_DIGITS)}}$`)),
  name: z.string().max(PHONE_DEVICE_NAME_MAX * 4),
});
const decideBody = z.looseObject({
  requestId: z.string().min(1).max(256),
  decision: z.enum(['allow', 'deny']),
});

// The allowlist (ADR-030). Typed text is refused past PHONE_TEXT_MAX here; the core clips to CLIP_LIMITS again.
const phoneText = z.string().max(PHONE_TEXT_MAX);
const actAgentKey = agentKeyText;
const actBody = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('question.answer'),
    requestId: idText,
    answers: z
      .array(
        z.looseObject({
          choices: z
            .array(
              z
                .number()
                .int()
                .min(0)
                .max(PHONE_OPTIONS_MAX - 1),
            )
            .max(PHONE_OPTIONS_MAX),
          other: phoneText.optional(),
        }),
      )
      .min(1)
      .max(PHONE_QUESTIONS_MAX),
  }),
  z.looseObject({ type: z.literal('agent.message'), agentKey: actAgentKey, text: phoneText.min(1) }),
  z.looseObject({ type: z.literal('agent.pause'), agentKey: actAgentKey }),
  z.looseObject({ type: z.literal('agent.resume'), agentKey: actAgentKey }),
  z.looseObject({ type: z.literal('agent.stop'), agentKey: actAgentKey }),
]);
const ACTION_TYPES: ReadonlySet<string> = new Set(PHONE_ACTION_TYPES);

/** The action built field by field from the checked body, so no unknown field reaches the consumer. */
function actionOf(body: z.infer<typeof actBody>): PhoneAction {
  switch (body.type) {
    case 'question.answer':
      return {
        type: body.type,
        requestId: body.requestId,
        answers: body.answers.map((a) => ({
          choices: [...a.choices],
          ...(a.other !== undefined ? { other: a.other } : {}),
        })),
      };
    case 'agent.message':
      return { type: body.type, agentKey: body.agentKey, text: body.text };
    default:
      return { type: body.type, agentKey: body.agentKey };
  }
}

export class PhoneServer {
  private readonly opts: PhoneServerOptions;
  private readonly server: http.Server;
  private readonly general: RateLimiter;
  private readonly pairLimit: RateLimiter;
  private readonly failLimit: RateLimiter;
  private readonly actLimit: RateLimiter;
  private readonly streams = new Set<Stream>();
  private state: 'idle' | 'listening' | 'closing' | 'closed' = 'idle';
  private boundPort: number | null = null;
  private lastSentJson: string | null = null;
  private lastSentAt = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private closePromise: Promise<void> | null = null;

  constructor(opts: PhoneServerOptions) {
    this.opts = opts;
    this.general = new RateLimiter(RATE_LIMITS.general, opts.now);
    this.pairLimit = new RateLimiter(RATE_LIMITS.pair, opts.now);
    this.failLimit = new RateLimiter(RATE_LIMITS.fail, opts.now);
    this.actLimit = new RateLimiter(RATE_LIMITS.act, opts.now);
    this.server = http.createServer({ requireHostHeader: true }, (req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) this.sendJson(res, 500, { error: 'internal error' }, true);
        else res.destroy();
      });
    });
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
    // Streams are long and quiet between heartbeats; the stream's own max age bounds them.
    this.server.timeout = 0;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxConnections = PHONE_MAX_CONNECTIONS;
  }

  start(): Promise<{ host: string; port: number }> {
    if (this.state !== 'idle') return Promise.reject(new Error(`PhoneServer cannot start: it is ${this.state}`));
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        this.state = 'closed';
        const code = error.code ?? 'ERROR';
        reject(
          new PhoneServerError(
            code,
            code === 'EADDRINUSE'
              ? `Port ${String(this.opts.port)} is already in use on ${this.opts.host}. Pick another port.`
              : code === 'EADDRNOTAVAIL'
                ? `The address ${this.opts.host} is not available on this computer right now.`
                : 'Phone access could not start listening.',
            { cause: error },
          ),
        );
      };
      this.server.once('error', onError);
      this.server.listen({ port: this.opts.port, host: this.opts.host, exclusive: true }, () => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('PhoneServer is listening but has no address'));
          return;
        }
        const info: AddressInfo = address;
        this.boundPort = info.port;
        this.state = 'listening';
        resolve({ host: info.address, port: info.port });
      });
    });
  }

  /** `<ip>:<port>` as the Host header must say. */
  private authority(): string {
    return `${this.opts.host}:${String(this.boundPort ?? this.opts.port)}`;
  }

  /** Live streams open now. */
  streamCount(): number {
    return this.streams.size;
  }

  /** Ends the live streams of one device (revoked), or of all. */
  closeStreams(deviceId: string | null): void {
    for (const stream of [...this.streams]) {
      if (deviceId === null || stream.deviceId === deviceId) this.endStream(stream);
    }
  }

  /** The state changed: streams get the new view, at most every `throttleMs`, and only when it differs. */
  notifyChanged(): void {
    if (this.state !== 'listening' || this.streams.size === 0) return;
    this.dirty = true;
    if (this.flushTimer !== null) return;
    const throttle = this.opts.throttleMs ?? DEFAULT_THROTTLE_MS;
    const wait = Math.max(0, this.lastSentAt + throttle - this.opts.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, wait);
    this.flushTimer.unref();
  }

  private flush(): void {
    if (!this.dirty || this.state !== 'listening') return;
    this.dirty = false;
    const view = this.safeView();
    if (view === null) return;
    const { generatedAt: _ignored, ...rest } = view;
    const key = JSON.stringify(rest);
    if (key === this.lastSentJson) return;
    this.lastSentJson = key;
    this.lastSentAt = this.opts.now();
    const frame = `event: view\ndata: ${JSON.stringify(view)}\n\n`;
    for (const stream of [...this.streams]) this.send(stream, frame);
  }

  private safeView(): PhoneView | null {
    try {
      return this.opts.view();
    } catch {
      return null;
    }
  }

  /** Stops listening: streams end, idle sockets close, the rest are cut after a second. Idempotent. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === 'idle' || this.state === 'closed') {
      this.state = 'closed';
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    this.state = 'closing';
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.closeStreams(null);
    this.closePromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.server.closeAllConnections();
      }, 1000);
      timer.unref();
      this.server.close(() => {
        clearTimeout(timer);
        this.state = 'closed';
        resolve();
      });
      this.server.closeIdleConnections();
    });
    return this.closePromise;
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress ?? 'unknown';
    if (this.state !== 'listening') {
      this.sendJson(res, 503, { error: 'phone access is closing' }, true);
      return;
    }
    // 1. Rate limits first, so a flood costs as little as possible.
    if (this.failLimit.empty(remote) || !this.general.take(remote)) {
      this.sendJson(res, 429, { error: 'too many requests' }, true, { 'retry-after': '30' });
      return;
    }
    // 2. Host: exactly our own address and port.
    const authority = this.authority();
    const host = req.headers.host;
    if (typeof host !== 'string' || host.toLowerCase() !== authority) {
      this.sendJson(res, 403, { error: 'wrong host' }, true);
      return;
    }
    // 3. Origin: absent, or exactly our own (ADR-024).
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${authority}`) {
      this.sendJson(res, 403, { error: 'foreign origin' }, true);
      return;
    }
    const pathname = this.pathname(req);
    if (!pathname.startsWith('/api/')) {
      await this.serveStatic(req, res, pathname);
      return;
    }
    if (pathname === '/api/pair') {
      await this.handlePair(req, res, remote);
      return;
    }
    // 4. Every other API route needs a paired device's token.
    const device = this.authenticate(req);
    if (device === null) {
      this.failLimit.take(remote);
      this.sendJson(res, 401, { error: 'missing, wrong or revoked device token' }, true, {
        'www-authenticate': 'Bearer',
      });
      return;
    }
    const freshOpen = pathname === '/api/state' && this.query(req) === 'open=1';
    // An /api/act or /api/decide counts as an action only once the core carried it out: a refused one must not keep
    // phone access on.
    this.opts.onActivity?.(device.deviceId, freshOpen);
    if (pathname === '/api/state') {
      if (!this.isMethod(req, res, 'GET')) return;
      const view = this.safeView();
      if (view === null) this.sendJson(res, 503, { error: 'not available' });
      else this.sendJson(res, 200, view);
      return;
    }
    if (pathname === '/api/stream') {
      if (!this.isMethod(req, res, 'GET')) return;
      this.openStream(req, res, device.deviceId);
      return;
    }
    if (pathname === '/api/decide') {
      if (!this.isMethod(req, res, 'POST')) return;
      const body = await this.readJson(req, res);
      if (body === undefined) return;
      const parsed = decideBody.safeParse(body);
      if (!parsed.success) {
        this.sendJson(res, 400, { error: 'expected {requestId, decision: "allow" | "deny"}' });
        return;
      }
      const outcome = this.opts.decide(device.deviceId, parsed.data.requestId, parsed.data.decision);
      if (outcome.ok) {
        this.opts.onActivity?.(device.deviceId, true);
        this.sendJson(res, 200, { ok: true });
      } else this.sendJson(res, outcome.status, { error: outcome.error });
      return;
    }
    if (pathname === '/api/act' && this.opts.act !== undefined) {
      await this.handleAct(req, res, remote, device.deviceId, this.opts.act);
      return;
    }
    this.sendJson(res, 404, { error: 'not found' }, true);
  }

  private async handleAct(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    remote: string,
    deviceId: string,
    act: (deviceId: string, action: PhoneAction) => Promise<ActOutcome>,
  ): Promise<void> {
    if (!this.isMethod(req, res, 'POST')) return;
    if (!this.actLimit.take(remote)) {
      this.sendJson(res, 429, { error: 'too many actions' }, true, { 'retry-after': '10' });
      return;
    }
    const body = await this.readJson(req, res, MAX_ACT_BODY_BYTES);
    if (body === undefined) return;
    // The allowlist first: a type that is not on it is refused whatever else the body says.
    const type =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)['type']
        : undefined;
    if (typeof type !== 'string' || !ACTION_TYPES.has(type)) {
      this.sendJson(res, 403, { error: 'that action is not allowed from a phone' });
      return;
    }
    const parsed = actBody.safeParse(body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: 'that action is not well formed' });
      return;
    }
    let outcome: ActOutcome;
    try {
      outcome = await act(deviceId, actionOf(parsed.data));
    } catch {
      outcome = { ok: false, status: 503, error: 'not available' };
    }
    if (outcome.ok) {
      this.opts.onActivity?.(deviceId, true);
      this.sendJson(res, 200, { ok: true, ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) });
    } else this.sendJson(res, outcome.status, { error: outcome.error });
  }

  private authenticate(req: http.IncomingMessage): { deviceId: string } | null {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(header);
    if (match === null) return null;
    try {
      return this.opts.authenticate(match[1] ?? '');
    } catch {
      return null;
    }
  }

  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse, remote: string): Promise<void> {
    if (!this.isMethod(req, res, 'POST')) return;
    if (!this.pairLimit.take(remote)) {
      this.sendJson(res, 429, { error: 'too many pairing attempts' }, true, { 'retry-after': '60' });
      return;
    }
    const body = await this.readJson(req, res);
    if (body === undefined) return;
    const parsed = pairBody.safeParse(body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: 'expected {code: "<6 digits>", name}' });
      return;
    }
    const outcome = await this.opts.pair(parsed.data.code, parsed.data.name);
    if (outcome.ok) {
      this.sendJson(res, 200, { deviceId: outcome.deviceId, token: outcome.token });
      return;
    }
    if (outcome.failedAuth) this.failLimit.take(remote);
    this.sendJson(res, outcome.status, { error: outcome.error });
  }

  private openStream(req: http.IncomingMessage, res: http.ServerResponse, deviceId: string): void {
    if (this.streams.size >= PHONE_MAX_STREAMS) {
      this.sendJson(res, 503, { error: 'too many live streams' }, true);
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const stream: Stream = { deviceId, res, timers: [] };
    const first = !this.hasStream(deviceId);
    this.streams.add(stream);
    // This stream was just sent the current view without `flush`; forget the last flushed one so the next change reaches it.
    this.lastSentJson = null;
    const view = this.safeView();
    // The opening frames are written as they are (one view); the backlog cap applies from the next write (`send`).
    res.write(`retry: 3000\n\n`);
    if (view !== null) res.write(`event: view\ndata: ${JSON.stringify(view)}\n\n`);
    const heartbeat = setInterval(() => {
      this.send(stream, `: heartbeat\n\n`);
    }, this.opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    heartbeat.unref();
    const maxAge = setTimeout(() => {
      this.endStream(stream);
    }, this.opts.streamMaxMs ?? DEFAULT_STREAM_MAX_MS);
    maxAge.unref();
    stream.timers.push(heartbeat, maxAge);
    const gone = () => {
      this.dropStream(stream);
    };
    req.on('close', gone);
    res.on('close', gone);
    if (first) this.opts.onStreamChange?.(deviceId, true);
  }

  /** One write to a live stream. A stream whose earlier frames are still unsent past the cap is ended instead. */
  private send(stream: Stream, frame: string): void {
    const res = stream.res;
    if (res.writableEnded || res.destroyed) return;
    // Judged on what is still unsent from earlier frames, not on this one: a single view larger than the cap must not
    // cut a phone that reads (it would reconnect, get the same view and be cut again).
    if (res.writableLength > (this.opts.streamBufferBytes ?? DEFAULT_STREAM_BUFFER_BYTES)) {
      this.endStream(stream);
      return;
    }
    res.write(frame);
  }

  private hasStream(deviceId: string): boolean {
    for (const s of this.streams) if (s.deviceId === deviceId) return true;
    return false;
  }

  private endStream(stream: Stream): void {
    this.dropStream(stream);
    if (!stream.res.writableEnded) stream.res.end();
    stream.res.socket?.destroy();
  }

  private dropStream(stream: Stream): void {
    if (!this.streams.delete(stream)) return;
    for (const t of stream.timers.splice(0)) clearTimeout(t);
    if (!this.hasStream(stream.deviceId)) this.opts.onStreamChange?.(stream.deviceId, false);
  }

  private async serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    if (!this.isMethod(req, res, 'GET')) return;
    const dir = this.opts.staticDir;
    const file = dir === null ? null : await readStaticFile(dir, pathname);
    if (file === null) {
      this.sendJson(res, 404, { error: 'not found' }, true);
      return;
    }
    if (res.headersSent || res.destroyed) return;
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': file.contentType, 'content-length': file.body.length });
    res.end(file.body);
  }

  private isMethod(req: http.IncomingMessage, res: http.ServerResponse, method: 'GET' | 'POST'): boolean {
    if (req.method === method) return true;
    this.sendJson(res, 405, { error: `use ${method}` }, true, { allow: method });
    return false;
  }

  private pathname(req: http.IncomingMessage): string {
    const raw = req.url ?? '/';
    // Only origin-form paths ("/x"); an absolute-form URL ("http://other/x") is refused as not found.
    if (!raw.startsWith('/')) return '/\u0000';
    const q = raw.indexOf('?');
    return q === -1 ? raw : raw.slice(0, q);
  }

  /** The raw query string after "?", or '' (only `open=1` on `/api/state` means anything). */
  private query(req: http.IncomingMessage): string {
    const raw = req.url ?? '';
    const q = raw.indexOf('?');
    return q === -1 ? '' : raw.slice(q + 1);
  }

  /** The JSON body, or undefined when the request was refused here (wrong type, too big, not JSON). */
  private readJson(req: http.IncomingMessage, res: http.ServerResponse, limit = MAX_BODY_BYTES): Promise<unknown> {
    const type = req.headers['content-type'];
    if (typeof type !== 'string' || !/^application\/json(?:\s*;|$)/i.test(type.trim())) {
      this.sendJson(res, 415, { error: 'use Content-Type: application/json' }, true);
      return Promise.resolve(undefined);
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      this.sendJson(res, 413, { error: 'body too large' }, true);
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on('data', (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > limit) {
          done = true;
          this.sendJson(res, 413, { error: 'body too large' }, true);
          req.socket.destroy();
          resolve(undefined);
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => {
        if (done) return;
        done = true;
        resolve(undefined);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          this.sendJson(res, 400, { error: 'invalid JSON' });
          resolve(undefined);
        }
      });
    });
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    body: object,
    closeConnection = false,
    extra: Record<string, string> = {},
  ): void {
    if (res.headersSent || res.destroyed) return;
    const text = JSON.stringify(body);
    const headers: http.OutgoingHttpHeaders = {
      ...SECURITY_HEADERS,
      ...extra,
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    };
    if (closeConnection || this.state === 'closing') headers.connection = 'close';
    res.writeHead(status, headers);
    res.end(text);
  }
}

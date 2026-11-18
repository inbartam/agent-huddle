/**
 * HookServer: the HTTP edge that Claude Code's hooks and OpenTelemetry exporter post to.
 *
 * Ported from the tested M0 prototype server: same port, same routes, same token
 * header and the same "browsers are refused" rule. Rules it keeps (CONTRIBUTING.md rule 5, ARCHITECTURE.md §3, §9):
 *  - Binds 127.0.0.1 only. Hook payloads hold prompts, code and command lines.
 *  - Routes: `POST /huddle/hooks/<Event>`, `POST /v1/{logs,metrics,traces}` and (F9) `POST /huddle/statusline`.
 *  - Every request needs the `X-Huddle-Token` header (constant-time compare). Any `Origin` header is
 *    refused: Claude Code and OTLP exporters never send one, a web page always does. No CORS headers.
 *  - It answers first and works later. The response is written before `onHook` / `onTelemetryLogs`
 *    run, and those run on a later tick with every error caught, so neither disk nor UI can slow or
 *    break an agent's tool call. Budget: under 20 ms at p99.
 *  - By default every accepted hook gets `200` with an empty body, which Claude Code reads as "no decision"
 *    and carries on. With a `decideHook` consumer (M3) a hook can instead be answered with a JSON body at once,
 *    or held: see `HookDecision` and `HeldHandle` below. A held response has four endings (user, rule, closed
 *    by Claude Code, Huddle shutdown); the server reports the two it sees through `HeldHandle.onClosed`.
 *  - Node's server timeouts only guard the *request* (headers within `headersTimeout`, the whole body within
 *    `requestTimeout`); once the body is read they no longer apply, so a held response may last as long as the
 *    hook's own timeout (up to 600 s, ADR-019). The socket idle timeout (`server.timeout`) is set to 0 and the
 *    keep-alive timeout only runs between requests. `hook-server.hold.test.ts` pins this behaviour.
 *
 * The clock is injected (`now`): `receivedAt` is taken here, at the edge, and nowhere else.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { parseHookPayload, type ParseHookResult } from './schemas.js';
import { parseStatuslinePayload, type ParseStatuslineResult } from './statusline-schema.js';

const gunzip = promisify(zlib.gunzip);

/** Default port; the hook installer writes it into the hook URLs (scripts/lib/common.mjs). */
export const DEFAULT_HOOK_PORT = 47821;
/** Hook route prefix: `POST /huddle/hooks/<EventName>` (as installed by scripts/install-hooks.mjs). */
export const HOOK_PATH_PREFIX = '/huddle/hooks/';
/** Status line bridge route (F9): `POST /huddle/statusline`, posted by scripts/huddle-statusline.mjs. */
export const STATUSLINE_PATH = '/huddle/statusline';
/** Header carrying the shared secret. Node lower-cases incoming header names. */
export const TOKEN_HEADER = 'x-huddle-token';
/** Same limit as the spike: 25 MiB, checked both before and after gzip. */
export const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;
/**
 * Most sockets open at once. Each held hook response keeps one socket busy (M3), and parallel tool calls are
 * each held (S6), so this is well above `MAX_HELD_RESPONSES`; it still bounds what a runaway local client can
 * hold open. Node closes connections over the limit straight away.
 */
export const MAX_CONNECTIONS = 256;
/**
 * Most hook responses held at once. Past it a hook that asks to be held is answered at once with no decision
 * (fail open), counted in `stats().holdsRefused`, and `onHoldRefused` is told.
 */
export const MAX_HELD_RESPONSES = 64;
/** Slow-client guards for the request itself (headers, then the whole body). They never cut a held response. */
export const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Only loopback. Never 0.0.0.0 or ::. */
const HOST = '127.0.0.1';

/** Thrown by `start()` when the port is already taken, for example by another running Agent Huddle. */
export class PortInUseError extends Error {
  readonly code = 'HUDDLE_PORT_IN_USE';
  readonly port: number;
  constructor(port: number, options?: { cause?: unknown }) {
    super(
      `Port ${String(port)} on ${HOST} is already in use, so Agent Huddle cannot receive hook events. ` +
        `Is another Agent Huddle or another program using it? Close it and start again.`,
      options,
    );
    this.name = 'PortInUseError';
    this.port = port;
  }
}

export type HookHandler = (result: ParseHookResult, receivedAt: number) => void | Promise<void>;
export type TelemetryLogsHandler = (body: unknown, receivedAt: number) => void | Promise<void>;
export type StatuslineHandler = (result: ParseStatuslineResult, receivedAt: number) => void | Promise<void>;

/** A hook reply body: a JSON object Claude Code reads with its hook output schema (build it with hook-replies.ts). */
export type HookReplyBody = Readonly<Record<string, unknown>>;

/** A hook payload that passed validation, as handed to `decideHook`. */
export type AcceptedHook = Extract<ParseHookResult, { ok: true }>;

/** Why a held response ended without the consumer answering it. */
export type HoldClosedReason =
  /** Claude Code closed the request (answered in its own terminal, or the hook timed out). Nothing can be sent. */
  | 'closed_by_claude_code'
  /** The server answered it with no decision (empty 200) in `releaseAll()` / `close()`. */
  | 'shutdown';

/**
 * A held hook response. Exactly one ending wins:
 *  - the consumer calls `respond(body | null)` (user or rule decided; null = empty 200, no decision);
 *  - Claude Code closes the request: `onClosed` listeners get `'closed_by_claude_code'`;
 *  - the server shuts down: an empty 200 is sent and `onClosed` listeners get `'shutdown'`.
 * `onClosed` listeners are not called when the consumer itself responded.
 */
export interface HeldHandle {
  /** Answers the held request. Returns false (and sends nothing) once the hold has ended in any way. */
  respond(body: HookReplyBody | null): boolean;
  /**
   * Called once when the hold ends without `respond`. A listener registered after that ending is called
   * on a microtask with the reason, so a late listener is never stranded.
   */
  onClosed(cb: (why: HoldClosedReason) => void): void;
  /** True once the hold has ended in any way (responded, closed by Claude Code, or released on shutdown). */
  readonly closed: boolean;
}

/**
 * What `decideHook` returns for an accepted hook:
 *  - `{ now: body }` answers at once with that JSON body; `{ now: null }` answers an empty 200 (no decision);
 *  - `{ hold }` keeps the response open and calls `hold(handle)` synchronously. When the hold cap is reached or
 *    the server is closing, `hold` is NOT called and the request is answered with no decision instead
 *    (`onHoldRefused` is told), so a consumer creates its held state inside `hold`, never before.
 */
export type HookDecision = { now: HookReplyBody | null } | { hold: (handle: HeldHandle) => void };

/**
 * Called synchronously, before anything is written, for every accepted hook (`onHook` still runs afterwards,
 * on a later tick). It is on the agent's critical path (20 ms budget): no I/O, no awaiting.
 * If it throws, the hook is answered with no decision and the error is counted.
 */
export type DecideHook = (result: AcceptedHook, receivedAt: number) => HookDecision;

/** Why a hold was refused: the cap was reached, or the server is closing. */
export type HoldRefusedReason = 'cap' | 'closing';

export interface HookServerOptions {
  /** The shared secret from the installer's config.json. Required: the server fails closed without one. */
  token: string;
  /** Defaults to 47821. 0 picks a free port (tests). */
  port?: number;
  /** Defaults to 25 MiB. */
  maxBodyBytes?: number;
  /** Epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Called after the response is written, for every request on the hook route: accepted payloads
   * (`ok: true`) and rejected ones (`ok: false`, already answered 400) so they can be logged as
   * unrecognized. Errors and rejections are caught and counted.
   */
  onHook: HookHandler;
  /** Called after the response with the parsed OTLP/JSON body of `POST /v1/logs`. */
  onTelemetryLogs?: TelemetryLogsHandler;
  /**
   * Called after the response for every `POST /huddle/statusline` that got past the edge checks: accepted (`ok: true`)
   * and rejected (`ok: false`, already answered 400). Without a handler the route still answers and drops the body.
   */
  onStatusline?: StatuslineHandler;
  /** Told about every error thrown by a handler. Must not throw; if it does, that is swallowed too. */
  onHandlerError?: (error: unknown) => void;
  /** How long `close()` waits for in-flight requests before cutting connections. Defaults to 2000 ms. */
  closeTimeoutMs?: number;
  /**
   * Decides how an accepted hook is answered (at once with a body, or held). Without it every accepted hook gets an
   * empty 200 (observation only).
   */
  decideHook?: DecideHook;
  /** Told, on a later tick, when a hook asked to be held but was answered with no decision instead. */
  onHoldRefused?: (result: AcceptedHook, receivedAt: number, why: HoldRefusedReason) => void;
  /** Concurrent hold cap. Defaults to `MAX_HELD_RESPONSES` (64). */
  maxHeldResponses?: number;
  /** Request guards in ms (tests use small values). `headersTimeoutMs` must not exceed `requestTimeoutMs`. */
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** How often Node checks the request guards, in ms. Node's default is 30 000; tests use a small value. */
  connectionsCheckingIntervalMs?: number;
}

export interface HookServerStats {
  requests: number;
  hooksAccepted: number;
  telemetryLogsAccepted: number;
  /** Status line bodies accepted on `POST /huddle/statusline`. */
  statuslineAccepted: number;
  /** 401: missing or wrong token. */
  unauthorized: number;
  /** 403: request carried an Origin header. */
  originRejected: number;
  notFound: number;
  methodNotAllowed: number;
  /** 400: malformed JSON, gzip, or a hook payload that failed validation. */
  badRequests: number;
  /** Bodies over the limit: answered 200 with an empty body and dropped. */
  oversizedDropped: number;
  /** Errors thrown (or rejected) by onHook / onTelemetryLogs, decideHook, a hold callback or an onClosed listener. */
  handlerErrors: number;
  /** Hook responses that were held. */
  holdsStarted: number;
  /** Holds asked for but refused (cap reached or closing): answered at once with no decision. */
  holdsRefused: number;
  /** Holds ended by Claude Code closing the request. */
  holdsClosedByClaudeCode: number;
  /** Holds answered with no decision on shutdown (`releaseAll()` / `close()`). */
  holdsReleased: number;
  /** Holds open right now. */
  heldNow: number;
}

type Route = { kind: 'hook' } | { kind: 'statusline' } | { kind: 'otlp'; signal: 'logs' | 'metrics' | 'traces' };

/** Result of reading a body: the bytes, or a marker that it was too large and has been dropped. */
type BodyResult = { ok: true; body: Buffer } | { ok: false; reason: 'oversized' | 'bad_gzip' | 'aborted' };

const OTLP_ROUTE = /^\/v1\/(logs|metrics|traces)$/;

function emptyStats(): HookServerStats {
  return {
    requests: 0,
    hooksAccepted: 0,
    telemetryLogsAccepted: 0,
    statuslineAccepted: 0,
    unauthorized: 0,
    originRejected: 0,
    notFound: 0,
    methodNotAllowed: 0,
    badRequests: 0,
    oversizedDropped: 0,
    handlerErrors: 0,
    holdsStarted: 0,
    holdsRefused: 0,
    holdsClosedByClaudeCode: 0,
    holdsReleased: 0,
    heldNow: 0,
  };
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function matchRoute(pathname: string): Route | null {
  if (pathname.startsWith(HOOK_PATH_PREFIX)) return { kind: 'hook' };
  if (pathname === STATUSLINE_PATH) return { kind: 'statusline' };
  const otlp = OTLP_ROUTE.exec(pathname);
  const signal = otlp?.[1];
  if (signal === 'logs' || signal === 'metrics' || signal === 'traces') return { kind: 'otlp', signal };
  return null;
}

export class HookServer {
  private readonly server: http.Server;
  private readonly tokenDigest: Buffer;
  private readonly requestedPort: number;
  private readonly maxBodyBytes: number;
  private readonly now: () => number;
  private readonly onHook: HookHandler;
  private readonly onTelemetryLogs: TelemetryLogsHandler | undefined;
  private readonly onStatusline: StatuslineHandler | undefined;
  private readonly onHandlerError: ((error: unknown) => void) | undefined;
  private readonly closeTimeoutMs: number;
  private readonly decideHook: DecideHook | undefined;
  private readonly onHoldRefused: HookServerOptions['onHoldRefused'];
  private readonly maxHeldResponses: number;
  /** Release functions of the holds open right now; shutdown answers each with no decision. */
  private readonly held = new Set<() => void>();
  private readonly counters: HookServerStats = emptyStats();
  private state: 'idle' | 'starting' | 'listening' | 'closing' | 'closed' = 'idle';
  private closePromise: Promise<void> | null = null;

  constructor(options: HookServerOptions) {
    if (typeof options.token !== 'string' || options.token.length === 0) {
      // Fail closed: never serve hook payloads without a token by accident.
      throw new Error('HookServer needs a non-empty token');
    }
    this.tokenDigest = sha256(options.token);
    this.requestedPort = options.port ?? DEFAULT_HOOK_PORT;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.now = options.now ?? Date.now;
    this.onHook = options.onHook;
    this.onTelemetryLogs = options.onTelemetryLogs;
    this.onStatusline = options.onStatusline;
    this.onHandlerError = options.onHandlerError;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 2000;
    this.decideHook = options.decideHook;
    this.onHoldRefused = options.onHoldRefused;
    this.maxHeldResponses = options.maxHeldResponses ?? MAX_HELD_RESPONSES;

    const serverOptions: http.ServerOptions = {};
    if (options.connectionsCheckingIntervalMs !== undefined) {
      serverOptions.connectionsCheckingInterval = options.connectionsCheckingIntervalMs;
    }
    this.server = http.createServer(serverOptions, (req, res) => {
      this.handle(req, res).catch(() => {
        // Last resort: never leave a request unanswered, never leak details.
        if (!res.headersSent) this.sendJson(res, 500, { error: 'internal error' }, true);
        else res.destroy();
      });
    });
    // Slow-client guards: a stalled upload must not pin a socket forever. Node checks both only until the
    // request has been fully received, so they never cut a held response (pinned by hook-server.hold.test.ts).
    this.server.headersTimeout = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
    this.server.requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // No socket idle timeout: a held response is silent for up to the hook timeout (600 s). Node's default is
    // already 0; it is set so a changed default cannot cut holds. keepAliveTimeout only runs between requests.
    this.server.timeout = 0;
    this.server.maxConnections = MAX_CONNECTIONS;
  }

  /** Starts listening on 127.0.0.1. Rejects with `PortInUseError` when the port is taken. */
  start(): Promise<{ host: string; port: number }> {
    if (this.state !== 'idle') return Promise.reject(new Error(`HookServer cannot start: it is ${this.state}`));
    this.state = 'starting';
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        this.state = 'closed';
        reject(error.code === 'EADDRINUSE' ? new PortInUseError(this.requestedPort, { cause: error }) : error);
      };
      this.server.once('error', onError);
      this.server.listen({ port: this.requestedPort, host: HOST, exclusive: true }, () => {
        this.server.off('error', onError);
        this.state = 'listening';
        const address = this.address();
        if (address === null) {
          reject(new Error('HookServer is listening but has no address'));
          return;
        }
        resolve(address);
      });
    });
  }

  /** The bound address, or null when not listening. */
  address(): { host: string; port: number } | null {
    const address = this.server.address();
    if (address === null || typeof address === 'string') return null;
    const info: AddressInfo = address;
    return { host: info.address, port: info.port };
  }

  /** A copy of the counters. */
  stats(): HookServerStats {
    return { ...this.counters };
  }

  /** Number of hook responses held right now. */
  heldCount(): number {
    return this.held.size;
  }

  /**
   * Answers every held response with an empty 200 (no decision) and calls each hold's `onClosed` listeners
   * with `'shutdown'`. Returns how many holds it released. `close()` calls it first. A consumer that wants to
   * record its own shutdown endings can `respond(null)` to its holds before calling `close()`; those holds are
   * then already ended and not reported again.
   */
  releaseAll(): number {
    const releases = [...this.held];
    for (const release of releases) release();
    return releases.length;
  }

  /**
   * Stops accepting connections and resolves once every connection is gone. Every held response is answered
   * first with no decision (`releaseAll()`, ending `'shutdown'`), so no agent waits on a closing Huddle. Idle
   * keep-alive sockets are closed at once; in-flight requests still get their answer (sent with
   * `Connection: close`). After `closeTimeoutMs` any remaining connection is cut.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === 'idle' || this.state === 'closed') {
      this.state = 'closed';
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    this.state = 'closing';
    this.releaseAll();
    this.closePromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.server.closeAllConnections();
      }, this.closeTimeoutMs);
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

  // ---------------------------------------------------------------------------
  // Request handling
  // ---------------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const receivedAt = this.now();
    this.counters.requests += 1;

    // Order as in the spike: browsers first, then the token, then routing.
    if (req.headers.origin !== undefined) {
      this.counters.originRejected += 1;
      this.sendJson(res, 403, { error: 'browser requests are not accepted' }, true);
      return;
    }
    if (!this.authorized(req)) {
      this.counters.unauthorized += 1;
      this.sendJson(res, 401, { error: 'missing or wrong X-Huddle-Token header' }, true);
      return;
    }
    const route = matchRoute(this.pathname(req));
    if (route === null) {
      this.counters.notFound += 1;
      this.sendJson(res, 404, { error: 'not found' }, true);
      return;
    }
    if (req.method !== 'POST') {
      this.counters.methodNotAllowed += 1;
      res.setHeader('allow', 'POST');
      this.sendJson(res, 405, { error: 'use POST' }, true);
      return;
    }

    const read = await this.readBody(req, res);
    if (!read.ok) {
      // oversized: already answered 200 and counted. aborted: the client is gone, nobody to answer.
      if (read.reason !== 'bad_gzip') return;
      this.counters.badRequests += 1;
      this.sendJson(res, 400, { error: 'invalid gzip body' });
      return;
    }

    if (route.kind === 'hook') {
      this.handleHook(read.body, receivedAt, res);
      return;
    }
    if (route.kind === 'statusline') {
      this.handleStatusline(read.body, receivedAt, res);
      return;
    }

    if (route.signal !== 'logs') {
      // Metrics and traces are accepted and discarded: only OTLP logs (api_request records) feed the Huddle.
      this.sendJson(res, 200, {});
      return;
    }
    const doc = this.parseJson(read.body);
    if (!doc.ok) {
      this.counters.badRequests += 1;
      this.sendJson(res, 400, { error: 'body is not valid JSON' });
      return;
    }
    this.counters.telemetryLogsAccepted += 1;
    this.sendJson(res, 200, {});
    const handler = this.onTelemetryLogs;
    if (handler) this.dispatch(() => handler(doc.value, receivedAt));
  }

  private handleHook(body: Buffer, receivedAt: number, res: http.ServerResponse): void {
    const doc = this.parseJson(body);
    const result: ParseHookResult = doc.ok
      ? parseHookPayload(doc.value)
      : { ok: false, error: 'body is not valid JSON' };
    if (!result.ok) {
      // A clean 400: no stack, no echo of the body (result.error holds field paths and codes only).
      // HTTP hooks treat a non-2xx answer as a non-blocking error, so the session proceeds.
      this.counters.badRequests += 1;
      this.sendJson(res, 400, { error: result.error });
    } else {
      this.counters.hooksAccepted += 1;
      this.replyToHook(result, receivedAt, res);
    }
    this.dispatch(() => this.onHook(result, receivedAt));
  }

  /**
   * Status line bridge (F9). The edge checks (Origin, token, method, body cap, gzip) already ran, exactly as for hooks.
   * Answers at once and works later. The wrapper does not read the answer, so a 400 shows only in counters and logs.
   */
  private handleStatusline(body: Buffer, receivedAt: number, res: http.ServerResponse): void {
    const doc = this.parseJson(body);
    const result: ParseStatuslineResult = doc.ok
      ? parseStatuslinePayload(doc.value)
      : { ok: false, error: 'body is not valid JSON' };
    if (!result.ok) {
      this.counters.badRequests += 1;
      this.sendJson(res, 400, { error: result.error });
    } else {
      this.counters.statuslineAccepted += 1;
      this.sendEmpty(res, 200);
    }
    const handler = this.onStatusline;
    if (handler) this.dispatch(() => handler(result, receivedAt));
  }

  /**
   * Without `decideHook`: an empty 200 ("no decision"). With it: answer at once with its body, or hold.
   * Every failure of the consumer fails open: empty 200, error counted.
   */
  private replyToHook(result: AcceptedHook, receivedAt: number, res: http.ServerResponse): void {
    const decide = this.decideHook;
    if (decide === undefined) {
      this.sendEmpty(res, 200);
      return;
    }
    let decision: unknown;
    try {
      decision = decide(result, receivedAt);
    } catch (error) {
      this.handlerFailed(error);
      this.sendEmpty(res, 200);
      return;
    }
    if (typeof decision === 'object' && decision !== null) {
      const hold: unknown = (decision as { hold?: unknown }).hold;
      if (typeof hold === 'function') {
        this.startHold(hold as (handle: HeldHandle) => void, result, receivedAt, res);
        return;
      }
      this.sendBody(res, (decision as { now?: unknown }).now);
      return;
    }
    this.sendEmpty(res, 200);
  }

  /**
   * Holds the response. Endings: `respond` (user or rule), `res` 'close' before the answer was written
   * (closed by Claude Code), `releaseAll` (shutdown). Each one ends the hold exactly once.
   */
  private startHold(
    hold: (handle: HeldHandle) => void,
    result: AcceptedHook,
    receivedAt: number,
    res: http.ServerResponse,
  ): void {
    let refused: HoldRefusedReason | null = null;
    if (this.state !== 'listening') refused = 'closing';
    else if (this.held.size >= this.maxHeldResponses) refused = 'cap';
    if (refused !== null) {
      const why = refused;
      this.counters.holdsRefused += 1;
      this.sendEmpty(res, 200);
      const notify = this.onHoldRefused;
      if (notify) {
        this.dispatch(() => {
          notify(result, receivedAt, why);
        });
      }
      return;
    }

    let ending: 'responded' | HoldClosedReason | null = null;
    const listeners: ((why: HoldClosedReason) => void)[] = [];
    const callListener = (cb: (why: HoldClosedReason) => void, why: HoldClosedReason): void => {
      try {
        cb(why);
      } catch (error) {
        this.handlerFailed(error);
      }
    };
    const notifyClosed = (why: HoldClosedReason): void => {
      for (const cb of listeners.splice(0)) callListener(cb, why);
    };
    // Watch the response, not the request: `req` 'close' fires as soon as the body has been read.
    const onClose = (): void => {
      if (res.writableFinished) return;
      if (!end('closed_by_claude_code')) return;
      this.counters.holdsClosedByClaudeCode += 1;
      notifyClosed('closed_by_claude_code');
    };
    const release = (): void => {
      if (!end('shutdown')) return;
      this.counters.holdsReleased += 1;
      this.sendEmpty(res, 200);
      notifyClosed('shutdown');
    };
    const end = (how: 'responded' | HoldClosedReason): boolean => {
      if (ending !== null) return false;
      ending = how;
      this.held.delete(release);
      this.counters.heldNow = this.held.size;
      res.off('close', onClose);
      return true;
    };
    const handle: HeldHandle = {
      respond: (body) => {
        // The socket is gone but 'close' has not been emitted yet: that is Claude Code closing, not an answer.
        if (ending === null && res.destroyed) onClose();
        if (!end('responded')) return false;
        listeners.length = 0;
        this.sendBody(res, body);
        return true;
      },
      onClosed: (cb) => {
        if (ending === null) {
          listeners.push(cb);
          return;
        }
        if (ending === 'responded') return;
        const why = ending;
        queueMicrotask(() => {
          callListener(cb, why);
        });
      },
      get closed() {
        return ending !== null;
      },
    };

    this.held.add(release);
    this.counters.holdsStarted += 1;
    this.counters.heldNow = this.held.size;
    res.on('close', onClose);
    try {
      hold(handle);
    } catch (error) {
      this.handlerFailed(error);
      handle.respond(null);
      return;
    }
    // The client may have gone while the body was being parsed, before 'close' was watched.
    if (res.destroyed || res.socket === null || res.socket.destroyed) onClose();
  }

  /** 200 with a JSON body, or an empty 200 for null. A body that is not an object or cannot be serialized fails open. */
  private sendBody(res: http.ServerResponse, body: unknown): void {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      this.sendEmpty(res, 200);
      return;
    }
    let text: string;
    try {
      text = JSON.stringify(body);
    } catch (error) {
      this.handlerFailed(error);
      this.sendEmpty(res, 200);
      return;
    }
    this.sendText(res, 200, text);
  }

  /** Runs a handler after the response, on a later tick. Nothing it does can reach the caller. */
  private dispatch(run: () => unknown): void {
    setImmediate(() => {
      try {
        const outcome = run();
        if (isPromiseLike(outcome)) {
          outcome.then(undefined, (error: unknown) => {
            this.handlerFailed(error);
          });
        }
      } catch (error) {
        this.handlerFailed(error);
      }
    });
  }

  private handlerFailed(error: unknown): void {
    this.counters.handlerErrors += 1;
    try {
      this.onHandlerError?.(error);
    } catch {
      // The error reporter itself failed; there is nowhere left to report to.
    }
  }

  private authorized(req: http.IncomingMessage): boolean {
    const got = req.headers[TOKEN_HEADER];
    if (typeof got !== 'string') return false;
    // Comparing fixed-length digests keeps the compare constant-time and does not leak the token length.
    return timingSafeEqual(sha256(got), this.tokenDigest);
  }

  private pathname(req: http.IncomingMessage): string {
    try {
      return new URL(req.url ?? '/', `http://${HOST}`).pathname;
    } catch {
      return '/';
    }
  }

  private parseJson(body: Buffer): { ok: true; value: unknown } | { ok: false } {
    try {
      const value: unknown = JSON.parse(body.toString('utf8'));
      return { ok: true, value };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Reads the body up to the limit. Over the limit (by Content-Length, while streaming, or after gzip):
   * answer 200 with an empty body straight away, count it, and discard the rest without buffering.
   */
  private readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<BodyResult> {
    return new Promise((resolve) => {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
        this.dropOversized(req, res);
        resolve({ ok: false, reason: 'oversized' });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let dropped = false;
      const onData = (chunk: Buffer) => {
        if (dropped) return;
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          dropped = true;
          chunks.length = 0;
          req.off('data', onData);
          this.dropOversized(req, res);
          resolve({ ok: false, reason: 'oversized' });
          return;
        }
        chunks.push(chunk);
      };
      req.on('data', onData);
      req.on('error', () => {
        // The client went away mid-upload. Nobody is waiting for an answer.
        if (!dropped) resolve({ ok: false, reason: 'aborted' });
        dropped = true;
      });
      req.on('end', () => {
        if (dropped) return;
        const raw = Buffer.concat(chunks);
        const encoding = req.headers['content-encoding'];
        if (typeof encoding !== 'string' || !encoding.toLowerCase().includes('gzip')) {
          resolve({ ok: true, body: raw });
          return;
        }
        gunzip(raw, { maxOutputLength: this.maxBodyBytes }).then(
          (body) => {
            resolve({ ok: true, body });
          },
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException | null)?.code === 'ERR_BUFFER_TOO_LARGE') {
              this.dropOversized(req, res);
              resolve({ ok: false, reason: 'oversized' });
            } else {
              resolve({ ok: false, reason: 'bad_gzip' });
            }
          },
        );
      });
    });
  }

  /** Answers 200 (empty) and closes the connection after it, discarding up to 4x the limit more. */
  private dropOversized(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.counters.oversizedDropped += 1;
    this.sendEmpty(res, 200, true);
    let discarded = 0;
    const cap = this.maxBodyBytes * 4;
    req.on('data', (chunk: Buffer) => {
      discarded += chunk.length;
      if (discarded > cap) req.socket.destroy();
    });
    req.resume();
  }

  private sendEmpty(res: http.ServerResponse, status: number, closeConnection = false): void {
    if (res.headersSent) return;
    const headers: http.OutgoingHttpHeaders = { 'content-length': 0 };
    if (closeConnection || this.state === 'closing') headers.connection = 'close';
    res.writeHead(status, headers);
    res.end();
  }

  /**
   * `closeConnection` is set when the body was not read (rejections before reading): the socket is
   * closed after the answer instead of Node draining an unbounded body to keep it alive.
   */
  private sendJson(res: http.ServerResponse, status: number, body: object, closeConnection = false): void {
    this.sendText(res, status, JSON.stringify(body), closeConnection);
  }

  private sendText(res: http.ServerResponse, status: number, text: string, closeConnection = false): void {
    if (res.headersSent || res.destroyed) return;
    const headers: http.OutgoingHttpHeaders = {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    };
    if (closeConnection || this.state === 'closing') headers.connection = 'close';
    res.writeHead(status, headers);
    res.end(text);
  }
}

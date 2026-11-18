/**
 * Secret masking (SECURITY.md, "Secrets end up in the event log").
 *
 * `maskSecrets(text)` replaces the value of common secret shapes with `<redacted>` and keeps the name, so a
 * timeline still reads "Authorization: Bearer <redacted>" or "API_KEY=<redacted>". It is applied by the normalizers
 * to every free-text field they emit, and again by the event store's serializer as a defensive pass.
 *
 * Pure and fast: every pattern is anchored on a literal or bounded, so there is no catastrophic backtracking, and the
 * KEY=value rule is a hand-written scanner over keyword hits instead of one big regex. Masking is idempotent.
 * It is a best-effort pass over known shapes, not a guarantee: a secret in an unknown format stays visible.
 */

export const REDACTED = '<redacted>';

/**
 * How far past a clip limit a caller reads before masking (A1-01): masking huge text costs time on the event loop, but
 * a secret that straddles the limit must still be whole when it is masked, so the caller masks `limit + MASK_MARGIN`
 * characters and then clips to `limit`. Longer than any bounded pattern's longest match (4096 plus its prefix); a PEM
 * block cut by the pre-clip has no END line and is masked to the end of the text.
 */
export const MASK_MARGIN = 8192;

/**
 * `-----BEGIN … PRIVATE KEY-----` up to the matching END line, or to the end of the text when it was clipped. Greedy on
 * purpose: the key may be indented, folded onto one line with spaces, or escaped in JSON. A command hidden in a value
 * this masks is not shown on an approval card either: the summary is then flagged `hidden` (AX-01, normalize/hooks.ts).
 */
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]{0,40})PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g;

/** `Authorization: Bearer x`, `authorization=Basic x`, `"Authorization": "Token x"`. */
const AUTH_HEADER =
  /\b(Authorization["']?[ \t]{0,3}[:=][ \t]{0,3}["']?)(?:(Bearer|Basic|Token|Digest)[ \t]{1,3})?([^\s"',;]{1,4096})/gi;

/** A bare bearer credential (e.g. in a curl argument without the header name). */
const BEARER = /\bBearer[ \t]{1,3}[A-Za-z0-9._~+/-]{8,4096}=*/g;

/** Vendor tokens with a recognizable prefix. The prefix is kept so the reader knows what kind of secret it was. */
const PREFIXED: readonly RegExp[] = [
  // Bounded (A1-01): an unbounded run of millions of token characters made V8 throw a RangeError.
  /\b(sk-)[A-Za-z0-9_-]{16,4096}/g, // OpenAI, Anthropic (sk-ant-…)
  /\b(gh[opusr]_)[A-Za-z0-9]{20,4096}/g, // GitHub classic tokens
  /\b(github_pat_)[A-Za-z0-9_]{20,4096}/g, // GitHub fine-grained tokens
  /\b(AKIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(xox[baprs]-)[A-Za-z0-9-]{8,4096}/g, // Slack
];

/** `scheme://user:password@host`: the password goes, the user stays. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{1,15}:\/\/[^\s:@/]{1,256}:)([^\s@/]{1,256})@/gi;

/** Names that mark a secret. The scanner checks what follows the hit (see `isSecretName`). */
const KEYWORD = /api[_-]?key|secret|token|passw(?:or)?d|pwd|credential/gi;

/** A separate instance for `isSecretName`, so it never moves the scanner's `lastIndex`. */
const NAME_KEYWORD = new RegExp(KEYWORD.source, 'gi');

const MAX_KEY_SIDE = 64;

function isKeyChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f || // _
    code === 0x2d || // -
    code === 0x2e // .
  );
}

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z]/.test(ch);
}

/**
 * True when a key name names a secret: it contains a keyword that is not the start of a longer word, so
 * `GITHUB_TOKEN`, `api-key`, `db.password` and `client_secrets` count, `max_tokens` and `tokenizer` do not.
 */
export function isSecretName(name: string): boolean {
  NAME_KEYWORD.lastIndex = 0;
  for (let m = NAME_KEYWORD.exec(name); m !== null; m = NAME_KEYWORD.exec(name)) {
    const at = m.index + m[0].length;
    const next = name[at];
    if (!isLetter(next)) return true;
    const word = m[0].toLowerCase();
    if ((word === 'secret' || word === 'credential') && (next === 's' || next === 'S') && !isLetter(name[at + 1])) {
      return true;
    }
  }
  return false;
}

/** Separator after a key: optional closing quote, then `:` or `=` with a little space around it. */
const SEPARATOR = /["']?[ \t]{0,3}[:=][ \t]{0,3}/y;
/** After a `--flag`, the value may follow a space instead. */
const FLAG_SEPARATOR = /[ \t]{1,3}/y;
const VALUE = /"[^"\n]{0,1024}"|'[^'\n]{0,1024}'|[^\s"'&;,)}\]]{1,1024}/y;
/** Placeholders this module (or the installer's diff) writes; masking them again would change nothing useful. */
const PLACEHOLDER = /^["']?<[a-z ]{1,20}>["']?$/;

/** `KEY=value`, `KEY: value`, `"key": "value"`, `--password x` where KEY names a secret. */
function maskAssignments(text: string): string {
  let out = '';
  let copied = 0;
  KEYWORD.lastIndex = 0;
  for (let m = KEYWORD.exec(text); m !== null; m = KEYWORD.exec(text)) {
    let end = m.index + m[0].length;
    for (let n = 0; end < text.length && n < MAX_KEY_SIDE && isKeyChar(text.charCodeAt(end)); n++) end++;
    KEYWORD.lastIndex = Math.max(end, m.index + 1);
    // Cheapest test first: most keyword hits ("tokens", "secretary") are not followed by a separator.
    SEPARATOR.lastIndex = end;
    let valueAt = SEPARATOR.exec(text) ? SEPARATOR.lastIndex : -1;
    let start = m.index;
    for (let n = 0; start > copied && n < MAX_KEY_SIDE && isKeyChar(text.charCodeAt(start - 1)); n++) start--;
    // The key scan includes leading dashes, so a command-line flag starts with `--`.
    if (valueAt < 0 && text.startsWith('--', start)) {
      FLAG_SEPARATOR.lastIndex = end;
      valueAt = FLAG_SEPARATOR.exec(text) ? FLAG_SEPARATOR.lastIndex : -1;
    }
    if (valueAt < 0 || !isSecretName(text.slice(start, end))) continue;
    VALUE.lastIndex = valueAt;
    const value = VALUE.exec(text);
    if (value === null || PLACEHOLDER.test(value[0])) continue;
    const quote = value[0][0] === '"' || value[0][0] === "'" ? value[0][0] : '';
    out += `${text.slice(copied, valueAt)}${quote}${REDACTED}${quote}`;
    copied = valueAt + value[0].length;
    KEYWORD.lastIndex = copied;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * Masks common secret shapes in free text. Pure, idempotent, linear in the length of the text.
 * Covered: Authorization headers and bearer tokens, `sk-…`, GitHub (`ghp_`, `gho_`, `github_pat_`…), AWS access key
 * ids, Slack `xox?-` tokens, PEM private key blocks, `KEY=value` / `KEY: value` / `--password x` where KEY names a
 * secret, and the password in `https://user:pass@host`.
 */
export function maskSecrets(text: string): string {
  if (text.length === 0) return text;
  let out = text;
  if (out.includes('-----BEGIN '))
    out = out.replace(PEM_BLOCK, (_m, kind: string) => `-----BEGIN ${kind}PRIVATE KEY-----${REDACTED}`);
  out = out.replace(AUTH_HEADER, (_m, head: string, scheme: string | undefined, value: string) =>
    PLACEHOLDER.test(value) ? _m : `${head}${scheme !== undefined ? `${scheme} ` : ''}${REDACTED}`,
  );
  out = out.replace(BEARER, `Bearer ${REDACTED}`);
  for (const pattern of PREFIXED) out = out.replace(pattern, (_m, prefix: string) => `${prefix}${REDACTED}`);
  if (out.includes('://')) out = out.replace(URL_USERINFO, (_m, head: string) => `${head}${REDACTED}@`);
  return maskAssignments(out);
}

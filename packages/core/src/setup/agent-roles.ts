/**
 * Role descriptions from subagent definition files (F3, ADR-015 `role.described`).
 *
 * Claude Code reads subagents from `<project>/.claude/agents/*.md` and `~/.claude/agents/*.md`: a YAML frontmatter
 * block with `name` and `description`, then the system prompt (docs/INTEGRATION.md §4). The Huddle needs only those
 * two fields, so this is a small dependency-free reader, not a YAML parser (the M1 plan rules out a YAML dependency).
 *
 * - `parseFrontmatter` / `parseAgentDefinition` are pure and never throw.
 * - `readAgentRoles` is the I/O edge: it lists the two folders. The user folder is injected (never read from the real
 *   home directory in tests). A project definition wins over a user one with the same name, as in Claude Code.
 * - `roleDescribedEvents` turns roles into events; ids and the time are passed in.
 */
import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { CLIP_LIMITS, type RoleDescribed } from '@huddle/shared';
import { isLocalAbsolutePath } from '../runtime/paths.js';
import { stripBom } from './install-hooks.js';

export interface RoleInfo {
  role: string;
  description: string;
  definedIn: 'project' | 'user';
  filePath: string;
}

/** Only the leading part of a file is read: frontmatter is at the top, and a huge file must not be loaded whole. */
export const MAX_DEFINITION_BYTES = 64 * 1024;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function unquoteDouble(body: string): string {
  return body.replace(/\\(["\\/nrt]|u[0-9a-fA-F]{4})/g, (_m, esc: string) => {
    switch (esc[0]) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u':
        return String.fromCharCode(parseInt(esc.slice(1), 16));
      default:
        return esc;
    }
  });
}

/** A quoted scalar that may continue over several lines; returns null when it never closes. */
function readQuoted(first: string, rest: string[]): { value: string; used: number } | null {
  const quote = first[0];
  let text = first.slice(1);
  let used = 0;
  for (;;) {
    const close = quote === '"' ? findDoubleClose(text) : findSingleClose(text);
    if (close !== -1) {
      const body = text.slice(0, close);
      const folded = body.replace(/[ \t]*\n[ \t]*/g, ' ');
      return { value: quote === '"' ? unquoteDouble(folded) : folded.replace(/''/g, "'"), used };
    }
    const next = rest[used];
    if (next === undefined) return null;
    text = `${text}\n${next}`;
    used += 1;
  }
}

function findDoubleClose(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

function findSingleClose(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'") {
      if (text[i + 1] === "'") i++;
      else return i;
    }
  }
  return -1;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** `|` keeps line breaks, `>` folds them into spaces (a blank line stays a break). Chomping: `-` strips, else one. */
function readBlock(indicator: string, rest: string[]): { value: string; used: number } {
  const lines: string[] = [];
  let used = 0;
  let indent = -1;
  for (const line of rest) {
    if (line.trim() === '') {
      lines.push('');
      used += 1;
      continue;
    }
    const ind = indentOf(line);
    if (ind === 0 || (indent !== -1 && ind < indent)) break;
    if (indent === -1) indent = ind;
    lines.push(line.slice(indent));
    used += 1;
  }
  // trailing blank lines belong to the chomping, not the content
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  let value: string;
  if (indicator.startsWith('|')) {
    value = lines.join('\n');
  } else {
    value = '';
    for (const line of lines) {
      if (line === '') value += '\n';
      else value += value === '' || value.endsWith('\n') ? line : ` ${line}`;
    }
  }
  if (!indicator.includes('-') && value !== '') value += '\n';
  return { value, used };
}

/** A plain scalar may continue on more-indented lines; they fold into spaces. ` #` starts a comment. */
function readPlain(first: string, rest: string[]): { value: string; used: number } {
  const parts = [first.replace(/\s+#.*$/, '').trim()];
  let used = 0;
  for (const line of rest) {
    if (line.trim() === '' || indentOf(line) === 0) break;
    parts.push(line.trim());
    used += 1;
  }
  return { value: parts.filter(Boolean).join(' '), used };
}

/**
 * Parses only the leading `---` block into top-level string fields. Returns null when the text has no frontmatter.
 * Lists, nested maps and anything it does not understand are skipped, never thrown on.
 */
export function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = stripBom(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trimEnd() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && (l.trimEnd() === '---' || l.trimEnd() === '...'));
  if (end === -1) return null;
  const block = lines.slice(1, end);
  const fields: Record<string, string> = {};
  for (let i = 0; i < block.length; i++) {
    const line = block[i] ?? '';
    if (indentOf(line) !== 0 || line.startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (!m?.[1]) continue;
    const key = m[1];
    const raw = (m[2] ?? '').trim();
    const rest = block.slice(i + 1);
    let parsed: { value: string; used: number } | null;
    if (raw.startsWith('"') || raw.startsWith("'")) parsed = readQuoted(raw, rest);
    else if (/^[|>][+-]?\d?(\s+#.*)?$/.test(raw)) parsed = readBlock(raw, rest);
    else if (raw === '') {
      // a nested map or list follows (e.g. `tools:` then `- Read`): skip its lines, keep no value
      let used = 0;
      while (
        rest[used] !== undefined &&
        (rest[used]?.trim() === '' || indentOf(rest[used] ?? '') > 0 || rest[used]?.startsWith('-'))
      )
        used += 1;
      i += used;
      continue;
    } else parsed = readPlain(raw, rest);
    if (parsed === null) break; // an unterminated quote: stop, keep what was read
    fields[key] = parsed.value;
    i += parsed.used;
  }
  return fields;
}

/** Pure: one definition file's text to a role, or null when it has no usable `name` and `description`. */
export function parseAgentDefinition(text: string, filePath: string, definedIn: 'project' | 'user'): RoleInfo | null {
  let fields: Record<string, string> | null;
  try {
    fields = parseFrontmatter(text);
  } catch {
    return null;
  }
  const name = fields?.name?.trim();
  const description = fields?.description?.trim();
  if (!name || !description) return null;
  return {
    role: clip(name, CLIP_LIMITS.summary),
    description: clip(description, CLIP_LIMITS.description),
    definedIn,
    filePath,
  };
}

async function readHead(file: string): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(file, 'r');
    const buffer = Buffer.alloc(MAX_DEFINITION_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_DEFINITION_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readFolder(dir: string, definedIn: 'project' | 'user'): Promise<RoleInfo[]> {
  let names: string[];
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')).map((e) => e.name);
  } catch {
    return [];
  }
  names.sort();
  const roles: RoleInfo[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    const text = await readHead(filePath);
    if (text === null) continue;
    const role = parseAgentDefinition(text, filePath, definedIn);
    if (role) roles.push(role);
  }
  return roles;
}

export interface AgentRoleSources {
  /** The session's working directory; project definitions are read from <cwd>/.claude/agents. Null: none. */
  cwd: string | null;
  /** The user's agents folder, normally <Claude config dir>/agents. Injected; null to skip. */
  userAgentsDir: string | null;
}

/**
 * Lists both folders (the project one only for a local absolute cwd) and returns one role per name. A project definition wins over a user one with the same name;
 * within a folder the first file in name order wins. Missing folders and unreadable files are skipped.
 */
export async function readAgentRoles(sources: AgentRoleSources): Promise<RoleInfo[]> {
  // The cwd comes from the event log. A UNC or device path would make Windows offer credentials to a remote host.
  const project = isLocalAbsolutePath(sources.cwd)
    ? await readFolder(path.join(path.resolve(sources.cwd), '.claude', 'agents'), 'project')
    : [];
  const user = sources.userAgentsDir ? await readFolder(path.resolve(sources.userAgentsDir), 'user') : [];
  const byName = new Map<string, RoleInfo>();
  for (const role of [...project, ...user]) if (!byName.has(role.role)) byName.set(role.role, role);
  return [...byName.values()];
}

export interface RoleEventContext {
  sessionId: string;
  /** Epoch ms, from the caller's clock. */
  ts: number;
  nextId: () => string;
}

/** Pure: roles to `role.described` events, recorded at session level and derived by the Huddle itself. */
export function roleDescribedEvents(roles: readonly RoleInfo[], ctx: RoleEventContext): RoleDescribed[] {
  return roles.map((r) => ({
    id: ctx.nextId(),
    type: 'role.described',
    ts: ctx.ts,
    sessionId: ctx.sessionId,
    agentKey: ctx.sessionId,
    source: 'huddle',
    role: r.role,
    description: r.description,
    definedIn: r.definedIn,
    filePath: r.filePath,
  }));
}

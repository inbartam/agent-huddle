/**
 * The team templates file (M4, F16/F17): `<dataDir>/templates.json`, next to policy-rules.json. The Huddle's own file.
 *
 * Format: `{ "version": 1, "templates": TeamTemplate[] }`. A missing file is an empty list. Anything wrong with the file
 * (not JSON, wrong shape, an invalid template, two templates with one id, a newer version) also gives an empty list and
 * a warning for the log: never an exception. Unlike the rules there is no safe default to fall back to, and a template
 * only launches when the user presses Launch, so an empty list is the safe reading. Unknown fields are kept (zod
 * `looseObject`), so a template a newer build wrote keeps what this build does not know.
 *
 * Because a bad file reads as empty, the next save would overwrite what the user had: before that first write the bad
 * file is moved aside to `templates.json.bad-<epoch ms>` (`preserveBadTemplatesFile`), never deleted.
 *
 * Writes are atomic and owner-only (`writeTextAtomic`). `upsertTemplate` and `removeTemplate` are pure list edits;
 * HuddleCore writes and then adopts the result.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { TeamTemplate } from '@huddle/shared';
import { teamTemplateSchema } from '../contracts/m4-schemas.js';
import { maskSecrets, REDACTED } from '../privacy/redact.js';
import { preserveBadFile, writeTextAtomic } from './atomic-file.js';

export const TEMPLATES_FILENAME = 'templates.json';
export const TEMPLATES_VERSION = 1;
/** More templates than anyone keeps; bounds the file and the state sent to the renderer. */
export const MAX_TEMPLATES = 200;

const fileSchema = z.looseObject({
  version: z.number().int().positive(),
  templates: z.array(teamTemplateSchema).max(MAX_TEMPLATES),
});

export interface TemplatesLoad {
  templates: TeamTemplate[];
  /** Why the file was not used (the list is then empty), or null. Never carries file contents. */
  warning: string | null;
  /** True when a file exists but was not used: it is moved aside before the next write. */
  bad: boolean;
}

/** Pure: file text (null: no file) to templates. Never throws. */
export function parseTemplates(text: string | null): TemplatesLoad {
  if (text === null) return { templates: [], warning: null, bad: false };
  const empty = (why: string): TemplatesLoad => ({
    templates: [],
    warning: `${TEMPLATES_FILENAME} ${why}; no templates loaded`,
    bad: true,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return empty('is not valid JSON');
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return empty('has an invalid template');
  if (parsed.data.version > TEMPLATES_VERSION) return empty('is from a newer version');
  const templates: TeamTemplate[] = parsed.data.templates;
  if (new Set(templates.map((t) => t.id)).size !== templates.length) return empty('has two templates with one id');
  return { templates, warning: null, bad: false };
}

export function serializeTemplates(templates: readonly TeamTemplate[]): string {
  return `${JSON.stringify({ version: TEMPLATES_VERSION, templates }, null, 2)}\n`;
}

/** Pure: the list with `template` added, or replacing the template with its id in place. */
export function upsertTemplate(templates: readonly TeamTemplate[], template: TeamTemplate): TeamTemplate[] {
  const index = templates.findIndex((t) => t.id === template.id);
  if (index < 0) return [...templates, template];
  return templates.map((t, i) => (i === index ? template : t));
}

/** Pure: the list without the template with this id (the same list when there is none). */
export function removeTemplate(templates: readonly TeamTemplate[], templateId: string): TeamTemplate[] {
  return templates.filter((t) => t.id !== templateId);
}

// --- secrets in template prompts (M4 security review L4, done in M5 WP5) --------------------------------------------
//
// A template's prompt (and each `--agents` agent's prompt) is stored exactly as the user typed it in templates.json
// (owner-only file), and that exact text is what a launch sends. Everywhere a template leaves the core for display (the
// state the renderer reads), its prompts are masked with `maskSecrets`. There is no separate "edit template" read: the
// editor edits what the state shows. So a save or a launch that sends a prompt back unchanged sends the masked text;
// `restoreMaskedPrompts` puts the stored text back for it, so the prompt that runs never changes.

/** `template.upsert` answers this in `warning` when a prompt looks like it holds a secret (it is still saved). */
export const TEMPLATE_SECRET_WARNING =
  'This prompt looks like it holds a secret; it is stored as typed in templates.json.';

/** Refusal when a prompt still shows a masked secret after a change (the secret itself would be lost). */
export const MASKED_SECRET_EDITED =
  'This prompt still shows <redacted> where Huddle hid a secret. Type the secret again or remove it, then try again.';

/** Pure: the template with every prompt masked, for display. Never used to launch. */
export function maskTemplateForDisplay(template: TeamTemplate): TeamTemplate {
  const shown: TeamTemplate = { ...template, prompt: maskSecrets(template.prompt) };
  if (template.agents !== undefined) {
    shown.agents = Object.fromEntries(
      Object.entries(template.agents).map(([name, agent]) => [name, { ...agent, prompt: maskSecrets(agent.prompt) }]),
    );
  }
  return shown;
}

/** Pure: does any prompt of the template look like it holds a secret? */
export function templateHoldsSecret(template: TeamTemplate): boolean {
  if (maskSecrets(template.prompt) !== template.prompt) return true;
  return Object.values(template.agents ?? {}).some((agent) => maskSecrets(agent.prompt) !== agent.prompt);
}

/** Where a prompt sits in a template: its main prompt (`agent` null) or one `--agents` agent's prompt. */
export interface PromptSlot {
  templateId: string | null;
  agent: string | null;
}

/** Every prompt stored in these templates. */
function storedPrompts(templates: readonly TeamTemplate[]): string[] {
  return templates.flatMap((t) => [t.prompt, ...Object.values(t.agents ?? {}).map((a) => a.prompt)]);
}

/** The stored prompt at this slot, or undefined. */
function promptAt(templates: readonly TeamTemplate[], slot: PromptSlot): string | undefined {
  if (slot.templateId === null) return undefined;
  const stored = templates.find((t) => t.id === slot.templateId);
  if (stored === undefined) return undefined;
  return slot.agent === null ? stored.prompt : stored.agents?.[slot.agent]?.prompt;
}

/**
 * Pure: `text` as it was stored, when it is exactly the masked form of a stored prompt (it came back from the display
 * unchanged); otherwise `text` itself. The stored prompt is the user's own text from templates.json.
 *
 * Which stored prompt (M5 security review L3): the one at the same slot first (the same template id, and the main
 * prompt or the same agent name). Only when that one does not match, any stored prompt, and only when exactly one
 * distinct stored text matches: two different secrets can mask to one text (`TOKEN=a` and `TOKEN=b` both show as
 * `TOKEN=<redacted>`), and guessing would send the wrong secret. Then the answer is null and the caller refuses
 * (MASKED_SECRET_EDITED).
 */
export function restoreMaskedPrompt(text: string, templates: readonly TeamTemplate[], slot: PromptSlot): string | null {
  if (!text.includes(REDACTED)) return text;
  const atSlot = promptAt(templates, slot);
  if (atSlot !== undefined && atSlot !== text && maskSecrets(atSlot) === text) return atSlot;
  const matches = new Set(storedPrompts(templates).filter((raw) => raw !== text && maskSecrets(raw) === text));
  if (matches.size > 1) return null;
  const [only] = matches;
  return only ?? text;
}

/**
 * True when `text` still shows a masked secret that is not the user's own text: it holds `<redacted>`, no stored prompt
 * is literally this text, and some stored prompt masks to a text with `<redacted>` (so Huddle hid a secret). Saving or
 * launching it would replace the secret with the word "<redacted>".
 */
export function showsMaskedSecret(text: string, templates: readonly TeamTemplate[]): boolean {
  if (!text.includes(REDACTED)) return false;
  const raws = storedPrompts(templates);
  if (raws.includes(text)) return false;
  return raws.some((raw) => !raw.includes(REDACTED) && maskSecrets(raw).includes(REDACTED));
}

/**
 * Pure: the template with each masked prompt put back as stored (see `restoreMaskedPrompt`), or null when a prompt
 * matches more than one stored secret (refuse with MASKED_SECRET_EDITED).
 */
export function restoreMaskedPrompts(template: TeamTemplate, templates: readonly TeamTemplate[]): TeamTemplate | null {
  const prompt = restoreMaskedPrompt(template.prompt, templates, { templateId: template.id, agent: null });
  if (prompt === null) return null;
  const restored: TeamTemplate = { ...template, prompt };
  if (template.agents !== undefined) {
    const agents: NonNullable<TeamTemplate['agents']> = {};
    for (const [name, agent] of Object.entries(template.agents)) {
      const agentPrompt = restoreMaskedPrompt(agent.prompt, templates, { templateId: template.id, agent: name });
      if (agentPrompt === null) return null;
      agents[name] = { ...agent, prompt: agentPrompt };
    }
    restored.agents = agents;
  }
  return restored;
}

/** Pure: does any prompt of the template still show a masked secret (see `showsMaskedSecret`)? */
export function templateShowsMaskedSecret(template: TeamTemplate, templates: readonly TeamTemplate[]): boolean {
  if (showsMaskedSecret(template.prompt, templates)) return true;
  return Object.values(template.agents ?? {}).some((agent) => showsMaskedSecret(agent.prompt, templates));
}

export function templatesPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), TEMPLATES_FILENAME);
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
}

/** Reads the templates file. A missing or unreadable file never throws. */
export async function readTemplates(dataDir: string): Promise<TemplatesLoad> {
  let text: string | null;
  try {
    text = await fsp.readFile(templatesPath(dataDir), 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return parseTemplates(null);
    return { templates: [], warning: `${TEMPLATES_FILENAME} could not be read; no templates loaded`, bad: true };
  }
  return parseTemplates(text);
}

/** Moves a file that was not used aside, so the next write does not destroy it. Returns the new name, or null. */
export async function preserveBadTemplatesFile(dataDir: string, now: number): Promise<string | null> {
  return preserveBadFile(templatesPath(dataDir), now);
}

/**
 * Writes templates.json atomically and owner-only (M5 WP5, L4: its prompts are stored as typed). `writeTextAtomic`
 * creates the temp file with mode 0o600; the mode is set again on POSIX in case a file was already there with another
 * one. On Windows the mode bits are mostly ignored and the app data folder is user-only already.
 */
export async function writeTemplates(dataDir: string, templates: readonly TeamTemplate[]): Promise<void> {
  const file = templatesPath(dataDir);
  await writeTextAtomic(file, serializeTemplates(templates));
  if (process.platform !== 'win32') await fsp.chmod(file, 0o600).catch(() => undefined);
}

/**
 * Template prompts and secrets (M4 security review L4, M5 WP5): stored as typed, shown masked, launched as typed. The
 * editor has no raw read, so a masked prompt that comes back unchanged gets its stored text back; one that was edited
 * around a hidden secret is refused rather than saved or launched with the word "<redacted>" in it.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamTemplate } from '@huddle/shared';
import { HuddleCore } from './huddle-core.js';
import { RunHost } from './runs.js';
import {
  MASKED_SECRET_EDITED,
  maskTemplateForDisplay,
  restoreMaskedPrompt,
  restoreMaskedPrompts,
  showsMaskedSecret,
  TEMPLATE_SECRET_WARNING,
  templateHoldsSecret,
  templatesPath,
} from './templates.js';

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
const PROMPT = `Deploy the app. Use ANTHROPIC_API_KEY=${SECRET} for the smoke test.`;

function template(over: Partial<TeamTemplate> = {}): TeamTemplate {
  return {
    id: 'tpl-1',
    name: 'Deploy',
    prompt: PROMPT,
    cwd: 'C:/work',
    mainAgent: null,
    model: null,
    permissionMode: 'default',
    worktree: false,
    agents: { checker: { description: 'Checks', prompt: `Check with token=${SECRET}` } },
    ...over,
  };
}

describe('template prompt masking (pure)', () => {
  it('masks every prompt for display and finds the secret', () => {
    const shown = maskTemplateForDisplay(template());
    expect(shown.prompt).not.toContain(SECRET);
    expect(shown.prompt).toContain('<redacted>');
    expect(shown.agents?.checker?.prompt).not.toContain(SECRET);
    expect(templateHoldsSecret(template())).toBe(true);
    expect(templateHoldsSecret(template({ prompt: 'plain', agents: {} }))).toBe(false);
  });

  it('puts the stored text back for a masked prompt that came back unchanged', () => {
    const stored = [template()];
    const shown = maskTemplateForDisplay(template());
    expect(restoreMaskedPrompts(shown, stored)).toEqual(template());
    // A copy (new id) of the shown template gets the stored texts too.
    expect(restoreMaskedPrompts({ ...shown, id: 'tpl-2' }, stored)?.prompt).toBe(PROMPT);
    expect(restoreMaskedPrompt('new text', stored, { templateId: 'tpl-1', agent: null })).toBe('new text');
  });

  it('flags a masked prompt that was edited around the hidden secret', () => {
    const stored = [template()];
    const edited = `${maskTemplateForDisplay(template()).prompt} And then tell me.`;
    expect(restoreMaskedPrompt(edited, stored, { templateId: 'tpl-1', agent: null })).toBe(edited);
    expect(showsMaskedSecret(edited, stored)).toBe(true);
    // The user's own literal "<redacted>" in a template with no hidden secret is fine.
    expect(showsMaskedSecret('say <redacted>', [template({ prompt: 'say <redacted>', agents: {} })])).toBe(false);
  });

  describe('two secrets that mask to one text (L3)', () => {
    const A = 'Run it with TOKEN=aaaa1111aaaa';
    const B = 'Run it with TOKEN=bbbb2222bbbb';
    const stored = [
      template({ id: 'tpl-a', prompt: A, agents: { helper: { description: 'h', prompt: B } } }),
      template({ id: 'tpl-b', prompt: B, agents: { helper: { description: 'h', prompt: A } } }),
    ];
    const shown = maskTemplateForDisplay(template({ prompt: A, agents: {} })).prompt;

    it('the two prompts show the same masked text', () => {
      expect(shown).toBe(maskTemplateForDisplay(template({ prompt: B, agents: {} })).prompt);
      expect(shown).toContain('<redacted>');
    });

    it('matches by slot first: the same template and the main prompt or the same agent', () => {
      expect(restoreMaskedPrompt(shown, stored, { templateId: 'tpl-a', agent: null })).toBe(A);
      expect(restoreMaskedPrompt(shown, stored, { templateId: 'tpl-b', agent: null })).toBe(B);
      expect(restoreMaskedPrompt(shown, stored, { templateId: 'tpl-a', agent: 'helper' })).toBe(B);
      expect(restoreMaskedPrompt(shown, stored, { templateId: 'tpl-b', agent: 'helper' })).toBe(A);
    });

    it('refuses (null) when no slot matches and more than one stored secret does', () => {
      expect(restoreMaskedPrompt(shown, stored, { templateId: 'copy', agent: null })).toBeNull();
      expect(restoreMaskedPrompt(shown, stored, { templateId: null, agent: null })).toBeNull();
      expect(restoreMaskedPrompt(shown, stored, { templateId: 'tpl-a', agent: 'other' })).toBeNull();
      expect(restoreMaskedPrompts(template({ id: 'copy', prompt: shown, agents: {} }), stored)).toBeNull();
      // An agent prompt that is ambiguous makes the whole template ambiguous.
      expect(
        restoreMaskedPrompts(
          template({ id: 'copy', prompt: 'plain', agents: { x: { description: 'x', prompt: shown } } }),
          stored,
        ),
      ).toBeNull();
    });

    it('falls back across templates when exactly one distinct stored text matches', () => {
      const one = [template({ id: 'tpl-a', prompt: A, agents: {} }), template({ id: 'tpl-c', prompt: A, agents: {} })];
      expect(restoreMaskedPrompt(shown, one, { templateId: 'copy', agent: null })).toBe(A);
    });
  });
});

describe('template prompt masking (HuddleCore)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  async function start(): Promise<{ core: HuddleCore; dataDir: string }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-tpl-mask-'));
    cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const dataDir = path.join(root, 'data');
    await fsp.mkdir(path.join(root, 'claude'), { recursive: true });
    await fsp.writeFile(path.join(root, 'f.mjs'), '// forwarder\n');
    const core = new HuddleCore({
      dataDir,
      claudeConfigDir: path.join(root, 'claude'),
      cwd: null,
      userAgentsDir: null,
      port: 0,
      forwarderSource: path.join(root, 'f.mjs'),
      newToken: () => 'test-token-0123456789',
      history: { backfillAtStart: false, retentionAtStart: false },
    });
    cleanups.push(() => core.dispose());
    expect((await core.start()).ok).toBe(true);
    return { core, dataDir };
  }

  it('warns on save, stores the prompt as typed, and sends the state masked', async () => {
    const { core, dataDir } = await start();
    const saved = await core.command({ type: 'template.upsert', template: template() });
    expect(saved).toEqual({ ok: true, warning: TEMPLATE_SECRET_WARNING });
    const file = await fsp.readFile(templatesPath(dataDir), 'utf8');
    expect(file).toContain(SECRET);
    const shown = core.getState().templates?.[0];
    expect(shown?.prompt).not.toContain(SECRET);
    expect(JSON.stringify(core.getState())).not.toContain(SECRET);
    if (process.platform !== 'win32') expect((await fsp.stat(templatesPath(dataDir))).mode & 0o777).toBe(0o600);

    // The editor saves what it was shown, unchanged: the stored text stays.
    if (shown === undefined) return;
    expect((await core.command({ type: 'template.upsert', template: { ...shown, name: 'Deploy 2' } })).ok).toBe(true);
    expect(await fsp.readFile(templatesPath(dataDir), 'utf8')).toContain(SECRET);
    // Edited around the hidden secret: refused, nothing changes.
    const edited = { ...shown, prompt: `${shown.prompt} More.` };
    expect(await core.command({ type: 'template.upsert', template: edited })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(
      await core.command({ type: 'template.upsert', template: template({ prompt: 'plain', agents: {} }) }),
    ).toEqual({ ok: true });
  });

  it('launches with the prompt as typed: by id, from the shown template inline, and with an unchanged override', async () => {
    const { core } = await start();
    const launched: { prompt: string; agentPrompt: string | undefined; override: string | undefined }[] = [];
    vi.spyOn(RunHost.prototype, 'launch').mockImplementation((t, _id, override) => {
      launched.push({ prompt: t.prompt, agentPrompt: t.agents?.checker?.prompt, override });
      return Promise.resolve({ ok: true, detail: 'run-x' });
    });
    expect((await core.command({ type: 'template.upsert', template: template() })).ok).toBe(true);
    const shown = core.getState().templates?.[0];
    if (shown === undefined) throw new Error('no template');

    expect((await core.command({ type: 'run.launch', templateId: 'tpl-1' })).ok).toBe(true);
    expect((await core.command({ type: 'run.launch', template: { ...shown, id: 'inline-1' } })).ok).toBe(true);
    expect((await core.command({ type: 'run.launch', templateId: 'tpl-1', promptOverride: shown.prompt })).ok).toBe(
      true,
    );
    expect(launched).toEqual([
      { prompt: PROMPT, agentPrompt: `Check with token=${SECRET}`, override: undefined },
      { prompt: PROMPT, agentPrompt: `Check with token=${SECRET}`, override: undefined },
      { prompt: PROMPT, agentPrompt: `Check with token=${SECRET}`, override: PROMPT },
    ]);
    // An override edited around the hidden secret is refused, not launched.
    expect(
      await core.command({ type: 'run.launch', templateId: 'tpl-1', promptOverride: `${shown.prompt} now` }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(launched).toHaveLength(3);
  });

  it('refuses an inline copy whose masked prompt matches two stored secrets, and launches each by id (L3)', async () => {
    const { core } = await start();
    const launched: string[] = [];
    vi.spyOn(RunHost.prototype, 'launch').mockImplementation((t, _id, override) => {
      launched.push(override ?? t.prompt);
      return Promise.resolve({ ok: true, detail: 'run-x' });
    });
    const a = template({ id: 'tpl-a', prompt: 'Go TOKEN=aaaa1111aaaa', agents: {} });
    const b = template({ id: 'tpl-b', prompt: 'Go TOKEN=bbbb2222bbbb', agents: {} });
    expect((await core.command({ type: 'template.upsert', template: a })).ok).toBe(true);
    expect((await core.command({ type: 'template.upsert', template: b })).ok).toBe(true);
    const shownB = core.getState().templates?.find((t) => t.id === 'tpl-b');
    if (shownB === undefined) throw new Error('no template');

    const refused = { ok: false, code: 'invalid', message: MASKED_SECRET_EDITED };
    expect(await core.command({ type: 'run.launch', template: { ...shownB, id: 'inline-1' } })).toEqual(refused);
    expect(await core.command({ type: 'template.upsert', template: { ...shownB, id: 'tpl-new' } })).toEqual(refused);
    // By slot: the override shown for tpl-b goes back to tpl-b's secret, never tpl-a's.
    expect((await core.command({ type: 'run.launch', templateId: 'tpl-b', promptOverride: shownB.prompt })).ok).toBe(
      true,
    );
    expect((await core.command({ type: 'run.launch', template: shownB })).ok).toBe(true);
    expect(launched).toEqual([b.prompt, b.prompt]);
  });
});

/**
 * F28/F29 through a real headless HuddleCore (temp data folder, private port, no `claude`): the commands and queries
 * are routed, tasks are stored on the Huddle's own tasks session and come back after a restart, that session is never
 * listed as a run, and launching a task is refused like any launch while hooks are not attached.
 */
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { payloads } from '../test/broker-sim.js';
import { HuddleCore, TASKS_SESSION_ID } from './huddle-core.js';
import { Orchestrator } from './orchestrator.js';

const TOKEN = 'test-token-0123456789';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function sendHook(port: number, payload: Record<string, unknown>): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/huddle/hooks/${String(payload.hook_event_name)}`,
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
          'x-huddle-token': TOKEN,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

async function start(root: string) {
  const claudeDir = path.join(root, 'claude');
  await fsp.mkdir(claudeDir, { recursive: true });
  const forwarder = path.join(root, 'forwarder.mjs');
  await fsp.writeFile(forwarder, '// test forwarder\n');
  const core = new HuddleCore({
    dataDir: path.join(root, 'data'),
    claudeConfigDir: claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    forwarderSource: forwarder,
    newToken: () => TOKEN,
    batchIntervalMs: 0,
  });
  const started = await core.start();
  if (!started.ok) throw new Error(started.message);
  return { core, port: started.port };
}

describe('HuddleCore: skills and tasks (F28, F29)', () => {
  it('routes the commands, keeps tasks across a restart, never lists the tasks session as a run', async () => {
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-core-orch-')));
    cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 3 }));
    const project = path.join(root, 'work', 'app');
    await fsp.mkdir(project, { recursive: true });

    const first = await start(root);
    expect(await sendHook(first.port, { ...payloads.sessionStart(), cwd: project })).toBe(200);
    expect(await sendHook(first.port, { ...payloads.prompt(), cwd: project })).toBe(200);

    const list = await first.core.query({ type: 'skills.list' });
    expect(list.ok && list.type === 'skills.list' ? list.answer.projects.map((p) => p.path) : null).toEqual([project]);
    const saved = await first.core.command({
      type: 'skill.save',
      projectPath: project,
      name: 'triage',
      description: 'Use when triaging.',
      instructions: 'Ask for steps.',
      overwrite: false,
    });
    expect(saved.ok).toBe(true);
    await expect(
      fsp.readFile(path.join(project, '.claude', 'skills', 'triage', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('Ask for steps.');

    const made = await first.core.command({
      type: 'huddle_task.create',
      title: 'Ship F29',
      details: 'Tasks tab',
      projectPath: project,
      templateId: null,
    });
    expect(made.ok).toBe(true);
    const taskId = made.ok ? (made.detail ?? '') : '';
    // Not attached: the launch path refuses, and the task stays to do.
    const launched = await first.core.command({ type: 'huddle_task.launch', taskId });
    expect(launched).toMatchObject({ ok: false, code: 'unsupported' });
    expect(first.core.getState().huddleTasks?.[0]).toMatchObject({ taskId, status: 'todo', runId: null });
    await first.core.dispose();

    const second = await start(root);
    cleanups.push(() => second.core.dispose());
    expect(second.core.getState().huddleTasks).toMatchObject([{ taskId, title: 'Ship F29', projectPath: project }]);
    // The task's folder stays a known project after the restart even without the session.
    const again = await second.core.query({ type: 'skills.list' });
    expect(again.ok && again.type === 'skills.list' ? again.answer.skills.map((s) => s.dirName) : null).toEqual([
      'triage',
    ]);
    const runs = await second.core.query({ type: 'history.list', limit: 50 });
    expect(runs.ok && runs.type === 'history.list' ? runs.page.rows.map((r) => r.sessionId) : null).not.toContain(
      TASKS_SESSION_ID,
    );
    expect(second.core.getState().rootKeys).not.toContain(TASKS_SESSION_ID);
  });

  it('a throwing task step fails open: the hook is answered and its events are still stored', async () => {
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-core-orch-')));
    cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 3 }));
    const project = path.join(root, 'work', 'app');
    await fsp.mkdir(project, { recursive: true });
    const spy = vi.spyOn(Orchestrator.prototype, 'runStep').mockImplementation(() => {
      throw new Error('task step broke');
    });
    cleanups.push(() => {
      spy.mockRestore();
      return Promise.resolve();
    });
    const first = await start(root);
    expect(await sendHook(first.port, { ...payloads.sessionStart(), cwd: project })).toBe(200);
    expect(await sendHook(first.port, { ...payloads.prompt(), cwd: project })).toBe(200);
    expect(spy).toHaveBeenCalled();
    const roots = first.core.getState().rootKeys.filter((k) => k !== TASKS_SESSION_ID);
    expect(roots).toHaveLength(1);
    await first.core.dispose();
    spy.mockRestore();
    // The batch reached the log: after a restart the session is still there.
    const second = await start(root);
    cleanups.push(() => second.core.dispose());
    expect(second.core.getState().rootKeys.filter((k) => k !== TASKS_SESSION_ID)).toEqual(roots);
  });
});

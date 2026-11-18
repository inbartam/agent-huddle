// Tests for the status line bridge (scripts/huddle-statusline.mjs, F9). Temp config folders only; never ~/.claude.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  loadOriginalCommand,
  main,
  postToHuddle,
  resolveShell,
  runOriginal,
  STATUSLINE_PATH,
} from './huddle-statusline.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'huddle-statusline.mjs');
const TOKEN = 'statusline-token-0123456789';
const INPUT = JSON.stringify({ session_id: 's-1', context_window: { current_usage: null } });

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tempConfig({ original, config = { port: 47821, token: TOKEN } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-sl-'));
  made.push(dir);
  const huddle = path.join(dir, 'agent-huddle');
  fs.mkdirSync(huddle);
  if (config) fs.writeFileSync(path.join(huddle, 'config.json'), JSON.stringify(config));
  if (original !== undefined) {
    fs.writeFileSync(path.join(huddle, 'statusline-original.json'), JSON.stringify({ statusLine: original }));
  }
  return dir;
}

const stdinOf = (text) => Readable.from([Buffer.from(text)]);

test('passes the original through: same stdin, its exit code; the POST gets the same body', async () => {
  const dir = tempConfig({ original: { type: 'command', command: 'my-line --short', padding: 1 } });
  const posted = [];
  const ran = [];
  const code = await main({
    stdin: stdinOf(INPUT),
    configDir: dir,
    post: async (body, config) => {
      posted.push({ body: body.toString(), config });
    },
    run: async (command, input) => {
      ran.push({ command, input: input.toString() });
      return 3;
    },
  });
  assert.equal(code, 3);
  assert.deepEqual(ran, [{ command: 'my-line --short', input: INPUT }]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body, INPUT);
  assert.equal(posted[0].config.token, TOKEN);
});

test('runs the original without waiting for the POST, and exits within the POST cap when the Huddle hangs', async () => {
  const dir = tempConfig({ original: { type: 'command', command: 'x' } });
  let ranWhilePending = false;
  let pending = true;
  const started = Date.now();
  const code = await main({
    stdin: stdinOf(INPUT),
    configDir: dir,
    post: () => new Promise(() => undefined), // never answers
    run: async () => {
      ranWhilePending = pending;
      return 0;
    },
    postTimeoutMs: 100,
  });
  pending = false;
  assert.equal(code, 0);
  assert.equal(ranWhilePending, true);
  assert.ok(Date.now() - started < 1000, 'bounded by the POST cap');
});

test('Huddle down (POST rejects or throws): output and exit code unchanged', async () => {
  const dir = tempConfig({ original: { type: 'command', command: 'x' } });
  for (const post of [() => Promise.reject(new Error('ECONNREFUSED')), () => { throw new Error('sync'); }]) {
    const code = await main({ stdin: stdinOf(INPUT), configDir: dir, post, run: async () => 0 });
    assert.equal(code, 0);
  }
});

test('no original configured: prints nothing, exit 0, still posts', async () => {
  for (const original of [undefined, null, { type: 'text' }, { type: 'command', command: '  ' }]) {
    const dir = tempConfig({ original });
    let ran = false;
    let posted = 0;
    const code = await main({
      stdin: stdinOf(INPUT),
      configDir: dir,
      post: async () => {
        posted += 1;
      },
      run: async () => {
        ran = true;
        return 9;
      },
    });
    assert.equal(code, 0);
    assert.equal(ran, false);
    assert.equal(posted, 1);
  }
});

test('never runs itself as the original (no recursion)', () => {
  const dir = tempConfig({ original: { type: 'command', command: 'node "C:/x/agent-huddle/huddle-statusline.mjs"' } });
  assert.equal(loadOriginalCommand(dir), null);
});

test('resolveShell: Git Bash when present (never WSL bash), else PowerShell; sh elsewhere', () => {
  const env = { PATH: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd', ProgramFiles: 'C:\\Program Files' };
  const has = (set) => (p) => set.includes(p);
  const git = resolveShell({
    platform: 'win32',
    env,
    exists: has(['C:\\Windows\\System32\\bash.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']),
  });
  assert.equal(git.file, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.deepEqual(git.args('echo hi'), ['-c', 'echo hi']);

  const pinned = resolveShell({ platform: 'win32', env: { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\bash.exe' }, exists: has(['D:\\bash.exe']) });
  assert.equal(pinned.file, 'D:\\bash.exe');

  const ps = resolveShell({ platform: 'win32', env, exists: has(['C:\\Windows\\System32\\bash.exe']) });
  assert.equal(ps.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(ps.args('echo hi'), ['-NoProfile', '-NonInteractive', '-Command', 'echo hi']);

  assert.equal(resolveShell({ platform: 'linux', env: {} }).file, '/bin/sh');
});

test('resolveShell: the shell binary is always a full path; relative PATH entries and the current folder are never searched', () => {
  const probed = [];
  const exists = (p) => {
    probed.push(p);
    return true; // anything probed "exists": only full paths may ever be returned
  };
  // Relative entries, a drive-relative one and "." come first; each would resolve against the session's cwd.
  const env = {
    PATH: '.;git;.\\Git\\cmd;\\Git\\cmd;tools\\git',
    CLAUDE_CODE_GIT_BASH_PATH: 'bash.exe',
    ProgramFiles: 'Program Files',
    SystemRoot: 'D:\\Win',
  };
  const shell = resolveShell({ platform: 'win32', env, exists });
  assert.equal(shell.file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(probed, [], 'no relative candidate is even probed');

  // A relative or missing SystemRoot falls back to C:\Windows, never to a bare name.
  for (const bad of [{}, { SystemRoot: 'Windows' }, { SystemRoot: '\\Windows' }]) {
    const ps = resolveShell({ platform: 'win32', env: { PATH: '', ...bad }, exists: () => false });
    assert.equal(ps.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  }

  // Absolute entries after relative ones still work.
  const git = resolveShell({
    platform: 'win32',
    env: { PATH: 'git;C:\\Tools\\Git\\cmd' },
    exists: (p) => p === 'C:\\Tools\\Git\\cmd\\bash.exe',
  });
  assert.equal(git.file, 'C:\\Tools\\Git\\cmd\\bash.exe');

  // POSIX: a relative $SHELL is ignored.
  assert.equal(resolveShell({ platform: 'linux', env: { SHELL: 'zsh' } }).file, '/bin/sh');
  assert.equal(resolveShell({ platform: 'linux', env: { SHELL: '/bin/zsh' } }).file, '/bin/zsh');
});

test('runOriginal: keeps the session cwd for the user command (no cwd override)', async () => {
  let seen;
  const fakeSpawn = (file, args, opts) => {
    seen = opts;
    const listeners = {};
    return {
      stdin: { on: () => undefined, end: () => setImmediate(() => listeners.close?.(0)) },
      on: (name, fn) => {
        listeners[name] = fn;
      },
    };
  };
  await runOriginal('echo', Buffer.from('x'), { shell: { file: '/bin/sh', args: (c) => ['-c', c] }, spawnFn: fakeSpawn });
  assert.equal(seen.cwd, undefined);
});

test('runOriginal: hands the input to the injected spawn and returns the exit code; a spawn failure is 1', async () => {
  const calls = [];
  const fakeSpawn = (file, args, opts) => {
    calls.push({ file, args, stdio: opts.stdio });
    const listeners = {};
    const child = {
      stdin: { on: () => undefined, end: (input) => setImmediate(() => listeners.close?.(input.length > 0 ? 0 : 5)) },
      on: (name, fn) => {
        listeners[name] = fn;
      },
    };
    return child;
  };
  const shell = { file: 'sh', args: (c) => ['-c', c] };
  assert.equal(await runOriginal('echo', Buffer.from('x'), { shell, spawnFn: fakeSpawn }), 0);
  assert.deepEqual(calls[0], { file: 'sh', args: ['-c', 'echo'], stdio: ['pipe', 'inherit', 'inherit'] });
  const throwing = () => {
    throw new Error('ENOENT');
  };
  assert.equal(await runOriginal('echo', Buffer.from('x'), { shell, spawnFn: throwing }), 1);
});

test('postToHuddle: loopback, token header, the status line path; no token means no request', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, token: req.headers['x-huddle-token'], origin: req.headers.origin, body });
      res.writeHead(200, { 'content-length': 0 });
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.equal(await postToHuddle(Buffer.from(INPUT), { port, token: TOKEN }), 200);
    assert.deepEqual(seen, [{ url: STATUSLINE_PATH, token: TOKEN, origin: undefined, body: INPUT }]);
    assert.equal(await postToHuddle(Buffer.from(INPUT), { port }), 'no-token');
    assert.equal(seen.length, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
  // Nothing listening: resolves quietly.
  assert.equal(await postToHuddle(Buffer.from(INPUT), { port, token: TOKEN }), 'error');
});

test('postToHuddle: a server that never answers is cut off at the timeout', async () => {
  const sockets = [];
  const server = http.createServer(() => undefined);
  server.on('connection', (s) => sockets.push(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const started = Date.now();
  try {
    assert.equal(await postToHuddle(Buffer.from(INPUT), { port: server.address().port, token: TOKEN }, { timeoutMs: 80 }), 'timeout');
    assert.ok(Date.now() - started < 1000);
  } finally {
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => server.close(r));
  }
});

function runScript(configDir, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('end to end, Huddle down: the original line prints exactly as before, no error text', async () => {
  // Port 1 on loopback: nothing listens there. The original echoes a fixed line through the real shell.
  const dir = tempConfig({
    original: { type: 'command', command: 'node -e "process.stdout.write(\'my line\')"' },
    config: { port: 1, token: TOKEN },
  });
  const result = await runScript(dir, INPUT);
  assert.deepEqual(result, { code: 0, stdout: 'my line', stderr: '' });
});

test('end to end, no original: no output, exit 0', async () => {
  const dir = tempConfig({ config: { port: 1, token: TOKEN } });
  assert.deepEqual(await runScript(dir, INPUT), { code: 0, stdout: '', stderr: '' });
});

test('runs as the entry point when reached through a junction (A6-01)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-sl-junction-'));
  made.push(root);
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  fs.copyFileSync(SCRIPT, path.join(real, 'huddle-statusline.mjs'));
  const link = path.join(root, 'link');
  fs.symlinkSync(real, link, 'junction');
  const dir = tempConfig({
    original: { type: 'command', command: 'node -e "process.stdout.write(\'my line\')"' },
    config: { port: 1, token: TOKEN },
  });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(link, 'huddle-statusline.mjs')], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(INPUT);
  });
  assert.deepEqual(result, { code: 0, stdout: 'my line' });
});

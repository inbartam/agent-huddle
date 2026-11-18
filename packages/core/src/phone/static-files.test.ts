import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readStaticFile, staticSegments } from './static-files.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

async function site() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-static-'));
  dirs.push(root);
  const www = path.join(root, 'www');
  await fsp.mkdir(path.join(www, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(www, 'index.html'), '<!doctype html><title>x</title>');
  await fsp.writeFile(path.join(www, 'assets', 'app.js'), 'export {};');
  await fsp.writeFile(path.join(www, 'secret.env'), 'KEY=1');
  await fsp.writeFile(path.join(root, 'outside.html'), 'outside');
  return { root, www };
}

describe('phone static files', () => {
  it('maps / to index.html and refuses anything that is not a plain path', () => {
    expect(staticSegments('/')).toEqual(['index.html']);
    expect(staticSegments('/assets/app.js')).toEqual(['assets', 'app.js']);
    for (const bad of [
      '/../outside.html',
      '/assets/../../outside.html',
      '/%2e%2e/outside.html',
      '/..%2foutside.html',
      '/assets\\..\\..\\outside.html',
      '/C:/Windows/win.ini',
      '//server/share/x.html',
      '/.hidden.html',
      '/secret.env',
      '/NUL.html',
      '/index.html.',
      '/a/b/c/d/e.html',
      'index.html',
    ]) {
      expect(staticSegments(bad), bad).toBeNull();
    }
  });

  it('serves files inside the folder with their content type, and nothing outside it', async () => {
    const { www } = await site();
    expect(await readStaticFile(www, '/')).toMatchObject({ contentType: 'text/html; charset=utf-8' });
    expect(await readStaticFile(www, '/assets/app.js')).toMatchObject({
      contentType: 'text/javascript; charset=utf-8',
    });
    expect(await readStaticFile(www, '/../outside.html')).toBeNull();
    expect(await readStaticFile(www, '/secret.env')).toBeNull();
    expect(await readStaticFile(www, '/missing.html')).toBeNull();
    expect(await readStaticFile(www, '/assets')).toBeNull();
  });

  it('never follows a link out of the folder', async () => {
    const { root, www } = await site();
    try {
      await fsp.symlink(path.join(root, 'outside.html'), path.join(www, 'link.html'), 'file');
      await fsp.symlink(root, path.join(www, 'up'), 'junction');
    } catch {
      // Creating links needs a privilege on some Windows setups; the path checks above still hold.
      return;
    }
    expect(await readStaticFile(www, '/link.html')).toBeNull();
    expect(await readStaticFile(www, '/up/outside.html')).toBeNull();
  });
});

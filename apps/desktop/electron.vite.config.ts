import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import { build as viteBuild, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { contentSecurityPolicy } from './src/main/security.js';

const PHONE_SRC = resolve(import.meta.dirname, 'src/phone');
/** Where the phone page lands; main passes it to HuddleCore as `phone.staticDir` (core-config.ts). */
const PHONE_OUT = resolve(import.meta.dirname, 'out/phone');

/**
 * Builds the phone page (M6, F26) into out/phone whenever main is built, in `electron-vite dev` as well as in
 * `build`: the core serves it from real files on disk, so a dev server URL would not do. A separate Vite build with no
 * config file of its own, plain DOM TypeScript, no framework. No module-preload polyfill and no inlined assets, so the
 * output is only files `script-src 'self'` / `style-src 'self'` allow.
 */
function huddlePhonePage(): Plugin {
  return {
    name: 'huddle-phone-page',
    apply: 'build',
    buildStart() {
      // Rebuild main (and so the page) in watch mode when a phone file changes.
      for (const f of readdirSync(PHONE_SRC)) {
        if (!f.endsWith('.test.ts')) this.addWatchFile(resolve(PHONE_SRC, f));
      }
    },
    async closeBundle() {
      await viteBuild({
        configFile: false,
        root: PHONE_SRC,
        base: './',
        logLevel: 'warn',
        publicDir: false,
        build: {
          outDir: PHONE_OUT,
          emptyOutDir: true,
          target: 'es2022',
          modulePreload: false,
          assetsInlineLimit: 0,
          cssCodeSplit: false,
          sourcemap: false,
          rollupOptions: { input: resolve(PHONE_SRC, 'index.html') },
        },
      });
    },
  };
}

/** Writes the CSP meta tag from the single source in src/main/security.ts. */
function huddleCsp(): Plugin {
  return {
    name: 'huddle-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const mode = ctx.server ? 'development' : 'production';
        return html.replace('__HUDDLE_CSP__', contentSecurityPolicy(mode, 'meta'));
      },
    },
  };
}

// Dependency handling (electron-vite 5+): packages in `dependencies` (zod) stay external in main and
// are loaded from node_modules at runtime. `@huddle/shared` is a devDependency, so it is bundled; it
// ships TypeScript sources, which Node could not load as an external.
export default defineConfig({
  main: {
    plugins: [huddlePhonePage()],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      // A sandboxed preload cannot `require` anything but a few Electron modules and cannot be ESM.
      // Bundle every dependency and emit CommonJS with a .cjs extension (the package is "type": "module").
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') },
      },
    },
    plugins: [huddleCsp(), react()],
  },
});

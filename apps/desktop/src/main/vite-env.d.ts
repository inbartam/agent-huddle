/** The one Vite build-time constant main uses: `import.meta.env.DEV` (false in a production build). */
interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

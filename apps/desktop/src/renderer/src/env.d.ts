/// <reference types="vite/client" />
import type { HuddleBridge } from '../../preload/api.js';

declare global {
  interface Window {
    /** The only door to the main process: five functions, see src/preload/api.ts. */
    readonly huddle: HuddleBridge;
  }
}

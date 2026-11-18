import { describeEventStoreContract } from './event-store.contract.js';
import { JsonlEventStore } from './jsonl-store.js';

describeEventStoreContract('JsonlEventStore', {
  open: (dir) => new JsonlEventStore({ baseDir: dir, flushDelayMs: 5 }),
  dedupesOnId: false,
});

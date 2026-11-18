import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '@huddle/shared';
import { ITEM_ID_MAX, isItemIdFormat, itemFromHash, linkedItem } from './deep-link.js';

const ch = (code: number) => String.fromCharCode(code);
const conflict = 'conflict:C:\\projects\\example:C:\\projects\\example\\src\\tokenizer.ts';
const hashOf = (id: string) => `#item=${encodeURIComponent(id)}`;

function item(id: string): AttentionItem {
  return {
    id,
    kind: 'stuck',
    severity: 'warning',
    agentKey: 's1',
    title: 't',
    detail: 'd',
    createdAt: 0,
    resolvedAt: null,
  };
}

describe('#item=<id> fragment (toast click)', () => {
  it('reads a well-formed fragment, including ids with paths, colons and spaces', () => {
    for (const id of ['approval:req-1', conflict, 'conflict:C:\\My Projects\\x:C:\\My Projects\\x\\a b.ts', 'é:ü']) {
      expect(itemFromHash(hashOf(id))).toBe(id);
    }
    expect(itemFromHash(hashOf('x'.repeat(ITEM_ID_MAX)))).toBe('x'.repeat(ITEM_ID_MAX));
  });

  it.each([
    ['empty', ''],
    ['no value', '#item='],
    ['the agent form', '#agent=s1'],
    ['a second field', '#item=a&agent=b'],
    ['a field before it', '#x=1&item=a'],
    ['bad percent-encoding', '#item=%E0%A4%A'],
    ['a newline', hashOf(`a${ch(10)}b`)],
    ['a NUL', hashOf(`a${ch(0)}`)],
    ['a bidi override', hashOf(`a${ch(0x202e)}b`)],
    ['too long', hashOf('x'.repeat(ITEM_ID_MAX + 1))],
    ['absurdly long encoded', `#item=${'%41'.repeat(ITEM_ID_MAX * 4)}`],
  ])('rejects %s', (_label, hash) => {
    expect(itemFromHash(hash)).toBeNull();
  });

  it('opens only an item the inbox has (exact match)', () => {
    const state = { inbox: [item('approval:req-1'), item(conflict)] };
    expect(linkedItem(hashOf(conflict), state)).toBe(conflict);
    expect(linkedItem(hashOf('approval:req-1'), state)).toBe('approval:req-1');
    expect(linkedItem(hashOf('approval:req'), state)).toBeNull();
    expect(linkedItem(hashOf('toString'), state)).toBeNull();
    expect(linkedItem(hashOf('approval:req-1'), null)).toBeNull();
    expect(linkedItem('#agent=s1', state)).toBeNull();
  });

  it('format check', () => {
    expect(isItemIdFormat('a')).toBe(true);
    expect(isItemIdFormat('')).toBe(false);
    expect(isItemIdFormat(7)).toBe(false);
  });
});

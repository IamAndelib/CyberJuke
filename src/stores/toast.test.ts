import { signal } from '@preact/signals';
import { describe, expect, it } from 'vitest';
import { dropToastActions, runToastAction, toast, toasts } from './toast';

describe('toast actions', () => {
  it('an Undo goes (the text stays) once it is stale', async () => {
    const ctx = signal('a');
    let ran = 0;
    const id = toast('Removed from queue', 4000, { label: 'Undo', run: () => ran++, stale: () => ctx.value !== 'a' });
    expect(toasts.value.find((t) => t.id === id)?.action).toBeDefined();
    ctx.value = 'b';
    await Promise.resolve();
    const t = toasts.value.find((x) => x.id === id);
    expect(t?.text).toBe('Removed from queue');
    expect(t?.action).toBeUndefined();
    runToastAction(id);
    expect(ran).toBe(0);
  });

  it('signing out drops the Undo of members-only items', () => {
    const a = toast('Removed from Liked', undefined, { label: 'Undo', run: () => {}, membersOnly: true });
    const b = toast('Removed from Liked', undefined, { label: 'Undo', run: () => {} });
    dropToastActions((x) => x.membersOnly === true);
    expect(toasts.value.find((t) => t.id === a)?.action).toBeUndefined();
    expect(toasts.value.find((t) => t.id === b)?.action).toBeDefined();
  });
});

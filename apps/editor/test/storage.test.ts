import {
  NAME_MAX_LENGTH,
  createEmptyLayout,
  serializeLayout,
  type HomeLayout,
} from '@spatial-home/home-model';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDraftSaver, loadDraft, saveDraft, unreadableDraft } from '../src/editor/storage.ts';

describe('createDraftSaver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('saves only the last of quick changes, once they stop', () => {
    const write = vi.fn<(layout: HomeLayout) => void>();
    const saver = createDraftSaver(write, 400);
    const first = createEmptyLayout('First');
    const last = createEmptyLayout('Last');
    saver.save(first);
    vi.advanceTimersByTime(300);
    saver.save(last);
    vi.advanceTimersByTime(300);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(last);
  });

  test('flushing saves a pending change now, and only once', () => {
    const write = vi.fn<(layout: HomeLayout) => void>();
    const saver = createDraftSaver(write, 400);
    const layout = createEmptyLayout('Home');
    saver.save(layout);
    saver.flush();
    expect(write).toHaveBeenCalledWith(layout);
    vi.advanceTimersByTime(1000);
    saver.flush();
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('the draft kept in the browser', () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  test('comes back as it was saved', () => {
    expect(loadDraft()).toEqual({ layout: null });
    const layout = createEmptyLayout('Home');
    saveDraft(layout);
    expect(loadDraft()).toEqual({ layout });
  });

  test('comes back with its problems, for them to be fixed', () => {
    const layout: HomeLayout = {
      ...createEmptyLayout(),
      rooms: [
        {
          id: 'room',
          name: 'Room',
          floorId: 'nowhere',
          outline: [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          ceilingHeight: 2.5,
        },
      ],
    };
    saveDraft(layout);
    expect(loadDraft().layout).toEqual(layout);
  });

  test("is set aside, not lost, when it can't be read as a layout", () => {
    const text = serializeLayout(createEmptyLayout('x'.repeat(NAME_MAX_LENGTH + 1)));
    stored.set('spatial-home.editor.draft', text);
    const restored = loadDraft();
    expect(restored.layout).toBeNull();
    expect(restored.problem).toMatch(/name/);
    // Saving the next draft doesn't touch it.
    saveDraft(createEmptyLayout());
    expect(unreadableDraft()).toBe(text);
  });
});

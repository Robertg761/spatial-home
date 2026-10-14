import { createEmptyLayout, type HomeLayout } from '@spatial-home/home-model';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDraftSaver } from '../src/editor/storage.ts';

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

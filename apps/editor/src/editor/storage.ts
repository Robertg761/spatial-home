import { parseLayoutJson, serializeLayout, type HomeLayout } from '@spatial-home/home-model';

const DRAFT_KEY = 'spatial-home.editor.draft';
/** Where a draft that couldn't be read is set aside, so saving the next one doesn't lose it. */
const UNREADABLE_KEY = 'spatial-home.editor.unreadable-draft';

/**
 * The layout being edited, kept in this browser between visits. A layout describes a real home, so
 * it stays on this device; nothing is uploaded. A draft with problems still comes back, for them
 * to be fixed. One that can't be read as a layout at all is set aside, with the reason.
 */
export function loadDraft(): { layout: HomeLayout | null; problem?: string } {
  try {
    const text = localStorage.getItem(DRAFT_KEY);
    if (!text) return { layout: null };
    const result = parseLayoutJson(text);
    if (result.layout) return { layout: result.layout };
    localStorage.setItem(UNREADABLE_KEY, text);
    const first = result.ok ? undefined : result.errors[0];
    return {
      layout: null,
      problem: `${first?.path.length ? `${first.path.join('.')}: ` : ''}${first?.message ?? 'not a layout'}`,
    };
  } catch {
    // Storage can be unavailable, such as in a private window.
    return { layout: null };
  }
}

/** The text of the last draft that couldn't be read, if there was one. */
export function unreadableDraft(): string | null {
  try {
    return localStorage.getItem(UNREADABLE_KEY);
  } catch {
    return null;
  }
}

export function saveDraft(layout: HomeLayout): void {
  try {
    localStorage.setItem(DRAFT_KEY, serializeLayout(layout));
  } catch {
    // Not saving a draft is not worth interrupting the user over.
  }
}

export interface DraftSaver {
  /** Saves the layout once changes have stopped for a moment, rather than on every drag step. */
  save(layout: HomeLayout): void;
  /** Saves a waiting change now, such as when the page is closing. */
  flush(): void;
}

export function createDraftSaver(write = saveDraft, delay = 400): DraftSaver {
  let pending: HomeLayout | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    if (!pending) return;
    const layout = pending;
    pending = null;
    write(layout);
  };
  return {
    save(layout) {
      pending = layout;
      clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    flush,
  };
}

/** Offers the layout as a home-layout.json download. */
export function downloadLayout(layout: HomeLayout): void {
  download(serializeLayout(layout), 'home-layout.json');
}

export function download(text: string, fileName: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

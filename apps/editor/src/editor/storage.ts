import { parseLayoutJson, serializeLayout, type HomeLayout } from '@spatial-home/home-model';

const DRAFT_KEY = 'spatial-home.editor.draft';

/**
 * The layout being edited, kept in this browser between visits. A layout describes a real home, so
 * it stays on this device; nothing is uploaded.
 */
export function loadDraft(): HomeLayout | null {
  try {
    const text = localStorage.getItem(DRAFT_KEY);
    if (!text) return null;
    return parseLayoutJson(text).layout ?? null;
  } catch {
    // Storage can be unavailable, such as in a private window.
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

/** Offers the layout as a home-layout.json download. */
export function downloadLayout(layout: HomeLayout): void {
  const blob = new Blob([serializeLayout(layout)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'home-layout.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

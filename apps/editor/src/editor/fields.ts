// What the inspector's fields accept. Each stays inside what a home-layout.json allows, so no
// edit made through them can leave a layout that won't open again.

import { NAME_MAX_LENGTH } from '@spatial-home/home-model';

/** The ranges of the inspector's number fields, in metres or degrees. */
export const NUMBER_LIMITS = {
  northBearing: { min: 0, max: 359.9 },
  ceilingHeight: { min: 0.5, max: 20 },
  width: { min: 0.1, max: 20 },
  height: { min: 0.1, max: 10 },
  sillHeight: { min: 0, max: 10 },
} as const;

/**
 * What a text field holding `value` commits when `text` has been typed into it: the text trimmed,
 * or null to keep `value` when nothing changed, a required name was left empty, or it's too long.
 */
export function textToCommit(
  text: string,
  value: string,
  { required = false, maxLength = NAME_MAX_LENGTH } = {}
): string | null {
  const trimmed = text.trim();
  if (trimmed === value || (required && !trimmed) || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * What a number field holding `value` commits when `text` has been typed into it, or null to keep
 * `value` when nothing changed or the text isn't a number in range.
 */
export function numberToCommit(
  text: string,
  value: number,
  { min, max }: { min: number; max: number }
): number | null {
  const parsed = Number(text);
  if (text.trim() === '' || !Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed === value ? null : parsed;
}

import { NAME_MAX_LENGTH } from '@spatial-home/home-model';
import { describe, expect, test } from 'vitest';
import { NUMBER_LIMITS, numberToCommit, textToCommit } from '../src/editor/fields.ts';

describe('text fields', () => {
  test('commit trimmed text that changed', () => {
    expect(textToCommit('  Lounge ', 'Living room')).toBe('Lounge');
    expect(textToCommit('Lounge', 'Lounge')).toBeNull();
    expect(textToCommit('   ', 'Lounge')).toBe('');
  });

  test('refuse empty text where a name is required, and text longer than a name can be', () => {
    expect(textToCommit('   ', 'Lounge', { required: true })).toBeNull();
    expect(textToCommit('x'.repeat(NAME_MAX_LENGTH), '')).toHaveLength(NAME_MAX_LENGTH);
    expect(textToCommit('x'.repeat(NAME_MAX_LENGTH + 1), '')).toBeNull();
  });
});

describe('number fields', () => {
  test('commit numbers in range that changed', () => {
    expect(numberToCommit('1.2', 0.8, NUMBER_LIMITS.width)).toBe(1.2);
    expect(numberToCommit('0.8', 0.8, NUMBER_LIMITS.width)).toBeNull();
  });

  test('refuse what is not a number, or out of range', () => {
    for (const text of ['', ' ', 'abc', 'NaN', 'Infinity', '-1', '0', '25']) {
      expect(numberToCommit(text, 0.8, NUMBER_LIMITS.width), text).toBeNull();
    }
    expect(numberToCommit('360', 0, NUMBER_LIMITS.northBearing)).toBeNull();
  });
});

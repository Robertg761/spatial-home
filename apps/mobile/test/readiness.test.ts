import { expect, test } from 'vitest';
import { afterAvailability, afterInstall } from '../src/scan/readiness.ts';

test('an installed ARCore still has to be asked whether it is ready', () => {
  expect(afterAvailability('supported')).toBe('request-install');
});

test('a missing or old ARCore offers the install, and an unsupported phone says so', () => {
  expect(afterAvailability('needs-install')).toEqual({
    kind: 'needs-install',
    update: false,
    waiting: false,
  });
  expect(afterAvailability('needs-update')).toEqual({
    kind: 'needs-install',
    update: true,
    waiting: false,
  });
  expect(afterAvailability('unsupported')).toEqual({ kind: 'unsupported' });
});

test('only an installed answer goes on to the camera', () => {
  expect(afterInstall('installed', false)).toBe('ask-for-camera');
  expect(afterInstall('requested', true)).toEqual({
    kind: 'needs-install',
    update: true,
    waiting: true,
  });
  expect(afterInstall('declined', false)).toEqual({
    kind: 'needs-install',
    update: false,
    waiting: false,
  });
  expect(afterInstall('unsupported', false)).toEqual({ kind: 'unsupported' });
});

import { describe, expect, test } from 'vitest';
import { normalizeBaseUrl, toWebSocketUrl } from '../src/url.ts';

describe('normalizeBaseUrl', () => {
  test.each([
    ['http://homeassistant.local:8123', 'http://homeassistant.local:8123'],
    ['  http://homeassistant.local:8123/  ', 'http://homeassistant.local:8123'],
    ['homeassistant.local:8123', 'http://homeassistant.local:8123'],
    ['192.168.1.20:8123', 'http://192.168.1.20:8123'],
    ['https://abc123.ui.nabu.casa/lovelace/0', 'https://abc123.ui.nabu.casa'],
    ['HTTPS://HA.Example.com', 'https://ha.example.com'],
    ['http://[fd00::1]:8123', 'http://[fd00::1]:8123'],
    ['ws://homeassistant.local:8123/api/websocket', 'http://homeassistant.local:8123'],
    ['wss://ha.example.com/api/websocket', 'https://ha.example.com'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  test.each([
    [''],
    ['   '],
    ['YOUR_HOME_ASSISTANT_URL'],
    ['ftp://homeassistant.local'],
    ['http://ha local:8123'],
    ['http://'],
    [null],
    [42],
  ])('rejects %j', (input) => {
    expect(normalizeBaseUrl(input)).toBeNull();
  });
});

describe('toWebSocketUrl', () => {
  test('uses ws for http and wss for https', () => {
    expect(toWebSocketUrl('http://homeassistant.local:8123')).toBe(
      'ws://homeassistant.local:8123/api/websocket'
    );
    expect(toWebSocketUrl('https://ha.example.com/')).toBe('wss://ha.example.com/api/websocket');
  });

  test('throws for an invalid address', () => {
    expect(() => toWebSocketUrl('not a url')).toThrow(/Not a Home Assistant address/);
  });
});

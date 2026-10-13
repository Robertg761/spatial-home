import { HomeAssistantError } from './errors.ts';

const URL_PLACEHOLDER_VALUES = new Set(['YOUR_HOME_ASSISTANT_URL', 'HOME_ASSISTANT_URL']);

/**
 * Turns what a user typed for their Home Assistant address into its origin
 * (`http://homeassistant.local:8123`), or null when it can't be one.
 *
 * A missing scheme means http, which is how Home Assistant is reached on a home network. Paths are
 * dropped because Home Assistant always serves its API from the root.
 */
export function normalizeBaseUrl(rawUrl: unknown): string | null {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed || URL_PLACEHOLDER_VALUES.has(trimmed)) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^(?:https?|wss?):\/\//i.test(trimmed)) {
    return null;
  }

  // A pasted WebSocket address names the same server.
  const httpUrl = trimmed.replace(/^ws(s?):\/\//i, 'http$1://');
  const withProtocol = /^https?:\/\//i.test(httpUrl) ? httpUrl : `http://${httpUrl}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // Chromium's URL parser percent-encodes spaces and other characters no host name can contain
  // ("ha local" becomes "ha%20local") instead of rejecting them. Accept only real host names
  // (letters, digits, dots, hyphens, underscores; international names arrive as punycode) and
  // bracketed IPv6 addresses.
  if (!/^(?:[a-z0-9_.-]+|\[[0-9a-f:.]+\])$/i.test(parsed.hostname)) return null;
  return parsed.origin;
}

/** The WebSocket API address for a Home Assistant origin: https becomes wss, http becomes ws. */
export function toWebSocketUrl(rawUrl: unknown): string {
  const baseUrl = normalizeBaseUrl(rawUrl);
  if (!baseUrl) {
    throw new HomeAssistantError(`Not a Home Assistant address: ${String(rawUrl)}`, 'invalid_url');
  }
  return `${baseUrl.replace(/^http/, 'ws')}/api/websocket`;
}

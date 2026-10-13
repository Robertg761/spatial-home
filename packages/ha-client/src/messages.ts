// Shapes of the Home Assistant WebSocket API messages this client sends and receives.
// https://developers.home-assistant.io/docs/api/websocket

/** A command sent to Home Assistant, without its id; the connection numbers it. */
export interface CommandPayload {
  type: string;
  [key: string]: unknown;
}

export interface HassContext {
  id: string;
  parent_id: string | null;
  user_id: string | null;
}

/** An entity's state, as `get_states` returns it and as the entity store keeps it. */
export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context: HassContext;
}

export interface HassServiceTarget {
  entity_id?: string | string[];
  device_id?: string | string[];
  area_id?: string | string[];
  floor_id?: string | string[];
  label_id?: string | string[];
}

export interface CallServiceResult {
  context: HassContext;
  /** Present only when the call asked for a response and the service returns one. */
  response?: unknown;
}

export interface HassErrorPayload {
  code: string;
  message: string;
  [key: string]: unknown;
}

export type IncomingMessage =
  | { type: 'auth_required'; ha_version: string }
  | { type: 'auth_ok'; ha_version: string }
  | { type: 'auth_invalid'; message?: string }
  | { type: 'result'; id: number; success: true; result: unknown }
  | { type: 'result'; id: number; success: false; error?: HassErrorPayload }
  | { type: 'event'; id: number; event: unknown }
  | { type: 'pong'; id: number }
  | { type: 'ping'; id?: number };

// `subscribe_entities` sends states in a compressed form: a first event that adds every entity,
// then only what changed. Timestamps are seconds since the epoch.

export interface CompressedState {
  /** state */
  s: string;
  /** attributes */
  a?: Record<string, unknown>;
  /** context, or only its id */
  c?: string | Partial<HassContext>;
  /** last_changed; Home Assistant omits one of lc and lu when both are equal */
  lc?: number;
  /** last_updated */
  lu?: number;
}

export interface CompressedStateDiff {
  '+'?: Partial<CompressedState>;
  '-'?: { a?: string[] };
}

export interface EntitiesEvent {
  /** added, or the whole set in the first event */
  a?: Record<string, CompressedState>;
  /** changed */
  c?: Record<string, CompressedStateDiff>;
  /** removed */
  r?: string[];
}

import { hsToRgb, kelvinToRgb, rgbToHs } from './color.ts';
import type { Hs, Rgb } from './color.ts';
import type { Behavior, SimulatedEntityConfig } from './fixture.ts';
import { domainOf } from './fixture.ts';

// What each kind of simulated entity is made of, how it renders to a Home Assistant state, and how
// it moves when time passes. Commands (services.ts) and time (tick) both change an entity's
// runtime values and then render it again, so the two never disagree about what the state is.

export type Attributes = Record<string, unknown>;

export interface LightRuntime {
  on: boolean;
  brightness: number;
  mode: 'onoff' | 'brightness' | 'color_temp' | 'hs';
  hs: Hs;
  kelvin: number;
}

/** One entity: its fixed attributes, the values that change, and the last state it rendered. */
export interface SimEntity {
  id: string;
  domain: string;
  name: string | null;
  deviceId: string | null;
  areaId: string | null;
  behavior: Behavior | undefined;
  /** Attributes from the fixture that never change. */
  base: Attributes;
  state: string;
  attributes: Attributes;
  /** Seconds since the epoch. */
  lastChanged: number;
  lastUpdated: number;
  contextId: string;

  // Runtime values; which ones apply depends on the domain.
  text: string;
  light: LightRuntime;
  /** A sensor's unrounded value. */
  value: number;
  /** When a flip behavior next switches (simulated ms). */
  nextFlipAt: number;
  hvacMode: string;
  lastActiveMode: string;
  target: number;
  temperature: number;
  action: string;
  position: number;
  targetPosition: number;
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const numberOr = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export function createEntity(config: SimulatedEntityConfig, defaultTime: number): SimEntity {
  const attributes = config.attributes ?? {};
  const base: Attributes = { ...attributes };
  const domain = domainOf(config.entity_id);
  const modes = Array.isArray(attributes.supported_color_modes)
    ? (attributes.supported_color_modes as string[])
    : ['onoff'];
  if (domain === 'light') base.supported_color_modes = modes;
  const kelvin = numberOr(attributes.color_temp_kelvin, 3000);
  if (modes.includes('color_temp')) {
    base.min_color_temp_kelvin ??= 2000;
    base.max_color_temp_kelvin ??= 6500;
  }
  const hs: Hs = Array.isArray(attributes.hs_color)
    ? (attributes.hs_color as Hs)
    : Array.isArray(attributes.rgb_color)
      ? rgbToHs(attributes.rgb_color as Rgb)
      : [0, 0];
  for (const key of [
    'brightness',
    'color_mode',
    'hs_color',
    'rgb_color',
    'color_temp_kelvin',
    'current_position',
    'temperature',
    'current_temperature',
    'hvac_action',
  ]) {
    delete base[key];
  }

  const modeNames = (base.hvac_modes as string[] | undefined) ?? ['off', 'heat'];
  if (domain === 'climate') {
    base.hvac_modes = modeNames;
    base.min_temp ??= 7;
    base.max_temp ??= 35;
    base.target_temp_step ??= 0.5;
    base.supported_features ??= 1;
  }
  if (domain === 'cover') base.supported_features ??= 15;

  const position = numberOr(
    attributes.current_position,
    config.state === 'closed' || config.state === 'closing' ? 0 : 100
  );

  const entity: SimEntity = {
    id: config.entity_id,
    domain,
    name: config.name ?? null,
    deviceId: config.device_id ?? null,
    areaId: config.area_id ?? null,
    behavior: config.simulate,
    base,
    state: config.state,
    attributes: {},
    lastChanged: defaultTime,
    lastUpdated: defaultTime,
    contextId: '',
    text: config.state,
    light: {
      on: config.state === 'on',
      brightness: clamp(Math.round(numberOr(attributes.brightness, 255)), 1, 255),
      mode: initialLightMode(modes, attributes.color_mode),
      hs,
      kelvin,
    },
    value: Number(config.state),
    nextFlipAt: Infinity,
    hvacMode: config.state,
    lastActiveMode: modeNames.find((mode) => mode !== 'off') ?? 'heat',
    target: numberOr(attributes.temperature, 21),
    temperature: numberOr(attributes.current_temperature, 20),
    action: 'idle',
    position,
    targetPosition: position,
  };
  // Work out what the climate system is doing at the start, without letting time pass.
  if (domain === 'climate') advanceClimate(entity, 0);
  const initial = render(entity);
  entity.state = initial.state;
  entity.attributes = initial.attributes;
  return entity;
}

function initialLightMode(modes: string[], requested: unknown): LightRuntime['mode'] {
  if (requested === 'hs' || requested === 'color_temp') {
    if (modes.includes(requested)) return requested;
  }
  if (modes.includes('color_temp')) return 'color_temp';
  if (modes.includes('hs')) return 'hs';
  return modes.some((mode) => mode !== 'onoff') ? 'brightness' : 'onoff';
}

/** What the light's colour parameters in a `light.turn_on` call ask for. */
export interface LightRequest {
  brightness?: number;
  hs?: Hs;
  rgb?: Rgb;
  kelvin?: number;
}

export function applyLightRequest(entity: SimEntity, request: LightRequest): void {
  const modes = entity.base.supported_color_modes as string[];
  const light = entity.light;
  if (request.brightness !== undefined && modes.some((mode) => mode !== 'onoff')) {
    light.brightness = clamp(Math.round(request.brightness), 1, 255);
  }
  if (modes.includes('hs')) {
    const hs = request.hs ?? (request.rgb ? rgbToHs(request.rgb) : undefined);
    if (hs) {
      light.hs = hs;
      light.mode = 'hs';
    }
  }
  if (request.kelvin !== undefined && modes.includes('color_temp')) {
    const min = numberOr(entity.base.min_color_temp_kelvin, 2000);
    const max = numberOr(entity.base.max_color_temp_kelvin, 6500);
    light.kelvin = clamp(Math.round(request.kelvin), min, max);
    light.mode = 'color_temp';
  }
  light.on = true;
}

export interface Rendered {
  state: string;
  attributes: Attributes;
}

/** The state and attributes Home Assistant would report for the entity right now. */
export function render(entity: SimEntity): Rendered {
  const attributes: Attributes = { ...entity.base };
  if (entity.name) attributes.friendly_name = entity.name;

  switch (entity.domain) {
    case 'light': {
      const { on, brightness, mode, hs, kelvin } = entity.light;
      const modes = entity.base.supported_color_modes as string[];
      const rgb: Rgb | null = !on
        ? null
        : mode === 'hs'
          ? hsToRgb(hs)
          : mode === 'color_temp'
            ? kelvinToRgb(kelvin)
            : null;
      attributes.brightness = on && modes.some((m) => m !== 'onoff') ? brightness : null;
      attributes.color_mode = on ? mode : null;
      attributes.color_temp_kelvin = on && mode === 'color_temp' ? kelvin : null;
      attributes.hs_color = !rgb ? null : mode === 'hs' ? hs : rgbToHs(rgb);
      attributes.rgb_color = rgb;
      return { state: on ? 'on' : 'off', attributes };
    }
    case 'sensor':
      if (entity.behavior?.kind === 'random-walk') {
        return { state: entity.value.toFixed(entity.behavior.decimals ?? 1), attributes };
      }
      return { state: entity.text, attributes };
    case 'climate':
      attributes.temperature = entity.hvacMode === 'off' ? null : entity.target;
      attributes.current_temperature = Math.round(entity.temperature * 10) / 10;
      attributes.hvac_action = entity.hvacMode === 'off' ? 'off' : entity.action;
      return { state: entity.hvacMode, attributes };
    case 'cover': {
      const position = Math.round(entity.position);
      attributes.current_position = position;
      const state =
        entity.position < entity.targetPosition
          ? 'opening'
          : entity.position > entity.targetPosition
            ? 'closing'
            : position > 0
              ? 'open'
              : 'closed';
      return { state, attributes };
    }
    default:
      return { state: entity.text, attributes };
  }
}

const gaussian = (random: () => number) => (random() + random() + random() - 1.5) * 2;
const exponential = (random: () => number, mean: number) => -Math.log(1 - random()) * mean;

/** Schedules a flip behavior's next switch, from the state it is in now. */
export function scheduleFlip(entity: SimEntity, now: number, random: () => number): void {
  const behavior = entity.behavior;
  if (behavior?.kind !== 'flip') return;
  const mean = entity.text === 'on' ? behavior.meanOnSeconds : behavior.meanOffSeconds;
  entity.nextFlipAt = now + exponential(random, mean) * 1000;
}

/** Moves the entity forward by `seconds` of simulated time. Returns whether anything changed. */
export function advance(entity: SimEntity, seconds: number, now: number, random: () => number) {
  const behavior = entity.behavior;
  switch (entity.domain) {
    case 'sensor':
      if (behavior?.kind !== 'random-walk' || !Number.isFinite(entity.value)) return;
      {
        const minutes = seconds / 60;
        const base = behavior.base ?? entity.value;
        const pull = (base - entity.value) * Math.min(1, minutes / 10);
        entity.value = clamp(
          entity.value + pull + gaussian(random) * behavior.step * Math.sqrt(minutes),
          behavior.min,
          behavior.max
        );
      }
      return;
    case 'binary_sensor':
      if (behavior?.kind === 'flip' && now >= entity.nextFlipAt) {
        entity.text = entity.text === 'on' ? 'off' : 'on';
        scheduleFlip(entity, now, random);
      }
      return;
    case 'climate':
      advanceClimate(entity, seconds);
      return;
    case 'cover': {
      const travel = (behavior?.kind === 'cover' ? behavior.secondsToTravel : undefined) ?? 20;
      const step = (100 * seconds) / travel;
      const gap = entity.targetPosition - entity.position;
      entity.position =
        Math.abs(gap) <= step ? entity.targetPosition : entity.position + Math.sign(gap) * step;
      return;
    }
  }
}

function advanceClimate(entity: SimEntity, seconds: number): void {
  const behavior = entity.behavior?.kind === 'thermostat' ? entity.behavior : undefined;
  const ambient = behavior?.ambient ?? 19;
  const rate = ((behavior?.ratePerMinute ?? 0.5) * seconds) / 60;
  const { hvacMode, target } = entity;
  const wasHeating = entity.action === 'heating';
  const wasCooling = entity.action === 'cooling';
  const canHeat = hvacMode === 'heat' || hvacMode === 'auto' || hvacMode === 'heat_cool';
  const canCool = hvacMode === 'cool' || hvacMode === 'auto' || hvacMode === 'heat_cool';

  // A little hysteresis keeps the system from switching every tick around the target.
  if (
    canHeat &&
    (entity.temperature < target - 0.3 || (wasHeating && entity.temperature < target))
  ) {
    entity.action = 'heating';
    entity.temperature += rate;
  } else if (
    canCool &&
    (entity.temperature > target + 0.3 || (wasCooling && entity.temperature > target))
  ) {
    entity.action = 'cooling';
    entity.temperature -= rate;
  } else {
    entity.action = 'idle';
    entity.temperature += (ambient - entity.temperature) * Math.min(1, seconds / 1800);
  }
}

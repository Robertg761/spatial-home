import type { Hs, Rgb } from './color.ts';
import { applyLightRequest, clamp } from './entities.ts';
import type { LightRequest, SimEntity } from './entities.ts';

/** A failed command, carrying the error code Home Assistant would send. */
export class SimulatedServiceError extends Error {
  readonly code: string;
  constructor(message: string, code = 'service_validation_error') {
    super(message);
    this.name = 'SimulatedServiceError';
    this.code = code;
  }
}

type ServiceData = Record<string, unknown>;
type Handler = (entity: SimEntity, data: ServiceData) => void;

function numberField(data: ServiceData, key: string): number | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SimulatedServiceError(`${key} must be a number`);
  }
  return value;
}

function tuple(data: ServiceData, key: string, length: number): number[] | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((item) => typeof item !== 'number')
  ) {
    throw new SimulatedServiceError(`${key} must be a list of ${length} numbers`);
  }
  return value as number[];
}

function lightRequest(entity: SimEntity, data: ServiceData): LightRequest {
  const request: LightRequest = {};
  const brightness = numberField(data, 'brightness');
  const percent = numberField(data, 'brightness_pct');
  const step = numberField(data, 'brightness_step_pct');
  if (brightness !== undefined) request.brightness = brightness;
  else if (percent !== undefined) request.brightness = (percent / 100) * 255;
  else if (step !== undefined) {
    request.brightness = (entity.light.on ? entity.light.brightness : 0) + (step / 100) * 255;
  }
  const hs = tuple(data, 'hs_color', 2);
  if (hs) request.hs = hs as Hs;
  const rgb = tuple(data, 'rgb_color', 3);
  if (rgb) request.rgb = rgb as Rgb;
  const kelvin = numberField(data, 'color_temp_kelvin') ?? numberField(data, 'kelvin');
  if (kelvin !== undefined) request.kelvin = kelvin;
  return request;
}

function turnOn(entity: SimEntity, data: ServiceData): void {
  if (entity.domain === 'light') {
    const request = lightRequest(entity, data);
    // Brightness 0 is how callers ask for off.
    if (request.brightness !== undefined && Math.round(request.brightness) <= 0) {
      entity.light.on = false;
      return;
    }
    applyLightRequest(entity, request);
  } else if (entity.domain === 'switch') {
    entity.text = 'on';
  } else if (entity.domain === 'climate') {
    entity.hvacMode = entity.lastActiveMode;
  } else if (entity.domain === 'cover') {
    entity.targetPosition = 100;
  }
}

function turnOff(entity: SimEntity): void {
  if (entity.domain === 'light') entity.light.on = false;
  else if (entity.domain === 'switch') entity.text = 'off';
  else if (entity.domain === 'climate') setHvacMode(entity, 'off');
  else if (entity.domain === 'cover') entity.targetPosition = 0;
}

function isOn(entity: SimEntity): boolean {
  if (entity.domain === 'light') return entity.light.on;
  if (entity.domain === 'climate') return entity.hvacMode !== 'off';
  if (entity.domain === 'cover') return entity.targetPosition > 0;
  return entity.text === 'on';
}

function setHvacMode(entity: SimEntity, mode: string): void {
  const modes = entity.base.hvac_modes as string[];
  if (!modes.includes(mode)) {
    throw new SimulatedServiceError(
      `${entity.id} does not support hvac_mode ${mode}; it supports ${modes.join(', ')}`
    );
  }
  entity.hvacMode = mode;
  if (mode !== 'off') entity.lastActiveMode = mode;
}

function setTemperature(entity: SimEntity, data: ServiceData): void {
  const temperature = numberField(data, 'temperature');
  if (temperature !== undefined) {
    const min = entity.base.min_temp as number;
    const max = entity.base.max_temp as number;
    if (temperature < min || temperature > max) {
      throw new SimulatedServiceError(`temperature must be between ${min} and ${max}`);
    }
    entity.target = temperature;
  }
  if (typeof data.hvac_mode === 'string') setHvacMode(entity, data.hvac_mode);
}

function setCoverPosition(entity: SimEntity, data: ServiceData): void {
  const position = numberField(data, 'position');
  if (position === undefined || position < 0 || position > 100) {
    throw new SimulatedServiceError('position must be a number from 0 to 100');
  }
  entity.targetPosition = position;
}

const on: Handler = turnOn;
const off: Handler = (entity) => turnOff(entity);
const toggle: Handler = (entity, data) => (isOn(entity) ? turnOff(entity) : turnOn(entity, data));

const SERVICES: Record<string, Record<string, Handler>> = {
  light: { turn_on: on, turn_off: off, toggle },
  switch: { turn_on: on, turn_off: off, toggle },
  climate: {
    turn_on: on,
    turn_off: off,
    set_temperature: setTemperature,
    set_hvac_mode: (entity, data) => {
      if (typeof data.hvac_mode !== 'string') {
        throw new SimulatedServiceError('hvac_mode is required');
      }
      setHvacMode(entity, data.hvac_mode);
    },
  },
  cover: {
    open_cover: (entity) => (entity.targetPosition = 100),
    close_cover: (entity) => (entity.targetPosition = 0),
    stop_cover: (entity) => (entity.targetPosition = clamp(entity.position, 0, 100)),
    set_cover_position: setCoverPosition,
    toggle: (entity) => (entity.targetPosition = entity.targetPosition > 0 ? 0 : 100),
  },
  // Home Assistant's own domain turns anything on or off.
  homeassistant: { turn_on: on, turn_off: off, toggle },
};

export function findService(domain: string, service: string): Handler | undefined {
  return SERVICES[domain]?.[service];
}

/** The domains a service call may target entities from. */
export function targetDomains(domain: string): string[] | null {
  return domain === 'homeassistant' ? null : [domain];
}

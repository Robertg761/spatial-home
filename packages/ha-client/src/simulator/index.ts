// A fake Home Assistant for development and tests. Import it from
// `@spatial-home/ha-client/simulator`; the package's main entry point does not include it, so it
// stays out of production bundles.

import demoHome from '../../fixtures/demo-home.json' with { type: 'json' };
import { SimulatedHomeAssistant } from './server.ts';
import type { SimulatorOptions } from './server.ts';

export { SIMULATED_TOKEN, SIMULATED_URL, SimulatedHomeAssistant } from './server.ts';
export type { SimulatorOptions } from './server.ts';
export { SimulatedServiceError } from './services.ts';
export { parseFixture } from './fixture.ts';
export type {
  Behavior,
  SimulatedDeviceConfig,
  SimulatedEntityConfig,
  SimulatedHomeFixture,
} from './fixture.ts';

/** The bundled demo home: five rooms whose devices match `home-model`'s sample flat. */
export const DEMO_HOME_FIXTURE: unknown = demoHome;

export function createDemoSimulator(options?: SimulatorOptions): SimulatedHomeAssistant {
  return new SimulatedHomeAssistant(DEMO_HOME_FIXTURE, options);
}

// models/drivers/index.js — driver lookup by provider name.
import claude from './claude.js';
import chatgpt from './chatgpt.js';
import gemini from './gemini.js';
import { createDriver } from './common.js';
import { getProvider } from '../registry.js';

const DRIVERS = { claude, chatgpt, gemini };

/**
 * Driver for a provider. Registry-only providers (added via override file)
 * get the generic driver — every flow is selector-driven, so a complete
 * descriptor is enough.
 */
export function getDriver(name) {
  if (DRIVERS[name]) return DRIVERS[name];
  if (getProvider(name)) return createDriver(name);
  return null;
}

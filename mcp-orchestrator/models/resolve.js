// models/resolve.js — model-selection resolution policy (PR-14).
//
// THE $400 LESSON: never silently inherit whatever model a tab last had. Every
// product send path resolves an EXPLICIT model name before ensureChat, in a
// fixed precedence:
//     per-call explicit  →  per-task explicit  →  configured provider default
// A convenience `model_policy` swaps the final tier between the configured
// `default` and `cheapest` (cost control). The caller collapses per-call vs
// per-task into a single `explicit` before calling resolveModelName; the tool
// layers below validate the raw args.
import { modelConfigFor, providerNames } from './registry.js';

export const MODEL_POLICIES = Object.freeze(['default', 'cheapest']);

/**
 * Resolve the model NAME to select for `provider`.
 * @param {{explicit?: string|null, policy?: 'default'|'cheapest'|null}} opts
 * @returns {string|null} the model name, or null when the provider carries no
 *   model config AND nothing explicit was given (ensureChat then selects
 *   nothing — legacy behavior for descriptor-only providers).
 */
export function resolveModelName(provider, { explicit = null, policy = null } = {}) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const cfg = modelConfigFor(provider);
  if (!cfg) return null;
  if (policy === 'cheapest') return cfg.cheapest;
  return cfg.default; // policy 'default' or unset
}

/** The configured default for a provider (the model_unavailable fallback). */
export function providerDefaultModel(provider) {
  return modelConfigFor(provider)?.default ?? null;
}

// --- argument validation (shared by every tool that accepts model args) -----

export function validateModelPolicy(policy) {
  if (policy == null) return null;
  if (!MODEL_POLICIES.includes(policy)) {
    throw new Error(`'model_policy' must be one of ${MODEL_POLICIES.join('|')} (got ${JSON.stringify(policy)})`);
  }
  return policy;
}

/** Validate a {provider: modelName} map: known providers, non-empty names. */
export function validateModelsArg(models) {
  if (models == null) return null;
  if (typeof models !== 'object' || Array.isArray(models)) {
    throw new Error("'models' must be an object mapping provider → model name");
  }
  const known = new Set(providerNames());
  const out = {};
  for (const [provider, name] of Object.entries(models)) {
    if (!known.has(provider)) {
      throw new Error(`'models' names unknown provider "${provider}" (known: ${[...known].join(', ')})`);
    }
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error(`'models.${provider}' must be a non-empty model name`);
    }
    out[provider] = name.trim();
  }
  return out;
}

/** Parse+validate the {model_policy, models} pair from a tool-call args object. */
export function parseModelSelection(args = {}) {
  return {
    policy: validateModelPolicy(args?.model_policy),
    models: validateModelsArg(args?.models),
  };
}

/**
 * Resolve every provider in `providers` to a {name, source} pair.
 * `explicitByProvider` (a validated models map) is the per-call/per-task tier.
 */
export function resolveModelsForProviders(providers, { models = null, policy = null } = {}) {
  const out = {};
  for (const provider of providers) {
    const explicit = models?.[provider] ?? null;
    out[provider] = {
      name: resolveModelName(provider, { explicit, policy }),
      source: explicit ? 'explicit' : (policy === 'cheapest' ? 'cheapest' : 'default'),
    };
  }
  return out;
}

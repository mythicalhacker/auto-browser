// utils/rate-limiter.js — Per-platform rate limit tracking.
// Limits come from each registry descriptor's quotas.sends (Infinity
// maxPerWindow = never warn/throttle, but keep a REAL tracking window so
// health_check can report actual send counts).
import { sendLimitsView } from '../models/registry.js';

const LIMITS = sendLimitsView();

const usage = new Map();

export function recordUsage(model) {
  if (!usage.has(model)) usage.set(model, []);
  usage.get(model).push(Date.now());
}

export function getUsageStats(model) {
  const limit = LIMITS[model];
  if (!limit) return { model, error: 'Unknown model' };

  const now = Date.now();
  const history = (usage.get(model) || []).filter(t => now - t < limit.windowMs);
  usage.set(model, history);

  const remaining = Math.max(0, limit.maxPerWindow - history.length);
  const percentUsed = limit.maxPerWindow === Infinity ? 0 : (history.length / limit.maxPerWindow) * 100;

  return {
    model, used: history.length, limit: limit.maxPerWindow,
    remaining, percentUsed: Math.round(percentUsed), window: limit.name,
    warning: percentUsed > 80 ? `WARNING: ${model} approaching rate limit (${Math.round(percentUsed)}% used)` : null
  };
}

export function getAllUsageStats() { return Object.keys(LIMITS).map(getUsageStats); }

export function shouldThrottle(model) {
  return getUsageStats(model).percentUsed > 90;
}

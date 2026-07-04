// research/quota-ledger.js — persistent per-provider deep-research quota
// accounting at ~/.auto-browser/quotas.json (QUOTA_FILE env override).
//
// Two layers: (1) static daily caps from registry quotas.deepResearchPerDay
// (day-keyed counters, local-date rollover); (2) dynamic cooldowns set when a
// provider surfaces a limit/pause banner (research/banners.js parses reset
// times). A provider on cooldown or at cap is not schedulable until
// nextEligibleAt — tasks go awaiting_quota, never failed.
//
// All time-dependent functions take `now` (ms) so tests can inject clocks.
// Cross-process lost-updates on counters are accepted (same stance as
// rate-limiter); the file is written atomically per update.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { getProvider } from '../models/registry.js';

const FILE = process.env.QUOTA_FILE || join(homedir(), '.auto-browser', 'quotas.json');
let tmpSeq = 0;

function load() {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    // corrupt quota file: start over — worst case we under-spend today
  }
  return { providers: {} };
}

function save(data) {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.${++tmpSeq}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, FILE);
}

/** Local calendar day for daily-cap rollover. */
export function dayOf(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function entryFor(data, provider, now) {
  const day = dayOf(now);
  const e = data.providers[provider] ?? { day, used: 0, cooldownUntil: null, cooldownReason: null };
  if (e.day !== day) {
    e.day = day;
    e.used = 0; // daily counter rolls over; cooldowns persist independently
  }
  data.providers[provider] = e;
  return e;
}

/** Daily DR cap from the registry (null = uncapped, banner-detection only). */
export function dailyCap(provider) {
  const cap = getProvider(provider)?.quotas?.deepResearchPerDay;
  return Number.isFinite(cap) ? cap : null;
}

/**
 * May a DR run be started on this provider right now?
 * @returns {{ok: boolean, reason: string|null, nextEligibleAt: number|null}}
 */
export function canSpendDR(provider, now = Date.now()) {
  const data = load();
  const e = entryFor(data, provider, now);
  if (e.cooldownUntil && now < e.cooldownUntil) {
    return { ok: false, reason: `cooldown: ${e.cooldownReason ?? 'provider limit'}`, nextEligibleAt: e.cooldownUntil };
  }
  const cap = dailyCap(provider);
  if (cap !== null && e.used >= cap) {
    // eligible again at local midnight
    const d = new Date(now);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    return { ok: false, reason: `daily cap reached (${e.used}/${cap})`, nextEligibleAt: midnight };
  }
  return { ok: true, reason: null, nextEligibleAt: null };
}

/** Record one started DR run (counted at start — a paid run is a paid run). */
export function recordDRSpend(provider, now = Date.now()) {
  const data = load();
  const e = entryFor(data, provider, now);
  e.used += 1;
  save(data);
  return e.used;
}

/** Refund a count when a send was PROVABLY not delivered (never below 0). */
export function refundDRSpend(provider, now = Date.now()) {
  const data = load();
  const e = entryFor(data, provider, now);
  e.used = Math.max(0, e.used - 1);
  save(data);
  return e.used;
}

/** Put a provider on cooldown (limit banner seen). null until = clear. */
export function setCooldown(provider, untilTs, reason = null, now = Date.now()) {
  const data = load();
  const e = entryFor(data, provider, now);
  e.cooldownUntil = untilTs;
  e.cooldownReason = untilTs ? reason : null;
  save(data);
}

/** Snapshot for quota_status/reporting. */
export function quotaSnapshot(providers, now = Date.now()) {
  const data = load();
  const out = {};
  for (const p of providers) {
    const e = entryFor(data, p, now);
    const cap = dailyCap(p);
    const gate = canSpendDR(p, now);
    out[p] = {
      day: e.day,
      used: e.used,
      cap,
      cooldownUntil: e.cooldownUntil,
      cooldownReason: e.cooldownReason,
      eligible: gate.ok,
      reason: gate.reason,
      nextEligibleAt: gate.nextEligibleAt,
    };
  }
  return out;
}

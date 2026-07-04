// utils/latency-stats.js — persistent per-model response-latency stats.
// Extended-thinking timeout ceilings should come from observed reality:
// every round records real latencies here, and health_check surfaces
// p50/p95/max + timeout counts so baselines emerge from actual usage.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { CONFIG } from '../config.js';

const FILE = join(dirname(CONFIG.stateFile), 'timing-stats.json');
const MAX_SAMPLES = 500; // ring buffer per model

function load() {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    // stats are disposable — a corrupt file just starts over
  }
  return {};
}

let tmpSeq = 0;

function save(stats) {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    // Unique tmp per write: two server processes sharing the default state
    // dir must not clobber each other's tmp mid-rename. Cross-process
    // lost-updates on the stats VALUES are accepted — advisory numbers only.
    const tmp = `${FILE}.${process.pid}.${++tmpSeq}.tmp`;
    writeFileSync(tmp, JSON.stringify(stats));
    renameSync(tmp, FILE);
  } catch {
    // best effort — observability must never break a round
  }
}

/**
 * Record one round's barrier results: a latency sample per successful model,
 * a timeout count per response-timeout failure. Never throws.
 */
export function recordRound({ outputs, errors, timing } = {}) {
  try {
    const stats = load();
    const bucket = (m) => stats[m] || (stats[m] = { samples: [], timeouts: 0 });
    for (const model of Object.keys(outputs || {})) {
      const ms = timing?.[model];
      if (typeof ms === 'number') {
        const s = bucket(model);
        s.samples.push(ms);
        if (s.samples.length > MAX_SAMPLES) s.samples.splice(0, s.samples.length - MAX_SAMPLES);
      }
    }
    for (const [model, e] of Object.entries(errors || {})) {
      if ((e?.message || '').includes('Timeout waiting for response')) {
        bucket(model).timeouts += 1;
      }
    }
    save(stats);
  } catch {
    // never let stats interfere with the consensus machinery
  }
}

/** { model: { count, p50, p95, max, timeouts } } from the persisted samples. */
export function latencySummary() {
  const stats = load();
  const out = {};
  for (const [model, s] of Object.entries(stats)) {
    const sorted = [...(s.samples || [])].sort((a, b) => a - b);
    const pct = (p) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
    out[model] = {
      count: sorted.length,
      p50: pct(50),
      p95: pct(95),
      max: sorted.length ? sorted[sorted.length - 1] : null,
      timeouts: s.timeouts || 0,
    };
  }
  return out;
}

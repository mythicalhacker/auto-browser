// research/banners.js — provider interrupt detection for deep-research runs.
//
// A DR run has THREE terminal states, not two: a report, a HARD quota/limit
// block (provider refuses to continue — cooldown + awaiting_quota), or a
// PAUSE/flag (safety layer stopped the chat — observed live 2026-07-04:
// "Chat paused … Fable's safeguards flagged this message"). Both preserve the
// chat URL so a paid run is never lost.
//
// Conservative by design (learned live 2026-07-04): a SOFT usage warning
// like "You've used 91% of your Fable 5 limit · Resets Thursday" is NOT a
// block — the run proceeds — and page scripts / a report that merely
// discusses "rate limiting" must never be misread as an interrupt. So:
//   - only HARD block/pause phrases fire (soft "used N%"/"approaching" don't);
//   - matching runs on LIVE innerText (excludes <script>/<style>/hidden),
//     never a detached clone (whose innerText leaks raw script text);
//   - a phrase that also appears inside the report/prompt region is treated
//     as content, not chrome.
import { findAll } from '../utils/selectors.js';
import { getProvider } from '../models/registry.js';

// HARD quota/limit block — refuses further generation. Deliberately excludes
// soft warnings ("used 91%", "approaching your limit", bare "usage").
const HARD_QUOTA_RE = /\b(reached your (?:\w+\s+){0,3}limit|you'?re out of (?:messages|credits)|out of credits|rate.?limited|too many requests|no (?:messages?|credits?) (?:remaining|left)|message limit reached|usage limit reached|limit reached\b|upgrade to (?:keep|continue))\b/i;

const PAUSE_TEXT_RE = /\b(chat paused|safeguards? flagged|flagged this message|response (?:was|has been) blocked|can(?:'|no)?t continue this chat|cannot continue this chat)\b/i;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function nextTime(base, hour, minute) {
  const t = new Date(base);
  t.setHours(hour, minute, 0, 0);
  if (t.getTime() <= base.getTime()) t.setDate(t.getDate() + 1);
  return t;
}

/**
 * Best-effort reset timestamp from banner text. Handles:
 * "resets Saturday at 8:00 PM" · "resets tomorrow at 9 AM" ·
 * "resets at 3 AM" · "try again in 2 hours" / "in 45 minutes".
 * @returns {number|null} ms epoch, or null when unparseable
 */
export function parseResetTime(text, now = Date.now()) {
  const s = String(text ?? '').toLowerCase();
  const base = new Date(now);

  const rel = s.match(/in\s+(\d+)\s*(hour|hr|minute|min)s?(?:\s+(?:and\s+)?(\d+)\s*(minute|min)s?)?/);
  if (rel) {
    let ms = 0;
    ms += Number(rel[1]) * (rel[2].startsWith('h') ? 3600000 : 60000);
    if (rel[3]) ms += Number(rel[3]) * 60000;
    return now + ms;
  }

  const clock = s.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  const hour24 = clock
    ? ((Number(clock[1]) % 12) + (clock[3] === 'pm' ? 12 : 0))
    : null;
  const minute = clock && clock[2] ? Number(clock[2]) : 0;

  const weekday = WEEKDAYS.find((w) => s.includes(w));
  if (weekday && hour24 !== null) {
    const target = new Date(base);
    const delta = (WEEKDAYS.indexOf(weekday) - base.getDay() + 7) % 7;
    target.setDate(base.getDate() + delta);
    target.setHours(hour24, minute, 0, 0);
    if (target.getTime() <= now) target.setDate(target.getDate() + 7);
    return target.getTime();
  }
  if (s.includes('tomorrow') && hour24 !== null) {
    const t = new Date(base);
    t.setDate(base.getDate() + 1);
    t.setHours(hour24, minute, 0, 0);
    return t.getTime();
  }
  if (hour24 !== null) return nextTime(base, hour24, minute).getTime();
  return null;
}

async function visibleTexts(page, selectors) {
  const texts = [];
  const els = await findAll(page, selectors ?? []);
  for (const el of els) {
    try {
      const t = (await el.innerText()).trim();
      if (t) texts.push(t);
    } catch {
      // element went away — not a banner
    }
  }
  return texts;
}

function classify(text) {
  if (PAUSE_TEXT_RE.test(text)) return 'paused';
  if (HARD_QUOTA_RE.test(text)) return 'quota';
  return null;
}

/**
 * Inspect a live page for a provider interrupt.
 * @returns {Promise<{type: 'quota'|'paused'|null, text: string|null, resetAt: number|null}>}
 */
export async function detectInterrupt(page, provider, now = Date.now()) {
  const d = getProvider(provider);

  // 1. Registry quota-banner elements (specific), HARD-phrase filtered.
  for (const text of await visibleTexts(page, d?.selectors?.quotaBanner)) {
    const type = classify(text);
    if (type === 'quota') return { type, text: text.slice(0, 300), resetAt: parseResetTime(text, now) };
    if (type === 'paused') return { type, text: text.slice(0, 300), resetAt: null };
  }

  // 2. Page-CHROME scan for a pause/limit card that is not a banner element
  // (the pause card replaces the response area). Read LIVE innerText —
  // excludes <script>/<style>/hidden — and subtract the conversation region,
  // so report/prompt prose that merely discusses limits is never mis-flagged.
  const stripSelectors = [
    ...(d?.selectors?.output ?? []),
    ...(d?.selectors?.userMessage ?? []),
    ...(d?.selectors?.input ?? []),
    // A deep-research report can render in a dedicated pane the runner polls
    // as a reportContainer — subtract it too, or report prose that discusses
    // "rate limited"/"blocked" would be misread as a quota/pause interrupt and
    // abandon the completed paid run.
    ...(d?.generationGates ?? []).flatMap((g) => g.reportContainer ?? []),
  ];
  let scan = null;
  try {
    if (typeof page.evaluate === 'function') {
      scan = await page.evaluate((sels) => {
        const bodyText = document.body?.innerText ?? '';
        let content = '';
        for (const sel of sels) {
          let els = [];
          try {
            els = document.querySelectorAll(sel);
          } catch {
            els = [];
          }
          for (const el of els) content += `\n${el.innerText ?? ''}`;
        }
        return { bodyText, content };
      }, stripSelectors);
    }
  } catch {
    // page busy/navigating — no evidence
  }
  if (scan && scan.bodyText) {
    // Examine each line of chrome (body minus the conversation content).
    for (const line of scan.bodyText.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (scan.content.includes(t)) continue; // it's report/prompt content
      const type = classify(t);
      if (type === 'paused') return { type, text: t.slice(0, 300), resetAt: null };
      if (type === 'quota') return { type, text: t.slice(0, 300), resetAt: parseResetTime(t, now) };
    }
  }
  return { type: null, text: null, resetAt: null };
}

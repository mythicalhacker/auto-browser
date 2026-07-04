// research/banners.js — provider interrupt detection for deep-research runs.
//
// A DR run has THREE terminal states, not two: a report, a QUOTA/limit
// banner (provider throttled — cooldown + awaiting_quota), or a PAUSE/flag
// banner (safety layer stopped the chat — observed live 2026-07-04: "Chat
// paused … Fable's safeguards flagged this message"). Both banner states
// preserve the chat URL so a paid run is never lost.
//
// Reset-time parsing is best-effort from banner text (live specimen:
// "Now using credits • Your plan limit resets Saturday at 8:00 PM.").
import { findAll } from '../utils/selectors.js';
import { getProvider } from '../models/registry.js';

const QUOTA_TEXT_RE = /\b(limit|quota|usage|credits?|rate.?limited?|upgrade to continue|too many requests)\b/i;
const PAUSE_TEXT_RE = /\b(chat paused|safeguards? flagged|flagged this message|response was blocked|cannot continue this chat)\b/i;

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

/**
 * Inspect a live page for a provider interrupt.
 * @returns {Promise<{type: 'quota'|'paused'|null, text: string|null, resetAt: number|null}>}
 */
export async function detectInterrupt(page, provider, now = Date.now()) {
  const d = getProvider(provider);

  // 1. Registry quota-banner selectors, text-filtered (some slots are
  // generic live regions that must actually SAY something quota-like).
  for (const text of await visibleTexts(page, d?.selectors?.quotaBanner)) {
    if (QUOTA_TEXT_RE.test(text)) {
      return { type: 'quota', text: text.slice(0, 300), resetAt: parseResetTime(text, now) };
    }
    if (PAUSE_TEXT_RE.test(text)) {
      return { type: 'paused', text: text.slice(0, 300), resetAt: null };
    }
  }

  // 2. Page-chrome scan for pause/flag wording (the pause card is not a
  // banner element; it replaces the response area). Scan the page MINUS the
  // conversation content — otherwise a report or prompt that merely discusses
  // "rate limited" / "flagged content" is misread as a real interrupt and a
  // paid run is discarded. Strip the output + user-message + composer regions
  // before reading text; banners/pause cards live outside those.
  const stripSelectors = [
    ...(d?.selectors?.output ?? []),
    ...(d?.selectors?.userMessage ?? []),
    ...(d?.selectors?.input ?? []),
  ];
  let body = null;
  try {
    if (typeof page.evaluate === 'function') {
      body = await page.evaluate((sels) => {
        const clone = document.body?.cloneNode(true);
        if (!clone) return '';
        for (const sel of sels) {
          try {
            clone.querySelectorAll(sel).forEach((el) => el.remove());
          } catch {
            // invalid selector — skip
          }
        }
        return clone.innerText ?? '';
      }, stripSelectors);
    }
  } catch {
    // page busy/navigating — no evidence
  }
  if (body) {
    const pause = body.match(PAUSE_TEXT_RE);
    if (pause) {
      const at = body.toLowerCase().indexOf(pause[0].toLowerCase());
      return { type: 'paused', text: body.slice(Math.max(0, at - 40), at + 260).trim(), resetAt: null };
    }
    const quota = body.match(/[^\n]*\b(?:plan limit|usage limit|out of credits|rate limited)\b[^\n]*/i);
    if (quota) {
      return { type: 'quota', text: quota[0].slice(0, 300).trim(), resetAt: parseResetTime(quota[0], now) };
    }
  }
  return { type: null, text: null, resetAt: null };
}

// models/drivers/common.js — shared ensureChat machinery for provider drivers.
//
// Contract: ensureChat(page, {project?, model?, modes?, research?}) navigates
// the given tab to a FRESH chat with the requested setup and returns a typed
// result — it never assumes a click worked: every step verifies UI state
// afterwards and records evidence. Feature failures set ok:false (or a typed
// warning for project_not_found) instead of throwing; only infrastructure
// errors (page gone) throw.
import { findFirst } from '../../utils/selectors.js';
import { getProvider } from '../registry.js';

const SETTLE_MS = 3000;
const MENU_SETTLE_MS = 700;

export function makeResult(provider, opts = {}) {
  return {
    ok: true,
    provider,
    requested: {
      project: opts.project ?? null,
      model: opts.model ?? null,
      modes: opts.modes ?? {},
      research: !!opts.research,
    },
    warnings: [], // [{code, detail}] — e.g. {code: 'project_not_found'}
    verified: {}, // feature -> {ok, evidence}
    steps: [],    // [{action, ok, evidence}] in execution order
    url: null,
  };
}

export function record(result, action, ok, evidence) {
  result.steps.push({ action, ok: !!ok, evidence: String(evidence ?? '') });
  if (!ok) result.ok = false;
  return !!ok;
}

export async function settle(page, ms = SETTLE_MS) {
  await page.waitForTimeout(ms);
}

/** Click the first matching selector. Returns {ok, selector}. */
export async function clickFirst(page, selectors) {
  const m = await findFirst(page, selectors ?? []);
  if (!m) return { ok: false, selector: null };
  try {
    await m.element.click({ force: true });
    return { ok: true, selector: m.selector };
  } catch (e) {
    return { ok: false, selector: `${m.selector} (click failed: ${e.message})` };
  }
}

/** innerText of the first matching selector. Returns {text, selector} or null. */
export async function firstText(page, selectors) {
  const m = await findFirst(page, selectors ?? []);
  if (!m) return null;
  try {
    return { text: await m.element.innerText(), selector: m.selector };
  } catch {
    return null;
  }
}

/** Whitespace-normalized lowercase — menu items render with embedded
 * newlines ('Pro\nExtended'), so raw includes() would never match. */
export function norm(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Among elements matching any of `itemSelectors`, click the first whose
 * normalized innerText contains `name`. Returns {ok, matched, seen}.
 */
export async function clickItemByText(page, itemSelectors, name) {
  const needle = norm(name);
  const seen = [];
  for (const sel of itemSelectors ?? []) {
    let els;
    try {
      els = await page.$$(sel);
    } catch {
      continue;
    }
    for (const el of els) {
      let text;
      try {
        text = (await el.innerText()).trim();
      } catch {
        continue;
      }
      if (!text) continue;
      seen.push(norm(text).slice(0, 60));
      if (norm(text).includes(needle)) {
        try {
          await el.click({ force: true });
          return { ok: true, matched: text.slice(0, 80), seen };
        } catch (e) {
          return { ok: false, matched: `${text.slice(0, 60)} (click failed: ${e.message})`, seen };
        }
      }
    }
    if (els.length > 0) break; // the right structural selector matched; name just absent
  }
  return { ok: false, matched: null, seen };
}

export async function gotoAndSettle(page, url, result, label) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settle(page);
    return record(result, label, true, url);
  } catch (e) {
    return record(result, label, false, `${url}: ${e.message}`);
  }
}

/**
 * FRESH means EMPTY: ChatGPT restores composer drafts — including
 * deep-research pills — from localStorage across navigation, and stale
 * content would ride into the next production send with the wrong mode
 * attached. Verifies emptiness, clears once if dirty, re-verifies.
 * `keepResearchPill` skips pill-clearing when research IS requested (the
 * research flow reuses an existing pill idempotently).
 */
export async function ensureComposerEmpty(page, d, result, keepResearchPill = false) {
  const composer = await findFirst(page, d.selectors.input);
  if (!composer) return false;
  let text = null;
  try {
    text = await composer.element.innerText();
  } catch {
    // unreadable now — the clear path below re-reads
  }
  const indicator = d.selectors.researchActiveIndicator ?? [];
  const pill = (!keepResearchPill && indicator.length) ? await findFirst(page, indicator) : null;
  const dirtyText = text !== null && norm(text) !== '';
  if (!dirtyText && !pill) {
    record(result, 'verify composer empty', true, 'no persisted draft');
    return true;
  }
  await composer.element.click({ force: true });
  await settle(page, 150);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await settle(page, 300);
  const after = await findFirst(page, d.selectors.input);
  let afterText = null;
  try {
    afterText = after ? await after.element.innerText() : null;
  } catch {
    // stays null → cleared stays false
  }
  const pillAfter = (!keepResearchPill && indicator.length) ? await findFirst(page, indicator) : null;
  const cleared = !!after && afterText !== null && norm(afterText) === '' && !pillAfter;
  record(result, 'clear persisted draft (fresh chat must start EMPTY)', cleared,
    `was: "${norm(text ?? '').slice(0, 50)}"${pill ? ' + research pill' : ''}`);
  return cleared;
}

/** Fresh normal chat: navigate to newChatUrl (or entryUrl), verify the composer, verify EMPTY. */
export async function openFreshChat(page, d, result, wantResearch = false) {
  const url = d.newChatUrl || d.entryUrl;
  const nav = await gotoAndSettle(page, url, result, 'open fresh chat');
  const composer = await findFirst(page, d.selectors.input);
  record(result, 'verify composer present', !!composer, composer ? composer.selector : 'no input element');
  if (!nav || !composer) return false;
  return ensureComposerEmpty(page, d, result, wantResearch);
}

/**
 * Project flow driven by registry projectNav: open the projects list, click
 * the card whose text contains the project name, start a chat inside it,
 * verify the in-project indicator. Returns true only when fully verified;
 * false means "not found / not verifiable" (caller falls back to normal chat).
 */
// Project lists hydrate slowly (Gemini's sidebar was observed stalling 40s+
// while the composer was already interactive) — poll for cards before
// concluding a project is missing.
const PROJECT_LIST_HYDRATE_MS = Number(process.env.PROJECT_LIST_HYDRATE_MS) || 30000;

/**
 * Find and click the project card for `projectName`. Match preference:
 * exact normalized text → exact first line (cards carry descriptions and
 * metadata) → unique substring. Multiple substring-only matches are
 * AMBIGUOUS and refused ("Auto" must not silently open "Auto Code").
 * Returns {ok, matched, href, seen, ambiguous}.
 */
async function pickProjectCard(page, cardSelectors, projectName) {
  const needle = norm(projectName);
  let lastSeen = [];
  for (const sel of cardSelectors ?? []) {
    let els;
    try {
      els = await page.$$(sel);
    } catch {
      continue;
    }
    if (els.length === 0) continue;
    const cands = [];
    for (const el of els) {
      let text;
      try {
        text = await el.innerText();
      } catch {
        continue;
      }
      if (norm(text)) cands.push({ el, text });
    }
    lastSeen = cands.map((c) => norm(c.text).slice(0, 60));
    const exact = cands.filter((c) => norm(c.text) === needle);
    const firstLine = cands.filter((c) => norm(String(c.text).split('\n')[0]) === needle);
    const substr = cands.filter((c) => norm(c.text).includes(needle));
    const pool = exact.length ? exact : firstLine.length ? firstLine : substr;
    if (pool.length === 0) return { ok: false, seen: lastSeen };
    if (pool.length > 1) {
      return { ok: false, seen: lastSeen, ambiguous: pool.map((c) => norm(c.text).slice(0, 60)) };
    }
    const chosen = pool[0];
    let href = null;
    try {
      href = await chosen.el.getAttribute('href');
    } catch {
      // not an anchor — URL-change fallback will verify instead
    }
    try {
      await chosen.el.click({ force: true });
      return { ok: true, matched: norm(chosen.text).slice(0, 80), href, seen: lastSeen };
    } catch (e) {
      return { ok: false, seen: lastSeen, error: e.message };
    }
  }
  return { ok: false, seen: lastSeen };
}

export async function openProjectChat(page, d, projectName, result, wantResearch = false) {
  const nav = d.selectors.projectNav ?? {};
  if (!nav.listUrl || !(nav.projectCard ?? []).length) {
    // Absence of the feature is the project_not_found warning path, not a
    // driver failure — record without flipping result.ok.
    result.steps.push({
      action: 'project navigation available',
      ok: false,
      evidence: 'no projectNav selectors in registry',
    });
    return false;
  }
  if (!(await gotoAndSettle(page, nav.listUrl, result, 'open projects list'))) return false;

  // Wait out list hydration before concluding anything.
  const hydrateDeadline = Date.now() + PROJECT_LIST_HYDRATE_MS;
  let anyCard = await findFirst(page, nav.projectCard);
  while (!anyCard && Date.now() < hydrateDeadline) {
    await settle(page, 1000);
    anyCard = await findFirst(page, nav.projectCard);
  }

  const urlBefore = page.url();
  const card = await pickProjectCard(page, nav.projectCard, projectName);
  if (!card.ok) {
    // Not finding the named project is the project_not_found path — the step
    // is recorded but must not fail the whole result. An AMBIGUOUS name is
    // also refused (never open a merely-similar project).
    result.steps.push({
      action: `find project "${projectName}"`,
      ok: false,
      evidence: card.ambiguous
        ? `ambiguous — matches: ${card.ambiguous.join(' | ')}`
        : `not among: ${card.seen.slice(0, 12).join(' | ') || '(no project cards)'}`,
    });
    return false;
  }
  record(result, `open project "${projectName}"`, true, card.matched);
  await settle(page);

  if ((nav.newChatInProject ?? []).length) {
    const newChat = await clickFirst(page, nav.newChatInProject);
    record(result, 'start new chat in project', newChat.ok, newChat.selector ?? 'no new-chat control found');
    if (newChat.ok) await settle(page, MENU_SETTLE_MS);
  }

  const composer = await findFirst(page, d.selectors.input);
  if (!composer) {
    record(result, 'verify composer in project chat', false, 'no input element');
    return false;
  }

  // Verification ladder, strongest first:
  //  1. in-project header carrying the project name;
  //  2. the URL landed on the matched card's own href (anchors);
  //  3. URL CHANGED off the list page and matches the provider's in-project
  //     shape (the card was name-matched, so navigation-stuck is the only
  //     remaining question — never satisfied by the list URL itself).
  let verifiedInProject = false;
  let evidence = '';
  const url = page.url();
  const header = (nav.projectHeader ?? []).length ? await firstText(page, nav.projectHeader) : null;
  if (header && norm(header.text).includes(norm(projectName))) {
    verifiedInProject = true;
    evidence = `header: "${norm(header.text).slice(0, 80)}"`;
  } else if (card.href && url.includes(card.href)) {
    verifiedInProject = true;
    evidence = `url matches the clicked card's href (${card.href.slice(0, 60)})`;
  } else if (nav.inProjectUrlFragment && url !== urlBefore && url.includes(nav.inProjectUrlFragment)) {
    verifiedInProject = true;
    evidence = `url ${url.slice(0, 90)} matches ${nav.inProjectUrlFragment} (navigated off the list after a name-matched click)`;
  } else {
    evidence = header
      ? `header "${norm(header.text).slice(0, 60)}" lacks project name; url ${url.slice(0, 80)}`
      : `no project header; url ${url.slice(0, 80)}${url === urlBefore ? ' (unchanged — click did not navigate)' : ''}`;
  }
  record(result, 'verify chat is inside the project', verifiedInProject, evidence);
  if (!verifiedInProject) return false;
  // Project composers restore drafts too — same emptiness contract.
  return ensureComposerEmpty(page, d, result, wantResearch);
}

/**
 * Label ↔ model-name match, boundary-anchored (raw bidirectional containment
 * verified WRONG models: label 'Flash' would satisfy '3.1 Flash-Lite').
 * Accepted shapes: exact; label with a badge suffix ('fable 5 max' for
 * 'fable 5'); label as the trailing short name ('pro' for '3.1 pro').
 */
function labelMatchesModel(labelText, modelName) {
  const label = norm(labelText);
  const model = norm(modelName);
  if (!label || !model) return false;
  return label === model
    || label.startsWith(`${model} `)
    || model.endsWith(` ${label}`);
}

/** Select a model in the picker and verify the label afterwards. */
export async function selectModel(page, d, modelName, result) {
  const sel = d.selectors;
  const before = await firstText(page, sel.modelPickerLabel);
  if (before && labelMatchesModel(before.text, modelName)) {
    record(result, `model "${modelName}"`, true, `already selected: "${norm(before.text).slice(0, 60)}"`);
    result.verified.model = { ok: true, evidence: norm(before.text).slice(0, 80) };
    return true;
  }

  const opened = await clickFirst(page, sel.modelPicker);
  if (!record(result, 'open model picker', opened.ok, opened.selector ?? 'no picker selector matched')) {
    result.verified.model = { ok: false, evidence: 'picker not found' };
    return false;
  }
  await settle(page, MENU_SETTLE_MS);

  const item = await clickItemByText(page, sel.modelPickerItem, modelName);
  if (!item.ok) {
    record(result, `pick model "${modelName}"`, false,
      `not among: ${item.seen.slice(0, 10).join(' | ') || '(no items visible)'}`);
    result.verified.model = { ok: false, evidence: item.seen.join(' | ').slice(0, 200) };
    await page.keyboard.press('Escape');
    return false;
  }
  record(result, `pick model "${modelName}"`, true, item.matched);
  await settle(page, MENU_SETTLE_MS);

  const after = await firstText(page, sel.modelPickerLabel);
  const ok = !!after && labelMatchesModel(after.text, modelName);
  record(result, `verify model label shows "${modelName}"`, ok,
    after ? `"${norm(after.text).slice(0, 80)}"` : 'label unreadable');
  result.verified.model = { ok, evidence: after ? norm(after.text).slice(0, 80) : null };
  if (!ok) await page.keyboard.press('Escape');
  return ok;
}

/** Enable a named mode toggle (from registry modeToggles) and verify. */
export async function enableMode(page, d, modeName, result) {
  const toggles = d.selectors.modeToggles ?? {};
  const selectors = toggles[modeName];
  if (!Array.isArray(selectors) || selectors.length === 0) {
    record(result, `mode "${modeName}"`, false, `no toggle selectors in registry for ${d.name}`);
    result.verified[`mode:${modeName}`] = { ok: false, evidence: 'unsupported' };
    return false;
  }
  // Re-query per read: clicks re-render these controls, and a stale handle's
  // getAttribute would read the detached node. Absent BOTH aria attributes =
  // indeterminate (null), distinct from 'off'.
  const readState = async () => {
    const found = await findFirst(page, selectors);
    if (!found) return { present: false, on: null };
    try {
      const pressed = await found.element.getAttribute('aria-pressed');
      const checked = await found.element.getAttribute('aria-checked');
      if (pressed === null && checked === null) return { present: true, on: null };
      return { present: true, on: pressed === 'true' || checked === 'true' };
    } catch {
      return { present: true, on: null };
    }
  };

  const before = await readState();
  if (!before.present) {
    record(result, `mode "${modeName}"`, false, 'toggle not found on page');
    result.verified[`mode:${modeName}`] = { ok: false, evidence: 'not found' };
    return false;
  }
  if (before.on === true) {
    record(result, `mode "${modeName}"`, true, 'already enabled');
    result.verified[`mode:${modeName}`] = { ok: true, evidence: 'already enabled' };
    return true;
  }
  const clicked = await clickFirst(page, selectors);
  if (!clicked.ok) {
    record(result, `mode "${modeName}"`, false, `click failed (${clicked.selector ?? 'gone'})`);
    result.verified[`mode:${modeName}`] = { ok: false, evidence: 'click failed' };
    return false;
  }
  await settle(page, MENU_SETTLE_MS);
  const now = await readState();
  const ok = now.on === true;
  record(result, `verify mode "${modeName}" enabled`, ok,
    now.on === null
      ? 'toggle exposes no aria-pressed/aria-checked state — cannot verify'
      : `aria state: ${now.on}`);
  result.verified[`mode:${modeName}`] = { ok, evidence: `aria state: ${now.on}` };
  return ok;
}

/**
 * Enable deep-research mode and verify via the active indicator.
 * IMPORTANT: the indicator is ALWAYS checked before acting — on ChatGPT the
 * "toggle" is a pill INSERTER (clicking twice inserts two pills). Providers
 * where research lives inside a tools menu describe it via
 * selectors.researchMenu {opener, item, matchText, closeBy}.
 */
export async function enableResearch(page, d, result) {
  const sel = d.selectors;
  const already = await findFirst(page, sel.researchActiveIndicator ?? []);
  if (already) {
    record(result, 'research mode', true, `already active (${already.selector})`);
    result.verified.research = { ok: true, evidence: already.selector };
    return true;
  }

  const menu = sel.researchMenu;
  if (menu?.opener?.length) {
    const opened = await clickFirst(page, menu.opener);
    if (!record(result, 'open tools menu', opened.ok, opened.selector ?? 'opener not found')) {
      result.verified.research = { ok: false, evidence: 'tools menu opener not found' };
      return false;
    }
    await settle(page, MENU_SETTLE_MS);
    const item = await clickItemByText(page, menu.item, menu.matchText);
    if (!record(result, `enable research ("${menu.matchText}")`, item.ok,
      item.matched ?? `not among: ${item.seen.slice(0, 10).join(' | ') || '(no menu items)'}`)) {
      result.verified.research = { ok: false, evidence: item.seen.join(' | ').slice(0, 200) };
      await page.keyboard.press('Escape');
      return false;
    }
    await settle(page, MENU_SETTLE_MS);
    // Close whatever is still open: some panels ignore Escape (ChatGPT's
    // plus popover) — those close by re-clicking the opener.
    if (menu.closeBy === 'reopen') {
      const stillOpen = await findFirst(page, menu.item);
      if (stillOpen) {
        await clickFirst(page, menu.opener);
        await settle(page, MENU_SETTLE_MS);
      }
    } else {
      await page.keyboard.press('Escape');
    }
  } else if ((sel.researchToggle ?? []).length) {
    const clicked = await clickFirst(page, sel.researchToggle);
    if (!record(result, 'enable research mode', clicked.ok, clicked.selector ?? 'toggle not found')) {
      result.verified.research = { ok: false, evidence: 'toggle not found' };
      return false;
    }
    await settle(page, MENU_SETTLE_MS);
  } else {
    record(result, 'research mode', false, `no research selectors in registry for ${d.name}`);
    result.verified.research = { ok: false, evidence: 'unsupported' };
    return false;
  }

  const active = await findFirst(page, sel.researchActiveIndicator ?? []);
  const ok = !!active;
  record(result, 'verify research mode active', ok,
    active ? active.selector : 'no active indicator matched');
  result.verified.research = { ok, evidence: active ? active.selector : null };
  return ok;
}

/**
 * Build a driver for a provider. `quirks` may override any phase:
 * {openProjectChat(page, d, name, result), selectModel(...), enableResearch(...)}.
 */
export function createDriver(providerName, quirks = {}) {
  return {
    name: providerName,

    async ensureChat(page, opts = {}) {
      const d = getProvider(providerName);
      if (!d) throw new Error(`Unknown provider: ${providerName}`);
      const result = makeResult(providerName, opts);

      // 1. Chat surface: project chat when requested and supported, else fresh chat.
      const wantResearch = !!opts.research;
      if (opts.project && d.capabilities?.projects) {
        const projectFlow = quirks.openProjectChat ?? openProjectChat;
        const inProject = await projectFlow(page, d, opts.project, result, wantResearch);
        result.verified.project = { ok: inProject, evidence: inProject ? page.url() : 'fell back to normal chat' };
        if (!inProject) {
          result.warnings.push({
            code: 'project_not_found',
            detail: `project "${opts.project}" not found/verifiable in ${providerName} — running in a normal chat`,
          });
          await openFreshChat(page, d, result, wantResearch);
        }
      } else {
        if (opts.project) {
          result.warnings.push({
            code: 'project_not_found',
            detail: `${providerName} has no project support — running in a normal chat`,
          });
          result.verified.project = { ok: false, evidence: 'provider lacks projects capability' };
        }
        await openFreshChat(page, d, result, wantResearch);
      }

      // 2. Model selection (verified via the picker label).
      if (opts.model) {
        await (quirks.selectModel ?? selectModel)(page, d, opts.model, result);
      }

      // 3. Mode toggles (extended thinking etc.). Values may carry a level
      // (e.g. {effort: 'max'}) — quirks receive it as the 5th argument.
      for (const [mode, on] of Object.entries(opts.modes ?? {})) {
        if (on) await (quirks.enableMode ?? enableMode)(page, d, mode, result, on);
      }

      // 4. Deep research (verified via the active indicator).
      if (opts.research) {
        await (quirks.enableResearch ?? enableResearch)(page, d, result);
      }

      result.url = page.url();
      return result;
    },
  };
}

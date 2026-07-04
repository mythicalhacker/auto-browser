// models/drivers/gemini.js — Gemini driver ('luminous' UI, July 2026).
// Projects = Notebooks (sidebar /notebook/<id> entries). Deep Research is a
// menuitemcheckbox in the "Upload and tools" menu (generic researchMenu flow).
// Quirk: the extended-thinking control lives INSIDE the model picker as a
// two-level menu ("Thinking level" row → Standard/Extended submenu), so
// enableMode('extendedThinking') carries that flow here; the current level is
// readable without clicking via the row's .sublabel.
import {
  createDriver, enableMode, clickFirst, clickItemByText, firstText, record, settle, norm,
} from './common.js';

const SUBMENU_ITEMS = ['gem-menu[id^="ng-menu"] gem-menu-item[role="menuitem"]', 'gem-menu gem-menu-item'];

async function enableModeGemini(page, d, modeName, result) {
  if (modeName !== 'extendedThinking') return enableMode(page, d, modeName, result);

  const sel = d.selectors;
  const rowSel = sel.modeToggles?.extendedThinking ?? [];
  const fail = (evidence) => {
    result.verified['mode:extendedThinking'] = { ok: false, evidence };
    return false;
  };
  const readLevel = async () => {
    const t = await firstText(page, rowSel.map((s) => `${s} .sublabel`));
    return t ? norm(t.text) : null;
  };

  const opened = await clickFirst(page, sel.modelPicker);
  if (!record(result, 'open model picker (thinking level lives inside it)', opened.ok,
    opened.selector ?? 'picker not found')) {
    return fail('model picker not found');
  }
  await settle(page, 700);

  let level = await readLevel();
  if (level && level.includes('extended')) {
    await page.keyboard.press('Escape');
    record(result, 'mode "extendedThinking"', true, `already on (sublabel: ${level})`);
    result.verified['mode:extendedThinking'] = { ok: true, evidence: `sublabel: ${level}` };
    return true;
  }

  const row = await clickFirst(page, rowSel);
  if (!record(result, 'open thinking-level submenu', row.ok, row.selector ?? 'row not found')) {
    await page.keyboard.press('Escape');
    return fail('thinking-level row not found in picker');
  }
  await settle(page, 700);

  const item = await clickItemByText(page, SUBMENU_ITEMS, 'Extended');
  if (!record(result, 'pick thinking level "Extended"', item.ok,
    item.matched ?? `not among: ${item.seen.slice(0, 8).join(' | ') || '(no items)'}`)) {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    return fail(`Extended not offered: ${item.seen.join(' | ').slice(0, 150)}`);
  }
  await settle(page, 700);

  // Verify from the row's sublabel — reopen the picker if the selection
  // closed it.
  level = await readLevel();
  if (level === null) {
    await clickFirst(page, sel.modelPicker);
    await settle(page, 700);
    level = await readLevel();
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const ok = !!level && level.includes('extended');
  record(result, 'verify thinking level = Extended', ok, `sublabel: ${level ?? 'unreadable'}`);
  result.verified['mode:extendedThinking'] = { ok, evidence: `sublabel: ${level ?? null}` };
  return ok;
}

export default createDriver('gemini', { enableMode: enableModeGemini });

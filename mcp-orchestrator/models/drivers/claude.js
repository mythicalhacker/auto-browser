// models/drivers/claude.js — Claude driver: ensureChat with projects, model
// picker, and research mode (generic flows over registry selectors).
// Quirk: the effort control lives INSIDE the model picker (trigger →
// effort-option-* submenu), so enableMode('effort', level) carries that flow
// here; verification reads the effort badge in the model-selector label
// (e.g. 'Fable 5 Max'). Extended thinking has no toggle in the July 2026 UI —
// thinking is built in, effort is the closest control.
import {
  createDriver, enableMode, clickFirst, clickItemByText, firstText, record, settle, norm,
} from './common.js';

async function enableModeClaude(page, d, modeName, result, value) {
  if (modeName !== 'effort') return enableMode(page, d, modeName, result, value);

  const sel = d.selectors;
  const level = typeof value === 'string' ? value : 'max';
  const fail = (evidence) => {
    result.verified['mode:effort'] = { ok: false, evidence };
    return false;
  };

  const label = await firstText(page, sel.modelPickerLabel);
  if (label && norm(label.text).includes(norm(level))) {
    record(result, `mode "effort:${level}"`, true, `already set (label: "${norm(label.text)}")`);
    result.verified['mode:effort'] = { ok: true, evidence: norm(label.text).slice(0, 80) };
    return true;
  }

  const opened = await clickFirst(page, sel.modelPicker);
  if (!record(result, 'open model picker (effort lives inside it)', opened.ok,
    opened.selector ?? 'picker not found')) {
    return fail('model picker not found');
  }
  await settle(page, 700);

  const trigger = await clickFirst(page, sel.modeToggles?.effort ?? []);
  if (!record(result, 'open effort submenu', trigger.ok, trigger.selector ?? 'trigger not found')) {
    await page.keyboard.press('Escape');
    return fail('effort trigger not found in picker');
  }
  await settle(page, 700);

  const item = await clickItemByText(page, ['[data-testid^="effort-option-"]'], level);
  if (!record(result, `pick effort "${level}"`, item.ok,
    item.matched ?? `not among: ${item.seen.slice(0, 8).join(' | ') || '(no options)'}`)) {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    return fail(`effort level not offered: ${item.seen.join(' | ').slice(0, 150)}`);
  }
  await settle(page, 700);
  await page.keyboard.press('Escape');
  await settle(page, 300);

  const after = await firstText(page, sel.modelPickerLabel);
  const ok = !!after && norm(after.text).includes(norm(level));
  record(result, `verify effort badge shows "${level}"`, ok,
    after ? `"${norm(after.text).slice(0, 80)}"` : 'label unreadable');
  result.verified['mode:effort'] = { ok, evidence: after ? norm(after.text).slice(0, 80) : null };
  return ok;
}

export default createDriver('claude', { enableMode: enableModeClaude });

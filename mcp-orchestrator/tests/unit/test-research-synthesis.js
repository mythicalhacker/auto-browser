import './_hermetic-env.js'; // pins REGISTRY_FILE + QUOTA_FILE + RESEARCH_HOME
/**
 * Research Synthesis Tests — PR-11 contract.
 * Compilation template interpolation + built-in fallback, the two-stage
 * synthesis state machine (stage-1 drafts → verdict rounds → FINAL) with
 * injected round primitives, the ≥2-reports requirement, consensus vs
 * best-of selection, FINAL.md/meta export, and the MCP tool surface.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';

const TMP = join(tmpdir(), `ab-synth-test-${process.pid}`);
process.env.RESEARCH_HOME = join(TMP, 'research');
process.env.QUOTA_FILE = join(TMP, 'quotas.json');
process.env.PROMPTS_DIR = join(TMP, 'prompts');
process.env.STATE_FILE = join(TMP, 'state.json');
rmSync(TMP, { recursive: true, force: true });

const queue = await import('../../research/research-queue.js');
const synthesis = await import('../../research/synthesis.js');
const { handleResearchToolCall, RESEARCH_TOOL_NAMES, getResearchToolDefinitions } = await import('../../tools/research.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

// Write a fake completed artifact for a task-provider and mark it complete.
function completeWith(taskId, provider, text) {
  const task = queue.getTask(taskId);
  const path = queue.artifactPathFor(task, provider);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  queue.markRunning(taskId, provider);
  queue.markSpent(taskId, provider);
  queue.recordChatUrl(taskId, provider, `https://x/${provider}`);
  queue.markComplete(taskId, provider, { artifactPath: path });
}

console.log('Research Synthesis Tests (PR-11)\n');

// --- template interpolation + fallback ---------------------------------------
console.log('compilation template:');
{
  const { batch, taskIds: [id] } = queue.submitBatch([{ prompt: 'What are the Node.js LTS lines?' }]);
  const task = queue.getTask(id);
  const reports = [{ provider: 'claude', text: 'Report A body' }, { provider: 'chatgpt', text: 'Report B body' }];
  const prompt = synthesis.buildCompilationPrompt(task, reports, synthesis.DEFAULT_COMPILATION_TEMPLATE);
  assert(prompt.includes('What are the Node.js LTS lines?'), '{{TOPIC}} interpolated');
  assert(/from\s+2\s+independent/i.test(prompt) || prompt.includes('2 independent'), '{{COUNT}} interpolated');
  assert(prompt.includes('=== REPORT FROM CLAUDE ===') && prompt.includes('Report A body')
    && prompt.includes('=== REPORT FROM CHATGPT ===') && prompt.includes('Report B body'),
    '{{REPORTS}} embeds each report FULL, labeled by provider');
  assert(!prompt.includes('{{'), 'no placeholders left unreplaced');

  // $-substitution safety: report text with $', $&, $$ must survive verbatim.
  const dollarReports = [
    { provider: 'claude', text: "shell: name=$'a\\nb'; awk '{print $&}'; price $$100" },
    { provider: 'chatgpt', text: 'regex replacement uses $` and $1' },
  ];
  const dp = synthesis.buildCompilationPrompt(task, dollarReports, 'T:{{REPORTS}}:END');
  assert(dp.includes("name=$'a\\nb'") && dp.includes('{print $&}') && dp.includes('price $$100')
    && dp.includes('$` and $1') && dp.endsWith(':END'),
    'report text with $-patterns is embedded verbatim (no replaceAll $-substitution corruption)');
  // A task prompt that itself looks like a placeholder must not re-expand.
  const trickTask = { prompt: '{{REPORTS}}' };
  const tp = synthesis.buildCompilationPrompt(trickTask, dollarReports, '{{TOPIC}} || {{REPORTS}}');
  assert(tp.startsWith('{{REPORTS}} || ') && tp.includes('REPORT FROM CLAUDE'),
    'a placeholder-like task prompt is NOT re-expanded (single pass)');

  const loaded = synthesis.loadCompilationTemplate();
  assert(loaded.source === 'built-in', 'no template file → built-in fallback');
  mkdirSync(process.env.PROMPTS_DIR, { recursive: true });
  writeFileSync(join(process.env.PROMPTS_DIR, 'compilation.md'), 'CUSTOM {{TOPIC}} / {{COUNT}} reports:\n{{REPORTS}}');
  const custom = synthesis.loadCompilationTemplate();
  assert(custom.source.endsWith('compilation.md') && custom.template.startsWith('CUSTOM'),
    'user template at ~/.auto-browser/prompts/compilation.md is loaded when present');
  // A template MISSING {{REPORTS}} would silently drop reports → reject it.
  writeFileSync(join(process.env.PROMPTS_DIR, 'compilation.md'), 'CUSTOM {{TOPIC}} but no reports placeholder');
  const bad = synthesis.loadCompilationTemplate();
  assert(bad.source === 'built-in', 'template lacking {{REPORTS}} is rejected → built-in');
  rmSync(join(process.env.PROMPTS_DIR, 'compilation.md'), { force: true });
}

// --- synthesis state machine (injected round primitives) ---------------------
console.log('\nsynthesis state machine:');

// A fake round runner that returns canned drafts, driven by a script of
// per-round {outputs, errors} and verdicts.
function fakeDeps(script) {
  let call = 0;
  const roundsSeen = [];
  return {
    calls: () => call,
    roundsSeen,
    runConsensusRound: async (_bs, prompts, roundNum) => {
      const spec = script[call++] ?? { outputs: {}, errors: {} };
      roundsSeen.push({ roundNum, prompts });
      return { round: roundNum, outputs: spec.outputs, errors: spec.errors ?? {}, timing: {} };
    },
    generateConsensusPrompt: (orig, rounds, model) => `XPOLL for ${model} @ round ${rounds.length + 1}`,
    checkConsensusReached: (rounds) => {
      const last = rounds[rounds.length - 1];
      const votes = Object.values(last.outputs || {}).map((o) => (/VERDICT:\s*AGREE\b/i.test(o) ? 'AGREE' : /VERDICT:\s*DISAGREE\b/i.test(o) ? 'DISAGREE' : null));
      const agree = votes.filter((v) => v === 'AGREE').length;
      const disagree = votes.filter((v) => v === 'DISAGREE').length;
      return agree >= 2 && disagree === 0;
    },
  };
}
const fakeBS = { getActiveModels: () => ['claude', 'chatgpt', 'gemini'] };
const bsWith = (models) => ({ getActiveModels: () => models });

{
  // Insufficient reports: <2 complete → refused, no rounds.
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'Solo report topic.' }]);
  completeWith(id, 'claude', 'only one report');
  const deps = fakeDeps([]);
  const res = await synthesis.synthesizeTask(fakeBS, id, { deps, template: 'T {{REPORTS}}' });
  assert(res.status === 'insufficient_reports' && deps.calls() === 0,
    '<2 complete reports → insufficient_reports, no synthesis round run');
}
{
  // <2 active models → refused BEFORE any send (no wasted spend).
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'Two reports one tab topic.' }]);
  completeWith(id, 'claude', 'report one full text');
  completeWith(id, 'chatgpt', 'report two full text');
  const deps = fakeDeps([{ outputs: { claude: 'd' } }]);
  const res = await synthesis.synthesizeTask(bsWith(['claude']), id, { deps, template: 'T {{REPORTS}}' });
  assert(res.status === 'insufficient_models' && deps.calls() === 0,
    '2 reports but <2 model tabs → insufficient_models, giant prompt NEVER sent');
}
{
  // A quoted "VERDICT: AGREE" in a stage-1 draft must NOT short-circuit
  // (stage 1 carries no verdict instruction).
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'Premature-verdict topic.' }]);
  completeWith(id, 'claude', 'r1');
  completeWith(id, 'chatgpt', 'r2');
  const deps = fakeDeps([
    { outputs: { claude: 'draft quoting VERDICT: AGREE from a source', chatgpt: 'draft B', gemini: 'draft C' } },
    { outputs: { claude: 'sB\nVERDICT: AGREE', chatgpt: 'sB\nVERDICT: AGREE', gemini: 'sC\nVERDICT: AGREE' } },
  ]);
  const res = await synthesis.synthesizeTask(fakeBS, id, { deps, template: 'T {{REPORTS}}' });
  assert(res.rounds === 2 && res.consensusReached === true,
    'consensus is only judged AFTER a real verdict round (quoted verdict in stage 1 ignored)');
}
{
  // Consensus on the FIRST verdict round (round 2 overall).
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'Consensus synth topic.' }]);
  completeWith(id, 'claude', 'CLAUDE deep research report ...');
  completeWith(id, 'chatgpt', 'CHATGPT deep research report ...');
  const deps = fakeDeps([
    { outputs: { claude: 'draft A', chatgpt: 'draft B', gemini: 'draft C' } }, // stage 1
    { outputs: { // verdict round → all agree
      claude: 'final synthesis long-ish text A\nVERDICT: AGREE',
      chatgpt: 'final B\nVERDICT: AGREE',
      gemini: 'final C\nVERDICT: AGREE',
    } },
  ]);
  const res = await synthesis.synthesizeTask(fakeBS, id, { deps, template: 'T:\n{{REPORTS}}', maxVerdictRounds: 2 });
  assert(res.status === 'complete' && res.consensusReached === true && res.rounds === 2,
    'stage 1 + one verdict round → consensus');
  const task = queue.getTask(id);
  const finalPath = synthesis.finalPath(task);
  assert(existsSync(finalPath), 'FINAL.md written');
  const body = readFileSync(finalPath, 'utf8');
  assert(/consensus/i.test(body) && !/VERDICT:/.test(body),
    'FINAL notes consensus and has verdict lines stripped');
  const meta = JSON.parse(readFileSync(join(dirname(finalPath), 'FINAL.meta.json'), 'utf8'));
  assert(meta.consensusReached === true && meta.sources.sort().join(',') === 'chatgpt,claude' && meta.rounds === 2,
    'FINAL.meta.json records sources, rounds, consensus');
  // stage-1 prompt embeds the reports; verdict round uses cross-pollination.
  assert(deps.roundsSeen[0].prompts === undefined || typeof deps.roundsSeen[0] === 'object', 'stage 1 ran');
  assert(deps.roundsSeen[1].prompts.claude.startsWith('XPOLL'), 'verdict round uses generateConsensusPrompt');
}
{
  // No consensus within the cap → best-of with disagreement noted.
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'No-consensus synth topic.' }]);
  completeWith(id, 'claude', 'report one');
  completeWith(id, 'chatgpt', 'report two');
  const dis = (m) => `${m} draft that is reasonably long and detailed for selection\nVERDICT: DISAGREE`;
  const deps = fakeDeps([
    { outputs: { claude: 'd1', chatgpt: 'd2', gemini: 'd3' } },
    { outputs: { claude: dis('claude'), chatgpt: dis('chatgpt'), gemini: dis('gemini') } },
    { outputs: { claude: dis('claude'), chatgpt: dis('chatgpt'), gemini: dis('gemini') } },
  ]);
  const res = await synthesis.synthesizeTask(fakeBS, id, { deps, template: 'T {{REPORTS}}', maxVerdictRounds: 2 });
  assert(res.status === 'complete' && res.consensusReached === false && res.rounds === 3,
    'stage 1 + 2 verdict rounds, still no consensus → completes at the cap');
  const body = readFileSync(synthesis.finalPath(queue.getTask(id)), 'utf8');
  assert(/no full consensus/i.test(body), 'FINAL notes the lack of consensus and points to per-provider reports');
}
{
  // Stage 1 producing <2 drafts → failed (can't synthesize from one).
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'One-draft topic.' }]);
  completeWith(id, 'claude', 'r1');
  completeWith(id, 'chatgpt', 'r2');
  const deps = fakeDeps([{ outputs: { claude: 'only draft' }, errors: { chatgpt: { message: 'x', phase: 'wait' } } }]);
  const res = await synthesis.synthesizeTask(fakeBS, id, { deps, template: 'T {{REPORTS}}' });
  assert(res.status === 'failed' && deps.calls() === 1, 'only one stage-1 draft → failed, no verdict rounds');
}
{
  // An ALL-ERROR final verdict round must fall back to earlier good drafts —
  // the paid synthesis is never thrown away.
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'All-error final round topic.' }]);
  completeWith(id, 'claude', 'r1');
  completeWith(id, 'chatgpt', 'r2');
  const deps = fakeDeps([
    { outputs: { claude: 'good stage-1 draft with real content here', chatgpt: 'another solid draft', gemini: 'third draft' } },
    { outputs: {}, errors: { claude: { message: 'Timeout waiting for response', phase: 'wait' }, chatgpt: { message: 'Timeout waiting for response', phase: 'wait' }, gemini: { message: 'Timeout waiting for response', phase: 'wait' } } },
  ]);
  const res = await synthesis.synthesizeTask(fakeBS, id, { deps, template: 'T {{REPORTS}}', maxVerdictRounds: 1 });
  assert(res.status === 'complete', 'all-error final round degrades to earlier drafts, not failure');
  const body = readFileSync(synthesis.finalPath(queue.getTask(id)), 'utf8');
  assert(/stage-1 draft|solid draft/.test(body), 'FINAL falls back to the last round that produced drafts');
}
{
  // Verdict rounds must NOT re-embed the full compilation prompt as ORIGINAL
  // REQUEST (that made each round larger than stage 1).
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'Size-check topic.' }]);
  const bigReport = 'X'.repeat(40000);
  completeWith(id, 'claude', bigReport);
  completeWith(id, 'chatgpt', bigReport);
  const deps = fakeDeps([
    { outputs: { claude: 'd1', chatgpt: 'd2', gemini: 'd3' } },
    { outputs: { claude: 'sB\nVERDICT: DISAGREE', chatgpt: 'sB\nVERDICT: DISAGREE', gemini: 'sC\nVERDICT: DISAGREE' } },
  ]);
  await synthesis.synthesizeTask(fakeBS, id, { deps, template: 'REPORTS:\n{{REPORTS}}', maxVerdictRounds: 1 });
  const verdictPrompt = deps.roundsSeen[1].prompts.claude;
  assert(!verdictPrompt.includes(bigReport) && verdictPrompt.length < 5000,
    'verdict-round prompt does NOT re-embed the 40k-char reports (short task restatement only)');
}
{
  // NaN max_verdict_rounds must default to 2, not silently skip stage 2.
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'NaN rounds topic.' }]);
  completeWith(id, 'claude', 'r1');
  completeWith(id, 'chatgpt', 'r2');
  const deps = fakeDeps([
    { outputs: { claude: 'd1', chatgpt: 'd2', gemini: 'd3' } },
    { outputs: { claude: 'x\nVERDICT: DISAGREE', chatgpt: 'x\nVERDICT: DISAGREE', gemini: 'x\nVERDICT: DISAGREE' } },
    { outputs: { claude: 'x\nVERDICT: DISAGREE', chatgpt: 'x\nVERDICT: DISAGREE', gemini: 'x\nVERDICT: DISAGREE' } },
  ]);
  const res = await synthesis.synthesizeTask(fakeBS, id, { deps, template: 'T {{REPORTS}}', maxVerdictRounds: 'oops' });
  assert(res.rounds === 3, 'non-numeric maxVerdictRounds → default 2 verdict rounds (not skipped)');
}

// --- MCP tool surface --------------------------------------------------------
console.log('\nMCP research tools:');
{
  const names = getResearchToolDefinitions().map((t) => t.name).sort();
  assert(names.join(',') === 'quota_status,research_collect,research_export,research_status,research_submit_batch,research_synthesize',
    'six research tools defined');

  const bad = await handleResearchToolCall('research_submit_batch', { items: [] });
  assert(bad.isError && /non-empty array/.test(bad.content[0].text), 'submit rejects empty items');

  const good = await handleResearchToolCall('research_submit_batch', {
    items: [{ prompt: 'tool batch A', gemini_priority: true }, { prompt: 'tool batch B' }],
  });
  assert(!good.isError && /2 task\(s\)/.test(good.content[0].text) && /1 gemini-priority/.test(good.content[0].text),
    'submit routes and reports gemini-priority count');
  const batchId = good.content[0].text.match(/batch (\S+):/)[1];

  const st = await handleResearchToolCall('research_status', { batch: batchId });
  assert(!st.isError && /gemini:queued/.test(st.content[0].text) && /claude:queued/.test(st.content[0].text),
    'status shows per-provider state');

  const qs = await handleResearchToolCall('quota_status', {});
  assert(!qs.isError && /gemini: DR today/.test(qs.content[0].text) && /uncapped/.test(qs.content[0].text),
    'quota_status shows caps and eligibility');

  const exportMiss = await handleResearchToolCall('research_export', { task_id: 'task-does-not-exist' });
  assert(exportMiss.isError && /unknown task/.test(exportMiss.content[0].text), 'export unknown task → error');

  const synthNoBrowser = await handleResearchToolCall('research_synthesize', { task_id: queue.listTasks({ batch: batchId })[0].id });
  assert(synthNoBrowser.isError && /live browser/.test(synthNoBrowser.content[0].text),
    'synthesize without a browser fails cleanly (headless path required)');

  // research_synthesize refuses (and does NOT connect the browser) while
  // ANOTHER process holds the drain lock — mutual exclusion is cross-process.
  const synthId = queue.listTasks({ batch: batchId })[0].id;
  completeWith(synthId, 'claude', 'claude report body for tool synth');
  completeWith(synthId, 'chatgpt', 'chatgpt report body for tool synth');
  let connected = false;
  const fakeBrowser = { connect: async () => { connected = true; }, getActiveModels: () => ['claude', 'chatgpt', 'gemini'] };
  const { join: pjoin } = await import('path');
  const { writeFileSync: wf } = await import('fs');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200));
  wf(pjoin(process.env.RESEARCH_HOME, 'runner.lock'), JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
  const blocked = await handleResearchToolCall('research_synthesize', { task_id: synthId }, fakeBrowser);
  assert(blocked.isError && /active/.test(blocked.content[0].text) && connected === false,
    'research_synthesize refuses (and does not connect) while another process holds the lock');
  child.kill('SIGKILL');
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

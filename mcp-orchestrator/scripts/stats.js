#!/usr/bin/env node
/**
 * Standalone operational stats renderer for Auto Browser.
 *
 * Shape assumptions, copied from writer code without importing product modules:
 * - research/quota-ledger.js writes quotas.json as
 *   { providers: { [provider]: { day, used, cooldownUntil, cooldownReason } } }.
 *   The ledger does not persist caps, so this read-only CLI uses the current
 *   default provider caps observed in models/registry.js (gemini: 5/day;
 *   claude/chatgpt: uncapped) unless a future entry includes cap,
 *   dailyCap, or deepResearchPerDay.
 * - utils/latency-stats.js writes timing-stats.json as
 *   { [model]: { samples: number[], timeouts: number } } and derives p50/p95
 *   with floor((p / 100) * sampleCount) over sorted samples.
 * - research/runner.js writes provider meta files beside artifacts as
 *   <provider>.meta.json with { task, batch, provider, prompt, project, chars,
 *   chatUrl, startedAt, finishedAt, durationMs }.
 *
 * This file intentionally imports only Node core modules and never imports the
 * product's runtime modules.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const HELP = `Usage:
  node scripts/stats.js [--json] [--home <path>]
  node scripts/stats.js --batch <batch-id|path> [--json]

Options:
  --json                 Render machine-readable JSON.
  --home <path>          Override AUTO_BROWSER_HOME.
  --quota-file <path>    Override quotas.json.
  --timing-file <path>   Override timing-stats.json.
  --research-home <path> Override research batch home.
  --batch <id|path>      Include per-task provider artifact status.
  --help                 Show this help.
`;

const DEFAULT_DR_CAPS = Object.freeze({
  claude: null,
  chatgpt: null,
  gemini: 5,
});

const PROVIDER_ORDER = Object.freeze(['claude', 'chatgpt', 'gemini']);
const VALUE_FLAGS = new Set(['--home', '--quota-file', '--timing-file', '--research-home', '--batch']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expandHome(path) {
  const text = String(path);
  if (text === '~') return homedir();
  if (text.startsWith(`~${sep}`) || text.startsWith('~/')) return join(homedir(), text.slice(2));
  return text;
}

function resolvePath(path) {
  return resolve(expandHome(path));
}

function parseArgs(argv) {
  const opts = { json: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      setValueOpt(opts, arg, value);
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) throw new Error(`unknown option: ${arg}`);
      const key = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (!VALUE_FLAGS.has(key)) throw new Error(`unknown option: ${key}`);
      if (!value) throw new Error(`${key} requires a value`);
      setValueOpt(opts, key, value);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  return opts;
}

function setValueOpt(opts, key, value) {
  const map = {
    '--home': 'home',
    '--quota-file': 'quotaFile',
    '--timing-file': 'timingFile',
    '--research-home': 'researchHome',
    '--batch': 'batch',
  };
  opts[map[key]] = value;
}

function resolvePaths(opts, env) {
  const autoHome = resolvePath(opts.home || env.AUTO_BROWSER_HOME || join(homedir(), '.auto-browser'));
  const quotaFile = resolvePath(opts.quotaFile || env.QUOTA_FILE || join(autoHome, 'quotas.json'));
  const timingFile = resolvePath(
    opts.timingFile
      || env.TIMING_STATS_FILE
      || (env.STATE_FILE ? join(dirname(resolvePath(env.STATE_FILE)), 'timing-stats.json') : null)
      || join(autoHome, 'timing-stats.json')
  );
  const researchHome = resolvePath(opts.researchHome || env.RESEARCH_HOME || join(autoHome, 'research'));

  return { autoHome, quotaFile, timingFile, researchHome };
}

function readJsonFile(path, label) {
  try {
    if (!existsSync(path)) return { ok: false, warning: `${label} missing: ${path}`, missing: true };
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { ok: false, warning: `${label} could not be parsed: ${path} (${error.message})`, corrupt: true };
  }
}

function localDay(nowMs) {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseTimestamp(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function capFor(provider, entry) {
  for (const key of ['cap', 'dailyCap', 'deepResearchPerDay']) {
    if (entry[key] === null) return { known: true, value: null, source: 'file' };
    if (Number.isFinite(entry[key])) return { known: true, value: entry[key], source: 'file' };
  }
  if (Object.hasOwn(DEFAULT_DR_CAPS, provider)) {
    return { known: true, value: DEFAULT_DR_CAPS[provider], source: 'default' };
  }
  return { known: false, value: null, source: 'unknown' };
}

function providerSort(a, b) {
  const ai = PROVIDER_ORDER.indexOf(a);
  const bi = PROVIDER_ORDER.indexOf(b);
  if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  return a.localeCompare(b);
}

function loadQuotas(path, nowMs) {
  const read = readJsonFile(path, 'quotas');
  const result = { source: path, warnings: [], rows: [] };
  if (!read.ok) {
    result.warnings.push(read.warning);
    return result;
  }

  if (!isPlainObject(read.value)) {
    result.warnings.push(`quotas has unexpected shape: expected an object`);
    return result;
  }

  let providers = {};
  if (read.value.providers === undefined) {
    providers = {};
  } else if (isPlainObject(read.value.providers)) {
    providers = read.value.providers;
  } else {
    result.warnings.push(`quotas.providers has unexpected shape: expected an object`);
    return result;
  }

  const today = localDay(nowMs);
  for (const provider of Object.keys(providers).sort(providerSort)) {
    const entry = providers[provider];
    if (!isPlainObject(entry)) {
      result.rows.push({
        provider,
        day: today,
        storedDay: null,
        used: 0,
        storedUsed: null,
        capKnown: false,
        cap: null,
        capSource: 'unknown',
        remaining: null,
        eligible: true,
        cooldownUntil: null,
        cooldownReason: null,
        note: 'unexpected provider entry shape',
      });
      continue;
    }

    const storedDay = typeof entry.day === 'string' && entry.day ? entry.day : null;
    const storedUsed = Number.isFinite(entry.used) ? entry.used : 0;
    const rolledOver = storedDay !== null && storedDay !== today;
    const used = rolledOver ? 0 : storedUsed;
    const cap = capFor(provider, entry);
    const cooldownUntil = parseTimestamp(entry.cooldownUntil);
    const cooldownReason = typeof entry.cooldownReason === 'string' && entry.cooldownReason
      ? entry.cooldownReason
      : null;
    const cooldownActive = cooldownUntil !== null && nowMs < cooldownUntil;
    const atCap = cap.known && cap.value !== null && used >= cap.value;
    const notes = [];

    if (rolledOver) notes.push(`rolled over from ${storedDay} (stored used ${storedUsed})`);
    if (!cap.known) notes.push('cap unknown');
    if (cooldownReason) notes.push(`cooldown: ${cooldownReason}`);
    if (atCap) notes.push('daily cap reached');

    result.rows.push({
      provider,
      day: rolledOver ? today : (storedDay || today),
      storedDay,
      used,
      storedUsed,
      capKnown: cap.known,
      cap: cap.value,
      capSource: cap.source,
      remaining: cap.known && cap.value !== null ? Math.max(0, cap.value - used) : null,
      eligible: !cooldownActive && !atCap,
      cooldownUntil,
      cooldownReason,
      note: notes.join('; '),
    });
  }

  return result;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function loadLatency(path) {
  const read = readJsonFile(path, 'timing stats');
  const result = { source: path, warnings: [], rows: [] };
  if (!read.ok) {
    result.warnings.push(read.warning);
    return result;
  }

  if (!isPlainObject(read.value)) {
    result.warnings.push(`timing stats has unexpected shape: expected an object`);
    return result;
  }

  for (const model of Object.keys(read.value).sort(providerSort)) {
    const entry = read.value[model];
    if (!isPlainObject(entry)) {
      result.rows.push({
        model,
        count: 0,
        p50: null,
        p95: null,
        max: null,
        timeouts: 0,
        note: 'unexpected model entry shape',
      });
      continue;
    }
    const samples = Array.isArray(entry.samples)
      ? entry.samples.filter((sample) => Number.isFinite(sample)).sort((a, b) => a - b)
      : [];
    const note = Array.isArray(entry.samples) && samples.length !== entry.samples.length
      ? 'ignored non-numeric samples'
      : '';

    result.rows.push({
      model,
      count: samples.length,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      max: samples.length ? samples[samples.length - 1] : null,
      timeouts: Number.isFinite(entry.timeouts) ? entry.timeouts : 0,
      note,
    });
  }

  return result;
}

function looksLikePath(value) {
  return isAbsolute(value) || value.startsWith('.') || value.includes('/') || value.includes('\\');
}

function resolveBatch(value, researchHome) {
  if (looksLikePath(value)) {
    const batchDir = resolvePath(value);
    return { batch: basename(batchDir), batchDir, queuePath: join(dirname(batchDir), 'queue.json') };
  }
  return { batch: value, batchDir: join(researchHome, value), queuePath: join(researchHome, 'queue.json') };
}

function safeExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function safeIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function metaPathForArtifact(artifactPath) {
  return artifactPath.endsWith('.md')
    ? artifactPath.replace(/\.md$/, '.meta.json')
    : `${artifactPath}.meta.json`;
}

function defaultArtifactPath(batchDir, taskId, provider) {
  return join(batchDir, taskId, `${provider}.md`);
}

function readMeta(path, warnings) {
  const read = readJsonFile(path, 'artifact meta');
  if (!read.ok) {
    if (!read.missing) warnings.push(read.warning);
    return { meta: null, ok: false, warning: read.warning };
  }
  if (!isPlainObject(read.value)) {
    const warning = `artifact meta has unexpected shape: ${path}`;
    warnings.push(warning);
    return { meta: null, ok: false, warning };
  }
  return { meta: read.value, ok: true, warning: null };
}

function rowFromQueueTask(task, provider, state, batchDir, warnings) {
  const artifactPath = typeof state.artifactPath === 'string' && state.artifactPath
    ? state.artifactPath
    : defaultArtifactPath(batchDir, task.id, provider);
  const artifactExists = safeExists(artifactPath);
  const metaPath = metaPathForArtifact(artifactPath);
  const metaExists = safeExists(metaPath);
  const metaRead = metaExists ? readMeta(metaPath, warnings) : { meta: null, ok: false, warning: null };
  const meta = metaRead.meta;
  const noteParts = [];
  if (state.error) noteParts.push(String(state.error));
  if (metaRead.warning) noteParts.push(metaRead.warning);

  return {
    task: task.id,
    batch: task.batch,
    provider,
    prompt: typeof task.prompt === 'string' ? task.prompt : (typeof meta?.prompt === 'string' ? meta.prompt : ''),
    project: task.project ?? meta?.project ?? null,
    status: String(state.status ?? 'unknown'),
    attempts: Number.isFinite(state.attempts) ? state.attempts : null,
    spent: state.spent === true,
    chatUrl: typeof state.chatUrl === 'string' ? state.chatUrl : (typeof meta?.chatUrl === 'string' ? meta.chatUrl : null),
    artifactPath,
    artifactExists,
    metaPath,
    metaExists,
    metaOk: metaRead.ok,
    chars: Number.isFinite(meta?.chars) ? meta.chars : fileSize(artifactPath),
    durationMs: Number.isFinite(meta?.durationMs) ? meta.durationMs : null,
    note: noteParts.join('; '),
  };
}

function scanBatchArtifacts(batch, batchDir, warnings) {
  const rows = [];
  if (!safeIsDirectory(batchDir)) return rows;

  let taskDirs = [];
  try {
    taskDirs = readdirSync(batchDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    warnings.push(`batch directory could not be read: ${batchDir} (${error.message})`);
    return rows;
  }

  for (const taskId of taskDirs) {
    const taskDir = join(batchDir, taskId);
    let files = [];
    try {
      files = readdirSync(taskDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (error) {
      warnings.push(`task artifact directory could not be read: ${taskDir} (${error.message})`);
      continue;
    }

    const providers = new Set();
    for (const file of files) {
      if (file === 'FINAL.md' || file === 'FINAL.meta.json') continue;
      if (file.endsWith('.md')) providers.add(file.slice(0, -3));
      if (file.endsWith('.meta.json')) providers.add(file.slice(0, -10));
    }

    for (const provider of [...providers].sort(providerSort)) {
      const artifactPath = defaultArtifactPath(batchDir, taskId, provider);
      const metaPath = metaPathForArtifact(artifactPath);
      const artifactExists = safeExists(artifactPath);
      const metaExists = safeExists(metaPath);
      const metaRead = metaExists ? readMeta(metaPath, warnings) : { meta: null, ok: false, warning: null };
      const meta = metaRead.meta;
      rows.push({
        task: taskId,
        batch: typeof meta?.batch === 'string' ? meta.batch : batch,
        provider: typeof meta?.provider === 'string' ? meta.provider : provider,
        prompt: typeof meta?.prompt === 'string' ? meta.prompt : '',
        project: meta?.project ?? null,
        status: artifactExists ? 'artifact' : 'missing_artifact',
        attempts: null,
        spent: null,
        chatUrl: typeof meta?.chatUrl === 'string' ? meta.chatUrl : null,
        artifactPath,
        artifactExists,
        metaPath,
        metaExists,
        metaOk: metaRead.ok,
        chars: Number.isFinite(meta?.chars) ? meta.chars : fileSize(artifactPath),
        durationMs: Number.isFinite(meta?.durationMs) ? meta.durationMs : null,
        note: metaRead.warning || '',
      });
    }
  }

  return rows;
}

function loadBatchStatus(batchArg, researchHome) {
  const resolved = resolveBatch(batchArg, researchHome);
  const result = {
    batch: resolved.batch,
    batchDir: resolved.batchDir,
    queuePath: resolved.queuePath,
    warnings: [],
    rows: [],
  };

  const queueRead = readJsonFile(resolved.queuePath, 'research queue');
  if (queueRead.ok) {
    const queue = queueRead.value;
    if (isPlainObject(queue) && isPlainObject(queue.tasks)) {
      const order = Array.isArray(queue.order) ? queue.order : Object.keys(queue.tasks).sort();
      for (const taskId of order) {
        const task = queue.tasks[taskId];
        if (!isPlainObject(task) || task.batch !== resolved.batch) continue;
        const perProvider = isPlainObject(task.perProvider) ? task.perProvider : {};
        for (const provider of Object.keys(perProvider).sort(providerSort)) {
          result.rows.push(rowFromQueueTask(task, provider, perProvider[provider] || {}, resolved.batchDir, result.warnings));
        }
      }
    } else {
      result.warnings.push(`research queue has unexpected shape: ${resolved.queuePath}`);
    }
  } else if (!queueRead.missing) {
    result.warnings.push(queueRead.warning);
  }

  if (result.rows.length === 0) {
    result.rows = scanBatchArtifacts(resolved.batch, resolved.batchDir, result.warnings);
  }

  if (result.rows.length === 0 && !safeIsDirectory(resolved.batchDir)) {
    result.warnings.push(`batch directory missing: ${resolved.batchDir}`);
  }

  return result;
}

function dash(value) {
  return value === null || value === undefined || value === '' ? '-' : String(value);
}

function truncate(value, width) {
  const text = dash(value);
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 3))}...`;
}

function formatCap(row) {
  if (!row.capKnown) return 'unknown';
  return row.cap === null ? 'uncapped' : String(row.cap);
}

function formatRemaining(row) {
  if (!row.capKnown) return 'unknown';
  return row.cap === null ? 'uncapped' : String(row.remaining);
}

function formatCooldown(row) {
  if (row.cooldownUntil === null || row.cooldownUntil === undefined) return '-';
  return `${row.eligible ? 'expired' : 'until'} ${new Date(row.cooldownUntil).toISOString()}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderTable(headers, rows) {
  const widths = headers.map((header, index) => {
    const cells = rows.map((row) => String(row[index] ?? ''));
    return Math.max(String(header).length, ...cells.map((cell) => cell.length));
  });
  const line = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ').trimEnd();
  return [
    line(headers),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
  ].join('\n');
}

function renderQuotaTable(quotas) {
  const headers = ['Provider', 'Day', 'Used', 'Cap', 'Remaining', 'Eligible', 'Cooldown', 'Note'];
  const rows = quotas.warnings.map((warning) => ['WARNING', '-', '-', '-', '-', '-', '-', warning]);
  for (const row of quotas.rows) {
    rows.push([
      row.provider,
      row.day,
      row.used,
      formatCap(row),
      formatRemaining(row),
      row.eligible ? 'yes' : 'no',
      formatCooldown(row),
      dash(row.note),
    ]);
  }
  if (rows.length === 0) rows.push(['INFO', '-', '0', '-', '-', '-', '-', 'No quota providers recorded.']);
  return `Deep Research Quotas\n${renderTable(headers, rows)}`;
}

function renderLatencyTable(latency) {
  const headers = ['Model', 'Samples', 'p50_ms', 'p95_ms', 'max_ms', 'Timeouts', 'Note'];
  const rows = latency.warnings.map((warning) => ['WARNING', '-', '-', '-', '-', '-', warning]);
  for (const row of latency.rows) {
    rows.push([
      row.model,
      row.count,
      dash(row.p50),
      dash(row.p95),
      dash(row.max),
      row.timeouts,
      dash(row.note),
    ]);
  }
  if (rows.length === 0) rows.push(['INFO', '0', '-', '-', '-', '0', 'No latency samples recorded.']);
  return `Latency Stats\n${renderTable(headers, rows)}`;
}

function renderBatchTable(batch) {
  const headers = ['Task', 'Provider', 'Status', 'Artifact', 'Meta', 'Chars', 'Duration', 'Prompt', 'Note'];
  const rows = batch.warnings.map((warning) => ['WARNING', '-', '-', '-', '-', '-', '-', '-', warning]);
  for (const row of batch.rows) {
    rows.push([
      row.task,
      row.provider,
      row.status,
      row.artifactExists ? 'yes' : 'missing',
      row.metaExists ? (row.metaOk ? 'yes' : 'warn') : 'missing',
      dash(row.chars),
      formatDuration(row.durationMs),
      truncate(row.prompt, 40),
      dash(row.note),
    ]);
  }
  if (rows.length === 0) rows.push(['INFO', '-', '-', '-', '-', '-', '-', '-', 'No batch artifacts recorded.']);
  return `Batch Status: ${batch.batch}\n${renderTable(headers, rows)}`;
}

function collectData(argv, env, nowMs) {
  const opts = parseArgs(argv);
  if (opts.help) return { help: true };

  const paths = resolvePaths(opts, env);
  const data = {
    generatedAt: new Date(nowMs).toISOString(),
    paths,
    quotas: loadQuotas(paths.quotaFile, nowMs),
    latency: loadLatency(paths.timingFile),
  };
  if (opts.batch) data.batch = loadBatchStatus(opts.batch, paths.researchHome);
  return { opts, data };
}

function renderText(data) {
  const sections = [
    renderQuotaTable(data.quotas),
    renderLatencyTable(data.latency),
  ];
  if (data.batch) sections.push(renderBatchTable(data.batch));
  return `${sections.join('\n\n')}\n`;
}

export function run(argv = process.argv.slice(2), env = process.env, nowMs = Date.now()) {
  const collected = collectData(argv, env, nowMs);
  if (collected.help) return `${HELP}\n`;
  return collected.opts.json ? `${JSON.stringify(collected.data, null, 2)}\n` : renderText(collected.data);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  try {
    process.stdout.write(run());
  } catch (error) {
    process.stderr.write(`stats: ${error.message}\n`);
    process.exit(2);
  }
}

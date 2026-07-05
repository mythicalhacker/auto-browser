// utils/health-check.js — System health diagnostics
import { checkAllLogins } from './login-check.js';
import { getAllUsageStats } from './rate-limiter.js';
import { latencySummary } from './latency-stats.js';
import { getProvider } from '../models/registry.js';
import { readModelLabel } from '../models/drivers/common.js';

export async function getHealthReport(browserService) {
  const report = {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    chrome: { connected: false, models: [], tabCount: 0 },
    logins: {},
    models: {},
    overall: 'unknown'
  };

  try {
    // isConnected(), getActiveModels(), getPage() are all synchronous
    const connected = browserService.isConnected();
    const models = connected ? browserService.getActiveModels() : [];
    report.chrome = {
      connected,
      models,
      tabCount: models.length
    };

    if (connected && models.length > 0) {
      const pages = {};
      for (const model of models) {
        const page = browserService.getPage(model);
        if (page) pages[model] = page;
      }
      const { allLoggedIn, results } = await checkAllLogins(pages);
      report.logins = results;
      report._allLoggedIn = allLoggedIn;

      // Visibility (PR-14): the model each tab currently shows, read passively
      // from the picker label (no menu, no send) + the configured
      // default/cheapest so cost choices are auditable.
      for (const model of models) {
        const page = pages[model];
        const d = getProvider(model);
        let current = null;
        try {
          current = page && d ? await readModelLabel(page, d) : null;
        } catch {
          current = null; // unreadable label is not a health failure
        }
        report.models[model] = {
          current,
          default: d?.models?.default ?? null,
          cheapest: d?.models?.cheapest ?? null,
        };
      }
    }
  } catch (e) {
    report.chrome.error = e.message;
  }

  // Observability (PR-5): per-platform send counts this session, and the
  // persisted response-latency baselines that inform timeout ceilings.
  report.rateLimits = getAllUsageStats();
  report.latency = latencySummary();

  report.memoryFormatted = {
    heapUsed: `${Math.round(report.memory.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(report.memory.heapTotal / 1024 / 1024)}MB`,
    rss: `${Math.round(report.memory.rss / 1024 / 1024)}MB`
  };

  // Determine overall status
  if (!report.chrome.connected) report.overall = 'disconnected';
  else if (report.chrome.models.length === 0) report.overall = 'no_model_tabs';
  else if (!report._allLoggedIn) report.overall = 'partial';
  else report.overall = 'healthy';

  // Clean up internal field
  delete report._allLoggedIn;

  return report;
}

export function formatHealthReport(report) {
  let text = `=== Health Check (${report.timestamp}) ===\n\n`;
  text += `Status: ${report.overall.toUpperCase()}\n`;
  text += `Uptime: ${Math.round(report.uptime)}s\n`;
  text += `Memory: ${report.memoryFormatted.heapUsed} / ${report.memoryFormatted.heapTotal}\n\n`;
  text += `Chrome: ${report.chrome.connected ? 'Connected' : 'Disconnected'}\n`;
  text += `Model tabs: ${report.chrome.models.join(', ') || 'None'}\n`;
  text += `Total tabs: ${report.chrome.tabCount}\n\n`;
  if (Object.keys(report.logins).length > 0) {
    text += `Login Status:\n`;
    for (const [model, status] of Object.entries(report.logins)) {
      text += `  ${model}: ${status.loggedIn ? 'OK' : 'FAIL'} ${status.reason}\n`;
    }
  }
  if (report.models && Object.keys(report.models).length > 0) {
    text += `\nCurrent model per tab (verified live · configured default/cheapest):\n`;
    for (const [model, m] of Object.entries(report.models)) {
      text += `  ${model}: ${m.current ?? 'unknown'} (default: ${m.default ?? '—'}, cheapest: ${m.cheapest ?? '—'})\n`;
    }
  }
  text += `\nRate limits (sends this session):\n`;
  for (const s of report.rateLimits || []) {
    text += `  ${s.model}: ${s.used}/${s.limit === Infinity ? 'unlimited' : s.limit} per ${s.window}${s.warning ? ' — ' + s.warning : ''}\n`;
  }
  const latencies = Object.entries(report.latency || {});
  if (latencies.length > 0) {
    text += `\nResponse latency (persisted across runs):\n`;
    for (const [model, s] of latencies) {
      const pcts = s.count > 0 ? ` p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms` : '';
      text += `  ${model}: n=${s.count}${pcts} timeouts=${s.timeouts}\n`;
    }
  }
  return text;
}

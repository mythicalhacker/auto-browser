// utils/health-check.js — System health diagnostics
import { checkAllLogins } from './login-check.js';

export async function getHealthReport(browserService) {
  const report = {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    chrome: { connected: false, models: [], tabCount: 0 },
    logins: {},
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
    }
  } catch (e) {
    report.chrome.error = e.message;
  }

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
  return text;
}

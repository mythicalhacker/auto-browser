// services/context-enricher.js — Pre-inference context gathering
import { checkLogin } from '../utils/login-check.js';
import { handleTaskToolCall } from '../tools/task-queue.js';

/**
 * Gather context before model calls: model availability, dependency results, URLs.
 * @param {object} task — Task object from the task queue
 * @param {object} browserService — BrowserService instance
 * @returns {Promise<object>} enrichments
 */
export async function enrichContext(task, browserService) {
  const enrichments = {};

  await Promise.all([
    // 1. Check model availability
    (async () => {
      const activeModels = browserService.getActiveModels();
      const target = task.target === 'auto' ? null : task.target;

      if (target && target !== 'consensus' && target !== 'all') {
        // Single model target
        const page = browserService.getPage(target);
        if (page) {
          enrichments.modelStatus = await checkLogin(page, target);
        } else {
          enrichments.modelStatus = { loggedIn: false, reason: `No page found for ${target}` };
        }
      } else {
        // Multi-model: check all active models
        enrichments.modelStatuses = {};
        for (const model of activeModels) {
          const page = browserService.getPage(model);
          if (page) {
            enrichments.modelStatuses[model] = await checkLogin(page, model);
          }
        }
      }
    })(),

    // 2. Gather dependency results
    (async () => {
      if (task.depends_on && task.depends_on.length > 0) {
        enrichments.dependencyResults = {};
        for (const depId of task.depends_on) {
          try {
            const status = await handleTaskToolCall('task_status', { task_id: depId });
            enrichments.dependencyResults[depId] = JSON.parse(status.content[0].text);
          } catch {
            // Dependency not found — skip silently
          }
        }
      }
    })(),

    // 3. Extract URLs from prompt
    (async () => {
      const urlRegex = /https?:\/\/[^\s)]+/g;
      enrichments.urls = task.prompt.match(urlRegex) || [];
    })()
  ]);

  return enrichments;
}

/**
 * Build an enriched prompt by prepending dependency context.
 * @param {object} task — Task object
 * @param {object} enrichments — Result from enrichContext()
 * @returns {string} enriched prompt
 */
export function buildEnrichedPrompt(task, enrichments) {
  let prompt = task.prompt;
  if (enrichments.dependencyResults && Object.keys(enrichments.dependencyResults).length > 0) {
    const depContext = Object.entries(enrichments.dependencyResults)
      .map(([id, result]) => `[Previous task ${id} result]: ${JSON.stringify(result).substring(0, 500)}`)
      .join('\n');
    prompt = `CONTEXT FROM PREVIOUS TASKS:\n${depContext}\n\n---\n\nCURRENT TASK:\n${prompt}`;
  }
  return prompt;
}

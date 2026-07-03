// utils/state-recovery.js - Detect and recover interrupted state on startup
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(__dirname, '..', 'state', 'tasks');

export function recoverInterruptedTasks(maxStaleMinutes = 5) {
  if (!existsSync(TASKS_DIR)) {
    return { interrupted: [], summary: 'No task state directory found.' };
  }

  const interrupted = [];
  let files;
  try {
    files = readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return { interrupted: [], summary: 'No task state directory found.' };
  }

  for (const file of files) {
    try {
      const task = JSON.parse(readFileSync(path.join(TASKS_DIR, file), 'utf8'));
      if (task.status === 'active') {
        const staleMinutes = (Date.now() - new Date(task.updated_at).getTime()) / 60000;
        if (staleMinutes > maxStaleMinutes) {
          interrupted.push({
            ...task,
            staleMinutes: Math.round(staleMinutes),
            recommendation: staleMinutes > 30 ? 'cancel' : 'resume'
          });
        }
      }
    } catch {
      // Silently skip malformed files
    }
  }

  let summary;
  if (interrupted.length === 0) {
    summary = 'No interrupted tasks found.';
  } else {
    summary = `Found ${interrupted.length} interrupted task(s):\n` +
      interrupted.map(t =>
        `  [${t.id}] ${t.name} — stale for ${t.staleMinutes} min (recommend: ${t.recommendation})`
      ).join('\n');
  }

  return { interrupted, summary };
}

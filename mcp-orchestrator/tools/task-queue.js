// tools/task-queue.js — Task queue management
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(__dirname, '..', 'state', 'tasks');

if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });

const tasks = new Map();
// taskCounter is only incremented via ++taskCounter (atomic in single-threaded Node.js).
// No race condition risk since Node.js is single-threaded and we never yield between read and write.
let taskCounter = 0;

// Load existing tasks from disk on module init
function loadTasks() {
  if (!existsSync(TASKS_DIR)) return;
  for (const file of readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'))) {
    try {
      const task = JSON.parse(readFileSync(path.join(TASKS_DIR, file), 'utf8'));
      tasks.set(task.id, task);
      const num = parseInt(task.id.replace('task_', ''));
      if (num >= taskCounter) taskCounter = num + 1;
    } catch (err) {
      console.error(`task-queue: failed to load ${file}: ${err.message}`);
    }
  }
}
loadTasks();

function saveTask(task) {
  writeFileSync(path.join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2));
}

function submitTask({ name, prompt, target, priority = 'normal', model, depends_on = [] }) {
  const id = `task_${++taskCounter}`;
  const task = {
    id, name: name || `Task ${taskCounter}`, prompt,
    target: target || model || 'auto',
    priority, depends_on,
    status: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: null, completed_at: null,
    result: null, error: null
  };
  tasks.set(id, task);
  saveTask(task);
  return task;
}

function getTaskStatus(taskId) {
  if (taskId) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }
  return [...tasks.values()].map(t => ({
    id: t.id, name: t.name, status: t.status,
    target: t.target, priority: t.priority, created_at: t.created_at
  }));
}

export function listTasks(statusFilter) {
  let taskList = [...tasks.values()];
  if (statusFilter) taskList = taskList.filter(t => t.status === statusFilter);
  return taskList.sort((a, b) => {
    const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
    const pa = priorityOrder[a.priority] ?? 2;
    const pb = priorityOrder[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    return new Date(a.created_at) - new Date(b.created_at);
  });
}

function cancelTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status === 'completed' || task.status === 'cancelled')
    throw new Error(`Cannot cancel task in ${task.status} state`);
  task.status = 'cancelled';
  task.updated_at = new Date().toISOString();
  saveTask(task);
  return task;
}

export function updateTask(taskId, updates) {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  Object.assign(task, updates, { updated_at: new Date().toISOString() });
  saveTask(task);
  return task;
}

export function areDependenciesMet(taskId) {
  const task = tasks.get(taskId);
  if (!task || !task.depends_on.length) return true;
  return task.depends_on.every(depId => {
    const dep = tasks.get(depId);
    return dep && dep.status === 'completed';
  });
}

// Clear all tasks (for test isolation)
export function clearAllTasks() {
  for (const [id] of tasks) {
    const filePath = path.join(TASKS_DIR, `${id}.json`);
    try { unlinkSync(filePath); } catch {}
  }
  tasks.clear();
  taskCounter = 0;
}

// MCP Tool Definitions
const TASK_TOOLS = [
  { name: 'task_submit', description: 'Submit a new task to the queue.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string' }, prompt: { type: 'string' },
      target: { type: 'string' }, priority: { type: 'string', enum: ['low','normal','high','critical'] },
      depends_on: { type: 'array', items: { type: 'string' } }
    }, required: ['prompt'] }
  },
  { name: 'task_status', description: 'Get status of a specific task or all tasks.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } } }
  },
  { name: 'task_list', description: 'List tasks with optional status filter.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['pending','active','completed','failed','cancelled'] } } }
  },
  { name: 'task_cancel', description: 'Cancel a pending or active task.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
  }
];

export function getTaskToolDefinitions() { return TASK_TOOLS; }

export async function handleTaskToolCall(name, args, _browserService) {
  switch (name) {
    case 'task_submit': {
      const task = submitTask(args);
      return { content: [{ type: 'text', text: `Task created: ${task.id} (${task.name})\nStatus: ${task.status}\nTarget: ${task.target}` }] };
    }
    case 'task_status': return { content: [{ type: 'text', text: JSON.stringify(getTaskStatus(args.task_id), null, 2) }] };
    case 'task_list': {
      const list = listTasks(args.status);
      if (!list.length) return { content: [{ type: 'text', text: 'No tasks found.' }] };
      let text = `Tasks (${list.length}):\n\n`;
      for (const t of list) text += `[${t.id}] ${t.name} — ${t.status} (${t.priority}, target: ${t.target})\n`;
      return { content: [{ type: 'text', text }] };
    }
    case 'task_cancel': return { content: [{ type: 'text', text: `Task ${cancelTask(args.task_id).id} cancelled.` }] };
    default: throw new Error(`Unknown task tool: ${name}`);
  }
}

export const TASK_TOOL_NAMES = new Set(TASK_TOOLS.map(t => t.name));

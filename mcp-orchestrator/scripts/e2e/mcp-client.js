// scripts/e2e/mcp-client.js — Minimal JSON-RPC 2.0 stdio client for e2e tests.
// Spawns `node server.js` with STATE_FILE always redirected into .state/ so
// tests can never touch a real consensus_state.json.
import { spawn } from 'child_process';
import { createWriteStream, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, '../../server.js');
export const STATE_DIR = join(__dirname, '.state');

export class McpClient {
  #child;
  #buffer = '';
  #pending = new Map();
  #nextId = 1;
  #stderrLog;

  /**
   * @param {object} opts
   * @param {string} opts.testName — names the state file and stderr log
   * @param {object} [opts.env] — extra env for the server (e.g. TIMEOUT_RESPONSE)
   * @param {number} [opts.timeoutMs] — default per-request timeout
   */
  constructor({ testName, env = {}, timeoutMs = 30000 }) {
    if (!testName) throw new Error('McpClient requires a testName');
    this.testName = testName;
    this.timeoutMs = timeoutMs;
    mkdirSync(STATE_DIR, { recursive: true });
    this.stateFile = join(STATE_DIR, `${testName}.json`);
    this.stderrLogPath = join(STATE_DIR, `${testName}.stderr.log`);
    this.#stderrLog = createWriteStream(this.stderrLogPath, { flags: 'a' });

    this.#child = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, STATE_FILE: this.stateFile, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // No-op error handlers: a dying child must fail gates via timeouts, never
    // crash the whole harness with an unhandled stream 'error'.
    this.#stderrLog.on('error', () => {});
    this.#child.stdin.on('error', () => {});
    this.#child.stdout.on('data', (d) => this.#onData(d));
    this.#child.stderr.on('data', (d) => {
      if (!this.#stderrLog.writableEnded) this.#stderrLog.write(d);
    });
    this.#child.on('exit', (code, signal) => {
      this.#stderrLog.end();
      const err = new Error(`server exited (code=${code} signal=${signal})`);
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.#pending.clear();
    });
  }

  get pid() {
    return this.#child.pid;
  }

  #onData(chunk) {
    this.#buffer += chunk.toString();
    let idx;
    while ((idx = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, idx).trim();
      this.#buffer = this.#buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON stdout noise would corrupt the protocol; skip defensively
      }
      if (msg.id != null && this.#pending.has(msg.id)) {
        const p = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
    }
  }

  #send(obj) {
    if (this.#child.stdin.destroyed) return; // pending timer will reject
    try {
      this.#child.stdin.write(JSON.stringify(obj) + '\n');
    } catch {
      // EPIPE on a dying child — pending timer will reject
    }
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = this.#nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rej(new Error(`timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: res, reject: rej, timer });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'auto-browser-e2e', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return result;
  }

  async listTools() {
    return (await this.request('tools/list')).tools;
  }

  /** Returns the raw CallToolResult: { content: [...], isError? } */
  async callTool(name, args = {}, timeoutMs) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }

  /** Convenience: first text block of a tool result. */
  static text(result) {
    return result?.content?.[0]?.text ?? '';
  }

  async close() {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    this.#child.kill('SIGTERM');
    const exited = await new Promise((res) => {
      const t = setTimeout(() => res(false), 2000);
      this.#child.once('exit', () => {
        clearTimeout(t);
        res(true);
      });
    });
    if (!exited) this.#child.kill('SIGKILL');
  }
}

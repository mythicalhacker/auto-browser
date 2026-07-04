/**
 * ConsensusBarrier — per-round result collector with failure quarantine.
 *
 * The real synchronization barrier is the pair of Promise.all blocks in
 * runConsensusRound; this class dedups marks (first mark wins), reports
 * progress, and keeps failures OUT of outputs: a failed model's error lives
 * exclusively in the errors map, so error text can never be cross-pollinated
 * to peers or rendered as an answer.
 */

export class ConsensusBarrier {
  constructor(models) {
    this.models = models;
    this.completed = new Map();
    this.failed = new Map();
    this.startTime = Date.now();
  }

  markComplete(model, output) {
    if (this.completed.has(model) || this.failed.has(model)) {
      console.error(`Barrier: ${model} already marked, ignoring duplicate`);
      return;
    }
    this.completed.set(model, {
      output,
      timestamp: Date.now(),
      duration: Date.now() - this.startTime
    });
    console.error(`Barrier: ${model} completed (${this.completed.size}/${this.models.length})`);
  }

  markFailed(model, error, phase = 'unknown') {
    if (this.completed.has(model) || this.failed.has(model)) {
      console.error(`Barrier: ${model} already marked, ignoring duplicate`);
      return;
    }
    this.failed.set(model, {
      error,
      phase,
      timestamp: Date.now(),
      duration: Date.now() - this.startTime
    });
    console.error(`Barrier: ${model} failed during ${phase} - ${error}`);
  }

  isComplete() {
    return this.completed.size + this.failed.size >= this.models.length;
  }

  getPendingModels() {
    return this.models.filter(m =>
      !this.completed.has(m) && !this.failed.has(m)
    );
  }

  getStatus() {
    return {
      completed: this.completed.size,
      failed: this.failed.size,
      pending: this.getPendingModels().length,
      total: this.models.length,
      elapsed: Date.now() - this.startTime
    };
  }

  /**
   * outputs: successful models only — never contains error text.
   * errors:  { model: { message, phase } } for failed models only.
   * timing:  everyone, success or failure (feeds latency stats).
   */
  getResults() {
    const outputs = {};
    const timing = {};
    const errors = {};

    for (const [model, data] of this.completed) {
      outputs[model] = data.output;
      timing[model] = data.duration;
    }

    for (const [model, data] of this.failed) {
      errors[model] = { message: data.error, phase: data.phase };
      timing[model] = data.duration;
    }

    return { outputs, timing, errors };
  }
}

/**
 * Sleep utility
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry utility with exponential backoff
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    onRetry = null
  } = options;

  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;

      if (i < maxRetries - 1) {
        const delay = Math.min(initialDelay * Math.pow(2, i), maxDelay);
        if (onRetry) onRetry(i + 1, delay, e);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

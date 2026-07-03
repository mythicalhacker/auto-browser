/**
 * ConsensusBarrier
 * Ensures all models complete before proceeding to next round
 */

export class ConsensusBarrier {
  constructor(models, timeout = 120000) {
    this.models = models;
    this.timeout = timeout;
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
  
  markFailed(model, error) {
    if (this.completed.has(model) || this.failed.has(model)) {
      console.error(`Barrier: ${model} already marked, ignoring duplicate`);
      return;
    }
    this.failed.set(model, { 
      error, 
      timestamp: Date.now(),
      duration: Date.now() - this.startTime
    });
    console.error(`Barrier: ${model} failed - ${error}`);
  }
  
  isComplete() {
    const total = this.completed.size + this.failed.size;
    return total >= this.models.length;
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
  
  async waitForAll() {
    while (!this.isComplete()) {
      if (Date.now() - this.startTime > this.timeout) {
        const pending = this.getPendingModels();
        throw new Error(`Barrier timeout after ${this.timeout}ms. Pending: ${pending.join(', ')}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    
    return {
      completed: Object.fromEntries(this.completed),
      failed: Object.fromEntries(this.failed),
      totalTime: Date.now() - this.startTime
    };
  }
  
  getResults() {
    const outputs = {};
    const timing = {};
    const errors = {};
    
    for (const [model, data] of this.completed) {
      outputs[model] = data.output;
      timing[model] = data.duration;
    }
    
    for (const [model, data] of this.failed) {
      outputs[model] = `Error: ${data.error}`;
      errors[model] = data.error;
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

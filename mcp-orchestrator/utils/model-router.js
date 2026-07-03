// utils/model-router.js — Model Routing Engine
// Recommends the optimal model(s) for a task based on type, complexity, context size, and keywords.

const LARGE_CONTEXT_THRESHOLD = 200000;

const EXPLICIT_ROUTES = {
  consensus: { model: 'all', mode: 'standard', rationale: 'Consensus tasks require all models' },
  research:  { model: 'gemini', mode: 'deep_research', rationale: 'Research tasks benefit from Gemini deep research' },
  analysis:  { model: 'gemini', mode: 'deep_research', rationale: 'Analysis tasks benefit from Gemini deep research' },
  code:      { model: 'chatgpt', mode: 'o1', rationale: 'Code tasks benefit from ChatGPT o1 reasoning' },
  creative:  { model: 'claude', mode: 'standard', rationale: 'Creative tasks benefit from Claude' },
  review:    { model: 'claude', mode: 'opus', rationale: 'Final review tasks route to Claude opus' },
  synthesis: { model: 'claude', mode: 'opus', rationale: 'Synthesis tasks route to Claude opus' },
};

const CONSENSUS_KEYWORDS = ['consensus', 'agree', 'all models', 'compare models', 'cross-model'];
const FINAL_REVIEW_KEYWORDS = ['final review', 'final synthesis', 'final pass', 'polish', 'wrap up'];
const RESEARCH_KEYWORDS = [
  'research', 'analyze', 'analysis', 'investigate', 'survey', 'literature',
  'multi-source', 'cross-reference', 'meta-analysis', 'multi-source synthesis',
];
const CODE_KEYWORDS = ['code', 'bug', 'debug', 'implement', 'refactor', 'fix'];

const TOKEN_REGEX = /(\d+(\.\d+)?)\s*(k|m)?\s*tokens?/gi;

function extractTokenCount(description) {
  if (!description) return null;
  let maxTokens = null;
  let match;
  while ((match = TOKEN_REGEX.exec(description)) !== null) {
    let value = parseFloat(match[1]);
    const suffix = (match[3] || '').toLowerCase();
    if (suffix === 'k') value *= 1e3;
    else if (suffix === 'm') value *= 1e6;
    if (maxTokens === null || value > maxTokens) {
      maxTokens = value;
    }
  }
  // Reset regex lastIndex for next call
  TOKEN_REGEX.lastIndex = 0;
  return maxTokens;
}

function getAlternatives(primaryModel) {
  if (primaryModel === 'all') return [];
  const allModels = ['claude', 'chatgpt', 'gemini'];
  return allModels.filter(m => m !== primaryModel);
}

function matchesKeywords(description, keywords) {
  if (!description) return false;
  const lower = description.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

export function routeTask({ description, type, complexity, contextSize } = {}) {
  // Normalize inputs
  const normalizedType = typeof type === 'string' ? type.toLowerCase().trim() : null;
  const normalizedComplexity = typeof complexity === 'string' ? complexity.toLowerCase().trim() : null;
  const numericContextSize = Number.isFinite(contextSize) ? contextSize : 0;

  // Compute effective context tokens
  const parsedTokens = extractTokenCount(description) || 0;
  const effectiveContextTokens = Math.max(parsedTokens, numericContextSize);

  // Priority 1: Large context override (beats everything including explicit type)
  if (effectiveContextTokens > LARGE_CONTEXT_THRESHOLD) {
    const result = { model: 'gemini', mode: 'standard', rationale: `Large context (${effectiveContextTokens.toLocaleString()} tokens) requires Gemini for its extended context window` };
    result.alternatives = getAlternatives(result.model);
    return result;
  }

  // Priority 2: Explicit type routing
  if (normalizedType && EXPLICIT_ROUTES[normalizedType]) {
    const route = { ...EXPLICIT_ROUTES[normalizedType] };
    route.alternatives = getAlternatives(route.model);
    return route;
  }

  // Priority 3: Keyword-based routing (in order)
  if (matchesKeywords(description, CONSENSUS_KEYWORDS)) {
    return { model: 'all', mode: 'standard', rationale: 'Consensus keywords detected in description', alternatives: [] };
  }

  if (matchesKeywords(description, FINAL_REVIEW_KEYWORDS)) {
    const result = { model: 'claude', mode: 'opus', rationale: 'Final review/synthesis keywords detected — routing to Claude opus' };
    result.alternatives = getAlternatives(result.model);
    return result;
  }

  if (matchesKeywords(description, RESEARCH_KEYWORDS)) {
    const result = { model: 'gemini', mode: 'deep_research', rationale: 'Research/analysis keywords detected in description' };
    result.alternatives = getAlternatives(result.model);
    return result;
  }

  if (matchesKeywords(description, CODE_KEYWORDS)) {
    const result = { model: 'chatgpt', mode: 'o1', rationale: 'Code/bugfix keywords detected in description' };
    result.alternatives = getAlternatives(result.model);
    return result;
  }

  // Priority 4: High complexity
  if (normalizedComplexity === 'high') {
    const result = { model: 'chatgpt', mode: 'o1', rationale: 'High complexity task benefits from ChatGPT o1 reasoning' };
    result.alternatives = getAlternatives(result.model);
    return result;
  }

  // Priority 5: Default
  const result = { model: 'claude', mode: 'standard', rationale: 'Default routing to Claude standard' };
  result.alternatives = getAlternatives(result.model);
  return result;
}

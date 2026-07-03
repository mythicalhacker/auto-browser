// utils/context-compression.js - Compress responses for efficient cross-pollination

/**
 * Smart truncation: keeps first portion + last portion, summarizes middle.
 * Preserves the introduction (context-setting) and conclusion (recommendations/decisions)
 * while condensing the detailed middle section.
 *
 * @param {string} text - Full response text
 * @param {number} maxLength - Maximum character length (default: 2000)
 * @param {Object} [options]
 * @param {number} [options.headRatio=0.3] - Fraction of maxLength for the beginning
 * @param {number} [options.tailRatio=0.3] - Fraction of maxLength for the end
 * @returns {string} Compressed text
 */
export function smartTruncate(text, maxLength = 2000, options = {}) {
  if (!text || text.length <= maxLength) return text;

  const { headRatio = 0.3, tailRatio = 0.3 } = options;
  const headLen = Math.floor(maxLength * headRatio);
  const tailLen = Math.floor(maxLength * tailRatio);
  const midBudget = maxLength - headLen - tailLen - 50; // 50 chars for separator

  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);
  const middle = text.slice(headLen, -tailLen);

  // Try to break at sentence boundaries
  const headClean = breakAtSentence(head, 'end');
  const tailClean = breakAtSentence(tail, 'start');

  // Summarize middle section stats
  const middleLines = middle.split('\n').filter(l => l.trim()).length;
  const middleSummary = `\n\n[... ${middleLines} lines condensed (${middle.length} chars) ...]\n\n`;

  return headClean + middleSummary + tailClean;
}

/**
 * Compress a set of model responses for cross-pollination.
 * Applies smart truncation to each response.
 *
 * @param {Object} responses - { claude: "...", chatgpt: "...", gemini: "..." }
 * @param {string} excludeModel - Model to exclude (cross-pollination)
 * @param {number} maxPerModel - Max chars per model response (default: 2000)
 * @returns {Object} Compressed responses { model: compressedText }
 */
export function compressForCrossPollination(responses, excludeModel, maxPerModel = 2000) {
  const compressed = {};

  for (const [model, response] of Object.entries(responses)) {
    if (model === excludeModel) continue;
    if (!response || typeof response !== 'string') {
      compressed[model] = response || 'No response';
      continue;
    }
    compressed[model] = smartTruncate(response, maxPerModel);
  }

  return compressed;
}

/**
 * For structured data (lists, tables), convert to a compact single-line format
 * before including in cross-pollination prompts.
 *
 * @param {string} text - Text that may contain markdown lists or tables
 * @returns {string} Compacted text
 */
export function compactStructuredContent(text) {
  if (!text) return text;

  let result = text;

  // Compact markdown bullet lists: convert multi-line to inline
  result = result.replace(
    /(?:^|\n)((?:[-*]\s+.+\n?){3,})/gm,
    (match, listBlock) => {
      const items = listBlock.split('\n')
        .map(l => l.replace(/^[-*]\s+/, '').trim())
        .filter(Boolean);
      return '\nItems: ' + items.join(' | ') + '\n';
    }
  );

  // Remove excessive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}

/**
 * Break text at sentence boundary.
 * @param {string} text
 * @param {'start'|'end'} direction - 'end' finds last sentence end, 'start' finds first sentence start
 * @returns {string}
 */
function breakAtSentence(text, direction) {
  if (direction === 'end') {
    const match = text.match(/^([\s\S]*[.!?])\s/);
    return match ? match[1] : text;
  } else {
    const match = text.match(/[.!?]\s+([A-Z][\s\S]*$)/);
    return match ? match[1] : text;
  }
}

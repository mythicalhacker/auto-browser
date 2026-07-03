// tools/browser.js — Browser automation tools (Tier 1 + Tier 2)
import { CONFIG, PATTERNS } from "../config.js";

const MAX_TEXT_LENGTH = 50000;

const BROWSER_TOOLS = [
  {
    name: "browser_navigate",
    description: "Navigate a browser tab to a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        tab_index: { type: "number", default: 0, description: "Tab index (use browser_tabs to list)" }
      },
      required: ["url"]
    }
  },
  {
    name: "browser_back",
    description: "Go back in browser history",
    inputSchema: {
      type: "object",
      properties: {
        tab_index: { type: "number", default: 0, description: "Tab index" }
      }
    }
  },
  {
    name: "browser_forward",
    description: "Go forward in browser history",
    inputSchema: {
      type: "object",
      properties: {
        tab_index: { type: "number", default: 0, description: "Tab index" }
      }
    }
  },
  {
    name: "browser_tabs",
    description: "List all open browser tabs with their URLs and titles",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "browser_new_tab",
    description: "Open a new browser tab, optionally navigating to a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open (default: blank)" }
      }
    }
  },
  {
    name: "browser_close_tab",
    description: "Close a browser tab by index",
    inputSchema: {
      type: "object",
      properties: {
        tab_index: { type: "number", default: 0, description: "Tab index to close" }
      },
      required: ["tab_index"]
    }
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of a browser tab (viewport by default)",
    inputSchema: {
      type: "object",
      properties: {
        tab_index: { type: "number", default: 0, description: "Tab index" },
        full_page: { type: "boolean", default: false, description: "Capture full page instead of viewport" }
      }
    }
  },
  {
    name: "browser_get_text",
    description: "Extract visible text content from a browser tab. Filters out scripts and styles. Truncates at ~50k characters.",
    inputSchema: {
      type: "object",
      properties: {
        tab_index: { type: "number", default: 0, description: "Tab index" },
        selector: { type: "string", description: "CSS selector to extract text from (default: body)" }
      }
    }
  },
  {
    name: "browser_click",
    description: "Click an element on the page by CSS selector",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of element to click" },
        tab_index: { type: "number", default: 0, description: "Tab index" }
      },
      required: ["selector"]
    }
  },
  {
    name: "browser_type",
    description: "Type text into a focused element or a specified selector using clipboard paste. Optionally submit with Enter.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type" },
        selector: { type: "string", description: "CSS selector to focus before typing" },
        tab_index: { type: "number", default: 0, description: "Tab index" },
        submit: { type: "boolean", default: false, description: "Press Enter after typing" }
      },
      required: ["text"]
    }
  },
  // --- Tier 2: Advanced Browser Tools ---
  {
    name: "browser_snapshot",
    description: "Returns an accessibility tree snapshot of the page with [ref=eN] markers for each element. Useful for understanding page structure without screenshots.",
    inputSchema: {
      type: "object",
      properties: {
        tab_index: { type: "number", default: 0, description: "Tab index" },
        selector: { type: "string", description: "CSS selector to scope the snapshot to a subtree" },
        max_depth: { type: "number", default: 10, description: "Maximum tree depth to traverse" }
      }
    }
  },
  {
    name: "browser_hover",
    description: "Hover over an element by CSS selector. Useful for triggering dropdowns, tooltips, and hover states.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of element to hover" },
        tab_index: { type: "number", default: 0, description: "Tab index" }
      },
      required: ["selector"]
    }
  },
  {
    name: "browser_select",
    description: "Select option(s) from a <select> dropdown by value. Supports multi-select.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the <select> element" },
        values: {
          type: "array",
          items: { type: "string" },
          description: "Array of option values to select"
        },
        tab_index: { type: "number", default: 0, description: "Tab index" }
      },
      required: ["selector", "values"]
    }
  },
  {
    name: "browser_press_key",
    description: "Press a key or key combination (e.g. 'Enter', 'Escape', 'Tab', 'Control+a'). Uses Playwright key names.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key or key combination to press (e.g. 'Enter', 'Escape', 'Control+a')" },
        tab_index: { type: "number", default: 0, description: "Tab index" }
      },
      required: ["key"]
    }
  },
  {
    name: "browser_get_html",
    description: "Get raw HTML content from the page or a specific element. Optionally strip script and style tags.",
    inputSchema: {
      type: "object",
      properties: {
        tab_index: { type: "number", default: 0, description: "Tab index" },
        selector: { type: "string", description: "CSS selector to get HTML from (default: body)" },
        clean: { type: "boolean", default: false, description: "Strip <script>, <style>, and <noscript> tags" }
      }
    }
  },
  {
    name: "browser_evaluate",
    description: "Execute arbitrary JavaScript in the page context and return the result.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript code to execute in the page" },
        tab_index: { type: "number", default: 0, description: "Tab index" }
      },
      required: ["script"]
    }
  },
  {
    name: "browser_wait",
    description: "Wait for a condition: 'selector' (element appears), 'navigation' (page navigates), 'networkidle' (no network activity), or 'timeout' (fixed delay in ms).",
    inputSchema: {
      type: "object",
      properties: {
        condition: {
          type: "string",
          enum: ["selector", "navigation", "networkidle", "timeout"],
          description: "What to wait for"
        },
        value: { type: ["string", "number"], description: "CSS selector (for 'selector'), or milliseconds (for 'timeout'). Not used for 'navigation'/'networkidle'." },
        tab_index: { type: "number", default: 0, description: "Tab index" },
        timeout: { type: "number", default: 30000, description: "Maximum wait time in ms" }
      },
      required: ["condition"]
    }
  },
  {
    name: "browser_file_upload",
    description: "Upload file(s) to a file input element using page.setInputFiles().",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the <input type='file'> element" },
        file_paths: {
          type: "array",
          items: { type: "string" },
          description: "Array of absolute file paths to upload"
        },
        tab_index: { type: "number", default: 0, description: "Tab index" }
      },
      required: ["selector", "file_paths"]
    }
  }
];

export const BROWSER_TOOL_NAMES = new Set(BROWSER_TOOLS.map(t => t.name));

export function getBrowserToolDefinitions() {
  return BROWSER_TOOLS;
}

async function getTab(browserService, tabIndex = 0) {
  await browserService.connect();
  const page = browserService.getPageByIndex(tabIndex);
  if (!page) {
    const all = browserService.getAllPages();
    throw new Error(`Tab index ${tabIndex} out of range (${all.length} tabs open). Use browser_tabs to list.`);
  }
  return page;
}

function isModelTab(url) {
  for (const [model, pattern] of Object.entries(PATTERNS)) {
    if (url.includes(pattern)) return model;
  }
  return null;
}

async function takeSnapshot(page, selector, maxDepth = 10) {
  let root = null;
  if (selector) {
    const el = await page.$(selector);
    if (el) root = await el.elementHandle();
  }

  const snapshot = await page.accessibility.snapshot({ root: root || undefined });
  if (!snapshot) return 'No accessibility tree available';

  let refCounter = 0;
  function formatNode(node, depth = 0) {
    if (depth > maxDepth) return '';
    const ref = `e${++refCounter}`;
    const indent = '  '.repeat(depth);
    let line = `${indent}[ref=${ref}] ${node.role}`;
    if (node.name) line += ` "${node.name}"`;
    if (node.value) line += ` value="${node.value}"`;
    if (node.checked !== undefined) line += ` checked=${node.checked}`;
    if (node.level) line += ` level=${node.level}`;
    let result = line + '\n';
    if (node.children) {
      for (const child of node.children) result += formatNode(child, depth + 1);
    }
    return result;
  }

  return formatNode(snapshot);
}

export async function handleBrowserToolCall(name, args, browserService) {
  if (!BROWSER_TOOL_NAMES.has(name)) return null;

  switch (name) {
    case "browser_navigate": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      await page.goto(args.url, { timeout: CONFIG.timeouts.navigation, waitUntil: 'domcontentloaded' });
      return { content: [{ type: "text", text: `Navigated to ${args.url}\nTitle: ${await page.title()}` }] };
    }

    case "browser_back": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      const response = await page.goBack({ timeout: CONFIG.timeouts.navigation }).catch(() => null);
      if (!response) {
        return { content: [{ type: "text", text: "No previous page in history" }] };
      }
      return { content: [{ type: "text", text: `Went back to: ${page.url()}\nTitle: ${await page.title()}` }] };
    }

    case "browser_forward": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      const response = await page.goForward({ timeout: CONFIG.timeouts.navigation }).catch(() => null);
      if (!response) {
        return { content: [{ type: "text", text: "No next page in history" }] };
      }
      return { content: [{ type: "text", text: `Went forward to: ${page.url()}\nTitle: ${await page.title()}` }] };
    }

    case "browser_tabs": {
      await browserService.connect();
      const pages = browserService.getAllPages();
      if (pages.length === 0) {
        return { content: [{ type: "text", text: "No tabs found" }] };
      }
      let text = `${pages.length} tab(s):\n`;
      for (let i = 0; i < pages.length; i++) {
        const title = await pages[i].title().catch(() => '(untitled)');
        text += `  [${i}] ${title}\n      ${pages[i].url()}\n`;
      }
      return { content: [{ type: "text", text }] };
    }

    case "browser_new_tab": {
      await browserService.connect();
      const allPages = browserService.getAllPages();
      if (allPages.length === 0) {
        throw new Error("No browser context available. Connect to Chrome first.");
      }
      const context = allPages[0].context();
      const newPage = await context.newPage();
      if (args.url) {
        await newPage.goto(args.url, { timeout: CONFIG.timeouts.navigation, waitUntil: 'domcontentloaded' });
      }
      const pages = browserService.getAllPages();
      const newIndex = pages.indexOf(newPage);
      return { content: [{ type: "text", text: `New tab opened at index ${newIndex}${args.url ? `\nNavigated to: ${args.url}` : ''}` }] };
    }

    case "browser_close_tab": {
      const tabIndex = args.tab_index ?? 0;
      const page = await getTab(browserService, tabIndex);
      const url = page.url();
      const model = isModelTab(url);
      await page.close();
      let text = `Closed tab ${tabIndex} (${url})`;
      if (model) {
        text += `\n\nWARNING: This was a ${model} model tab. Consensus tools may not work correctly until you reopen it.`;
      }
      return { content: [{ type: "text", text }] };
    }

    case "browser_screenshot": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      const buffer = await page.screenshot({
        fullPage: args.full_page ?? false,
        type: 'png'
      });
      const base64 = buffer.toString('base64');
      return {
        content: [
          { type: "text", text: `Screenshot of tab ${args.tab_index ?? 0}: ${page.url()}` },
          { type: "image", data: base64, mimeType: "image/png" }
        ]
      };
    }

    case "browser_get_text": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      const selector = args.selector || 'body';
      const text = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        // Remove script and style elements from the clone
        const clone = el.cloneNode(true);
        clone.querySelectorAll('script, style, noscript').forEach(e => e.remove());
        return clone.innerText;
      }, selector);
      if (text === null) {
        return { content: [{ type: "text", text: `No element found for selector: ${selector}` }] };
      }
      const trimmed = text.trim();
      const truncated = trimmed.length > MAX_TEXT_LENGTH
        ? trimmed.substring(0, MAX_TEXT_LENGTH) + `\n\n[Truncated: ${trimmed.length} chars total, showing first ${MAX_TEXT_LENGTH}]`
        : trimmed;
      return { content: [{ type: "text", text: truncated || "(empty page)" }] };
    }

    case "browser_click": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      await page.click(args.selector, { timeout: CONFIG.timeouts.action });
      return { content: [{ type: "text", text: `Clicked: ${args.selector}` }] };
    }

    case "browser_type": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      if (args.selector) {
        await page.click(args.selector, { timeout: CONFIG.timeouts.action });
        await page.waitForTimeout(CONFIG.timeouts.microDelay);
      }
      // Use clipboard paste (not page.type) for performance
      await page.evaluate(async (text) => {
        await navigator.clipboard.writeText(text);
      }, args.text);
      await page.keyboard.press("Control+v");
      if (args.submit) {
        await page.waitForTimeout(CONFIG.timeouts.microDelay);
        await page.keyboard.press("Enter");
      }
      return { content: [{ type: "text", text: `Typed ${args.text.length} chars${args.submit ? ' and pressed Enter' : ''}` }] };
    }

    // --- Tier 2: Advanced Browser Tools ---

    case "browser_snapshot": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      const tree = await takeSnapshot(page, args.selector, args.max_depth ?? 10);
      const truncated = tree.length > MAX_TEXT_LENGTH
        ? tree.substring(0, MAX_TEXT_LENGTH) + `\n\n[Truncated: ${tree.length} chars total, showing first ${MAX_TEXT_LENGTH}]`
        : tree;
      return { content: [{ type: "text", text: truncated }] };
    }

    case "browser_hover": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      await page.hover(args.selector, { timeout: CONFIG.timeouts.action });
      return { content: [{ type: "text", text: `Hovered: ${args.selector}` }] };
    }

    case "browser_select": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      const selected = await page.selectOption(args.selector, args.values, { timeout: CONFIG.timeouts.action });
      return { content: [{ type: "text", text: `Selected ${selected.length} option(s) in ${args.selector}: ${selected.join(', ')}` }] };
    }

    case "browser_press_key": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      await page.keyboard.press(args.key);
      return { content: [{ type: "text", text: `Pressed key: ${args.key}` }] };
    }

    case "browser_get_html": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      const selector = args.selector || 'body';
      const clean = args.clean ?? false;
      const html = await page.evaluate(({ sel, clean }) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        if (!clean) return el.outerHTML;
        const clone = el.cloneNode(true);
        clone.querySelectorAll('script, style, noscript').forEach(e => e.remove());
        return clone.outerHTML;
      }, { sel: selector, clean });
      if (html === null) {
        return { content: [{ type: "text", text: `No element found for selector: ${selector}` }] };
      }
      const truncated = html.length > MAX_TEXT_LENGTH
        ? html.substring(0, MAX_TEXT_LENGTH) + `\n\n[Truncated: ${html.length} chars total, showing first ${MAX_TEXT_LENGTH}]`
        : html;
      return { content: [{ type: "text", text: truncated }] };
    }

    case "browser_evaluate": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      const result = await page.evaluate(args.script);
      const output = result === undefined ? 'undefined' : JSON.stringify(result, null, 2);
      const truncated = output.length > MAX_TEXT_LENGTH
        ? output.substring(0, MAX_TEXT_LENGTH) + `\n\n[Truncated: ${output.length} chars total, showing first ${MAX_TEXT_LENGTH}]`
        : output;
      return { content: [{ type: "text", text: truncated }] };
    }

    case "browser_wait": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      const timeout = args.timeout ?? 30000;
      switch (args.condition) {
        case 'selector':
          if (!args.value) throw new Error("'value' is required for condition 'selector' (provide a CSS selector)");
          await page.waitForSelector(String(args.value), { timeout });
          return { content: [{ type: "text", text: `Element appeared: ${args.value}` }] };
        case 'navigation':
          await page.waitForNavigation({ timeout });
          return { content: [{ type: "text", text: `Navigation completed. URL: ${page.url()}` }] };
        case 'networkidle':
          await page.waitForLoadState('networkidle', { timeout });
          return { content: [{ type: "text", text: `Network idle reached` }] };
        case 'timeout': {
          const ms = Number(args.value) || 1000;
          await page.waitForTimeout(ms);
          return { content: [{ type: "text", text: `Waited ${ms}ms` }] };
        }
        default:
          throw new Error(`Unknown wait condition: ${args.condition}. Use 'selector', 'navigation', 'networkidle', or 'timeout'.`);
      }
    }

    case "browser_file_upload": {
      const page = await getTab(browserService, args.tab_index ?? 0);
      const input = await page.waitForSelector(args.selector, { timeout: CONFIG.timeouts.action });
      await input.setInputFiles(args.file_paths);
      return { content: [{ type: "text", text: `Uploaded ${args.file_paths.length} file(s) to ${args.selector}` }] };
    }

    default:
      return null;
  }
}

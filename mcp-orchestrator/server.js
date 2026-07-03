import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { browserService } from './services/browser-service.js';
import { getConsensusToolDefinitions, handleConsensusToolCall, CONSENSUS_TOOL_NAMES, initConsensusState } from './tools/consensus.js';
import { getBrowserToolDefinitions, handleBrowserToolCall, BROWSER_TOOL_NAMES } from './tools/browser.js';
import { getTaskToolDefinitions, handleTaskToolCall, TASK_TOOL_NAMES } from './tools/task-queue.js';
import { getDispatchToolDefinitions, handleDispatchToolCall, DISPATCH_TOOL_NAMES } from './services/dispatcher.js';

const server = new Server(
  { name: "mcp-orchestrator", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

// Combined tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...getConsensusToolDefinitions(), ...getBrowserToolDefinitions(), ...getTaskToolDefinitions(), ...getDispatchToolDefinitions()]
}));

// Combined tool dispatch
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (CONSENSUS_TOOL_NAMES.has(name)) {
      return await handleConsensusToolCall(name, args, browserService);
    }
    if (BROWSER_TOOL_NAMES.has(name)) {
      return await handleBrowserToolCall(name, args, browserService);
    }
    if (TASK_TOOL_NAMES.has(name)) {
      return await handleTaskToolCall(name, args, browserService);
    }
    if (DISPATCH_TOOL_NAMES.has(name)) {
      return await handleDispatchToolCall(name, args, browserService);
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }] };
  }
});

// Load persisted consensus state on startup
initConsensusState();

const transport = new StdioServerTransport();

async function cleanup() {
  await browserService.disconnect();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

await server.connect(transport);

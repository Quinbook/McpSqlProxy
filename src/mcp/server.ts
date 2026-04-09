import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import * as path from 'path';

const WS_PORT = 52345;

interface PendingQuery {
  id: string;
  query: string;
  description?: string;
  resolve: (result: any) => void;
  reject: (error: any) => void;
}

const pendingQueries = new Map<string, PendingQuery>();
let electronClient: WebSocket | null = null;
let electronProcess: ReturnType<typeof spawn> | null = null;
let queryCounter = 0;

// --- WebSocket Server (Bridge to Electron UI) ---
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws) => {
  electronClient = ws;
  process.stderr.write('[MCP] Electron UI connected\n');

  // Send any pending queries that arrived before UI connected
  for (const [id, pq] of pendingQueries) {
    ws.send(JSON.stringify({ type: 'query', id, query: pq.query, description: pq.description }));
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'result') {
        const pending = pendingQueries.get(msg.id);
        if (pending) {
          pendingQueries.delete(msg.id);
          pending.resolve(msg.data);
        }
      } else if (msg.type === 'error') {
        const pending = pendingQueries.get(msg.id);
        if (pending) {
          pendingQueries.delete(msg.id);
          pending.reject(new Error(msg.error));
        }
      } else if (msg.type === 'rejected') {
        const pending = pendingQueries.get(msg.id);
        if (pending) {
          pendingQueries.delete(msg.id);
          pending.resolve({ rejected: true, reason: msg.reason || 'Query rejected by user' });
        }
      }
    } catch (e) {
      process.stderr.write(`[MCP] Failed to parse message: ${e}\n`);
    }
  });

  ws.on('close', () => {
    electronClient = null;
    process.stderr.write('[MCP] Electron UI disconnected\n');
  });
});

// --- Launch Electron ---
function launchElectron() {
  if (electronProcess) return;

  // On Windows, use the electron.exe directly from the dist folder
  const electronPath = path.join(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  const mainPath = path.join(__dirname, '..', 'electron', 'main.js');

  process.stderr.write(`[MCP] Launching Electron: ${electronPath} ${mainPath}\n`);

  electronProcess = spawn(electronPath, [mainPath], {
    stdio: 'ignore',
    detached: false,
    env: { ...process.env, MCP_WS_PORT: String(WS_PORT) }
  });

  electronProcess.on('error', (err) => {
    process.stderr.write(`[MCP] Electron launch error: ${err.message}\n`);
    electronProcess = null;
  });

  electronProcess.on('exit', (code) => {
    process.stderr.write(`[MCP] Electron exited with code ${code}\n`);
    electronProcess = null;
  });
}

// --- MCP Server ---
const server = new McpServer({
  name: 'sql-proxy',
  version: '1.0.0',
});

server.tool(
  'execute_sql',
  'Sends a SQL query to the dev database. The user will review and approve the query before execution. Returns the query results as JSON.',
  {
    query: z.string().describe('The SQL query to execute'),
    description: z.string().optional().describe('Brief explanation of why this query is needed'),
  },
  async ({ query, description }) => {
    const id = `q_${++queryCounter}_${Date.now()}`;

    // Launch Electron if not running
    launchElectron();

    return new Promise((resolve) => {
      const pending: PendingQuery = {
        id,
        query,
        description,
        resolve: (data) => {
          if (data?.rejected) {
            resolve({
              content: [{ type: 'text', text: `Query was rejected by user: ${data.reason}` }],
            });
          } else {
            const resultText = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
            resolve({
              content: [{ type: 'text', text: resultText }],
            });
          }
        },
        reject: (error) => {
          resolve({
            content: [{ type: 'text', text: `Error: ${error.message}` }],
          });
        },
      };

      pendingQueries.set(id, pending);

      if (electronClient && electronClient.readyState === WebSocket.OPEN) {
        electronClient.send(JSON.stringify({ type: 'query', id, query, description }));
      }
      // If not connected yet, the query will be sent when Electron connects
    });
  }
);

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[MCP] SQL Proxy server started (WebSocket on port ${WS_PORT})\n`);
  launchElectron();
}

main().catch((e) => {
  process.stderr.write(`[MCP] Fatal: ${e}\n`);
  process.exit(1);
});

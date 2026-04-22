import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import WebSocket from 'ws';
import { spawn } from 'child_process';
import * as path from 'path';
import * as http from 'http';

const WS_PORT = 52345;

interface PendingQuery {
  id: string;
  query: string;
  description?: string;
  resolve: (result: any) => void;
  reject: (error: any) => void;
}

const pendingQueries = new Map<string, PendingQuery>();
let wsClient: WebSocket | null = null;
let queryCounter = 0;
let currentScriptsDir: string = '';
let connectRetries = 0;
const MAX_CONNECT_RETRIES = 10;
let launchInProgress = false;

// --- Check if Electron is already running ---
function isElectronRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${WS_PORT}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(500, () => { req.destroy(); resolve(false); });
  });
}

// --- Launch Electron ---
function launchElectron() {
  const electronPath = path.join(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  const mainPath = path.join(__dirname, '..', 'electron', 'main.js');

  process.stderr.write(`[MCP] Launching Electron: ${electronPath} ${mainPath}\n`);

  const child = spawn(electronPath, [mainPath], {
    stdio: 'ignore',
    detached: true,
  });

  child.on('error', (err) => {
    process.stderr.write(`[MCP] Electron launch error: ${err.message}\n`);
  });

  child.unref();
}

// --- Connect to Electron WebSocket Server ---
function connectToElectron(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);

    ws.on('open', () => {
      wsClient = ws;
      connectRetries = 0;
      process.stderr.write('[MCP] Connected to Electron WS server\n');

      // Send scripts dir if already set
      if (currentScriptsDir) {
        ws.send(JSON.stringify({ type: 'set_scripts_dir', path: currentScriptsDir }));
      }

      resolve();
    });

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
      wsClient = null;
      process.stderr.write('[MCP] Disconnected from Electron WS server\n');
      // Auto-reconnect
      setTimeout(() => ensureConnected(), 2000);
    });

    ws.on('error', (err) => {
      process.stderr.write(`[MCP] WS connect error: ${err.message}\n`);
      wsClient = null;
      reject(err);
    });
  });
}

// --- Ensure connection, launching Electron if needed ---
async function ensureConnected(): Promise<void> {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) return;
  if (launchInProgress) return; // Prevent re-entrant launches

  launchInProgress = true;
  try {
    const running = await isElectronRunning();
    if (!running) {
      launchElectron();
      // Wait for Electron to start
      let started = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await isElectronRunning()) { started = true; break; }
      }
      if (!started) {
        process.stderr.write('[MCP] Electron did not start — giving up (port conflict?)\n');
        return;
      }
    }

    await connectToElectron();
  } catch {
    connectRetries++;
    if (connectRetries < MAX_CONNECT_RETRIES) {
      await new Promise(r => setTimeout(r, 2000));
      launchInProgress = false;
      return ensureConnected();
    }
    process.stderr.write('[MCP] Failed to connect to Electron after max retries\n');
  } finally {
    launchInProgress = false;
  }
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
    const id = `q_${++queryCounter}_${Date.now()}_${process.pid}`;

    await ensureConnected();

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

      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type: 'query', id, query, description }));
      }
    });
  }
);

server.tool(
  'set_scripts_dir',
  'Sets the directory where SQL change scripts are stored. The UI will enable the Scripts browser and watch for new files. Call this once at the start of a conversation if you know the scripts path.',
  {
    path: z.string().describe('Absolute path to the SQL scripts directory'),
  },
  async ({ path: dirPath }) => {
    currentScriptsDir = dirPath;

    await ensureConnected();

    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({ type: 'set_scripts_dir', path: dirPath }));
    }

    return {
      content: [{ type: 'text', text: `Scripts directory set: ${dirPath}` }],
    };
  }
);

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[MCP] SQL Proxy MCP server started\n');

  // Connect to Electron in background (don't block MCP startup)
  ensureConnected().catch(() => {});
}

main().catch((e) => {
  process.stderr.write(`[MCP] Fatal: ${e}\n`);
  process.exit(1);
});

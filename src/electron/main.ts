import { app, BrowserWindow, ipcMain, Notification, shell, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as mysql from 'mysql2/promise';
import Store from 'electron-store';
import TelegramBot from 'node-telegram-bot-api';

const store = new Store({
  defaults: {
    db: {
      host: '127.0.0.1',
      port: 3306,
      user: '',
      password: '',
      database: '',
    },
  },
});

let mainWindow: BrowserWindow | null = null;
let dbConnection: mysql.Connection | null = null;
let scriptsDirOverride: string = '';

// --- Multi-client tracking ---
// Maps query ID to the WebSocket client that sent it, so results go back to the right MCP process
const queryToClient = new Map<string, WebSocket>();
const mcpClients = new Set<WebSocket>();

// --- Telegram Bot ---
let telegramBot: TelegramBot | null = null;
let telegramEnabled: boolean = false;
const pendingTelegramQueries = new Map<string, { id: string; query: string; description?: string }>();
const telegramMessageIds = new Map<string, { chatId: number; messageId: number }>();

function initTelegram() {
  const token = store.get('telegram.botToken') as string;
  const chatId = store.get('telegram.chatId') as string;
  telegramEnabled = (store.get('telegram.enabled') as boolean) || false;

  if (telegramBot) {
    telegramBot.stopPolling();
    telegramBot = null;
  }

  if (!token || !chatId || !telegramEnabled) return;

  try {
    telegramBot = new TelegramBot(token, { polling: true });

    telegramBot.on('callback_query', async (callbackQuery) => {
      const data = callbackQuery.data;
      if (!data) return;

      const [action, queryId] = data.split(':');
      const pending = pendingTelegramQueries.get(queryId);
      if (!pending) {
        telegramBot?.answerCallbackQuery(callbackQuery.id, { text: 'Query not found or already handled' });
        return;
      }

      const client = queryToClient.get(pending.id);

      if (action === 'approve') {
        telegramBot?.answerCallbackQuery(callbackQuery.id, { text: 'Executing...' });
        try {
          const result = await executeQuery(pending.query);
          // Send result back to the correct MCP client
          if (client && client.readyState === WebSocket.OPEN) {
            ws_sendResult(client, pending.id, result);
          }
          const preview = JSON.stringify(result).substring(0, 200);
          const execPreview = buildTelegramQueryPreview(pending.query);
          telegramBot?.editMessageText(
            `✅ Executed\n${execPreview.text}\n\nResult: ${preview}...`,
            { chat_id: callbackQuery.message!.chat.id, message_id: callbackQuery.message!.message_id }
          ).catch(() => {});
          mainWindow?.webContents.send('query-handled-remotely', { id: pending.id, status: 'sent (Telegram)', query: pending.query });
        } catch (e: any) {
          if (client && client.readyState === WebSocket.OPEN) {
            ws_sendError(client, pending.id, e.message);
          }
          const errPreview = buildTelegramQueryPreview(pending.query);
          telegramBot?.editMessageText(
            `❌ Error\n${errPreview.text}\n\nError: ${e.message}`,
            { chat_id: callbackQuery.message!.chat.id, message_id: callbackQuery.message!.message_id }
          ).catch(() => {});
        }
      } else if (action === 'reject') {
        telegramBot?.answerCallbackQuery(callbackQuery.id, { text: 'Rejected' });
        if (client && client.readyState === WebSocket.OPEN) {
          ws_sendRejected(client, pending.id, 'Rejected via Telegram');
        }
        const rejPreview = buildTelegramQueryPreview(pending.query);
        telegramBot?.editMessageText(
          `🚫 Rejected\n${rejPreview.text}`,
          { chat_id: callbackQuery.message!.chat.id, message_id: callbackQuery.message!.message_id }
        ).catch(() => {});
        mainWindow?.webContents.send('query-handled-remotely', { id: pending.id, status: 'rejected (Telegram)', query: pending.query });
      }

      pendingTelegramQueries.delete(queryId);
      queryToClient.delete(pending.id);
    });

    process.stderr.write('[MCP] Telegram bot started\n');
  } catch (e: any) {
    process.stderr.write(`[MCP] Telegram bot error: ${e.message}\n`);
  }
}

// Telegram caps messages at 4096 chars. Leave headroom for header, description, fences, markdown.
// If the query is longer, send a head+tail preview so the user can still approve / reject.
function buildTelegramQueryPreview(query: string, maxQueryChars = 3200): { text: string; truncated: boolean } {
  if (query.length <= maxQueryChars) return { text: query, truncated: false };
  const keep = maxQueryChars - 80; // room for the cut marker
  const headLen = Math.floor(keep * 0.75);
  const tailLen = keep - headLen;
  const head = query.substring(0, headLen);
  const tail = query.substring(query.length - tailLen);
  const removed = query.length - headLen - tailLen;
  return {
    text: `${head}\n\n-- ... (${removed} chars / ${(removed / 1024).toFixed(1)} KB truncated for Telegram preview) ...\n\n${tail}`,
    truncated: true,
  };
}

function sendQueryToTelegram(id: string, query: string, description?: string) {
  if (!telegramBot || !telegramEnabled) return;
  const chatId = store.get('telegram.chatId') as string;
  if (!chatId) return;

  pendingTelegramQueries.set(id, { id, query, description });

  const preview = buildTelegramQueryPreview(query);
  const sizeNote = preview.truncated
    ? `\n⚠️ Query is ${query.length} chars (${(query.length / 1024).toFixed(1)} KB). Preview truncated — full query is visible in the desktop app.`
    : '';
  const descPart = description ? `\n${description}` : '';
  const text = `🔍 New SQL Query${descPart}${sizeNote}\n\n${preview.text}`;

  // Note: no parse_mode — plain text is the only reliable option because SQL freely
  // contains _, *, [, ], `, (, ) which break both legacy Markdown and MarkdownV2.
  telegramBot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Execute', callback_data: `approve:${id}` },
        { text: '❌ Reject', callback_data: `reject:${id}` },
      ]],
    },
  }).then((msg) => {
    telegramMessageIds.set(id, { chatId: msg.chat.id, messageId: msg.message_id });
  }).catch((e) => {
    process.stderr.write(`[MCP] Telegram send error: ${e.message}\n`);
    pendingTelegramQueries.delete(id);
    const client = queryToClient.get(id);
    if (client && client.readyState === WebSocket.OPEN) {
      ws_sendError(
        client,
        id,
        `Telegram notification failed: ${e.message}. Query was NOT executed — no approval request could be delivered to Telegram. Likely causes: Markdown special chars (_, *, [, ], backtick) in description, Telegram API outage, or invalid bot token.`
      );
    }
  });
}

function dismissTelegramQuery(queryId: string, statusText: string) {
  const msgRef = telegramMessageIds.get(queryId);
  if (!msgRef || !telegramBot) return;

  const pending = pendingTelegramQueries.get(queryId);
  const queryPreview = pending ? pending.query.substring(0, 100) : '';

  telegramBot.editMessageText(
    `${statusText}\n${queryPreview}`,
    { chat_id: msgRef.chatId, message_id: msgRef.messageId }
  ).catch(() => {});

  pendingTelegramQueries.delete(queryId);
  telegramMessageIds.delete(queryId);
}

// --- Helper: send messages to specific MCP client ---
function ws_sendResult(client: WebSocket, id: string, data: any) {
  client.send(JSON.stringify({ type: 'result', id, data }));
  queryToClient.delete(id);
}

function ws_sendError(client: WebSocket, id: string, error: string) {
  client.send(JSON.stringify({ type: 'error', id, error }));
  queryToClient.delete(id);
}

function ws_sendRejected(client: WebSocket, id: string, reason: string) {
  client.send(JSON.stringify({ type: 'rejected', id, reason }));
  queryToClient.delete(id);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'MCP SQL Proxy',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    const clientCount = mcpClients.size;
    mainWindow?.webContents.send('mcp-status', clientCount > 0 ? 'connected' : 'disconnected');
    mainWindow?.webContents.send('mcp-client-count', clientCount);

    const dbConfig = store.get('db') as any;
    if (!dbConfig?.user) {
      mainWindow?.webContents.send('open-settings');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- Database ---
async function getDbConnection(): Promise<mysql.Connection> {
  if (dbConnection) {
    try {
      await dbConnection.ping();
      return dbConnection;
    } catch {
      dbConnection = null;
    }
  }

  const dbConfig = store.get('db') as any;
  dbConnection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    multipleStatements: true,
  });

  return dbConnection;
}

async function executeQuery(query: string): Promise<any> {
  const conn = await getDbConnection();
  const [rows] = await conn.query(query);

  if (Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0])) {
    const resultSets: any[][] = [];
    for (const rs of rows as any[]) {
      if (Array.isArray(rs) && rs.length > 0 && typeof rs[0] === 'object' && !Array.isArray(rs[0])) {
        resultSets.push(rs);
      }
    }
    if (resultSets.length === 1) return resultSets[0];
    if (resultSets.length > 1) return { _multipleResultSets: true, resultSets };
    return rows[0];
  }

  return rows;
}

// --- WebSocket Server (accepts connections from MCP processes) ---
const WS_PORT = 52345;

function startWebSocketServer() {
  // HTTP server for health check + WebSocket upgrade
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    mcpClients.add(ws);
    process.stderr.write(`[MCP] MCP client connected (total: ${mcpClients.size})\n`);
    mainWindow?.webContents.send('mcp-status', 'connected');
    mainWindow?.webContents.send('mcp-client-count', mcpClients.size);

    // Send scripts dir if already set
    const scriptsDir = getScriptsDir();
    if (scriptsDir) {
      ws.send(JSON.stringify({ type: 'set_scripts_dir', path: scriptsDir }));
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'set_scripts_dir') {
          scriptsDirOverride = msg.path || '';
          store.set('scriptsDir', scriptsDirOverride);
          mainWindow?.webContents.send('scripts-dir-changed', scriptsDirOverride);
          initScriptWatcher();
        } else if (msg.type === 'query') {
          // Track which client sent this query
          queryToClient.set(msg.id, ws);

          // Forward to renderer
          mainWindow?.webContents.send('new-query', {
            id: msg.id,
            query: msg.query,
            description: msg.description,
          });
          mainWindow?.flashFrame(true);
          if (mainWindow?.isMinimized()) mainWindow.restore();
          mainWindow?.focus();

          mainWindow?.webContents.send('show-notification', {
            title: 'MCP SQL Proxy',
            body: msg.description || 'Neue SQL-Query wartet auf Freigabe',
          });

          sendQueryToTelegram(msg.id, msg.query, msg.description);
        }
      } catch (e) {
        console.error('Failed to parse MCP message:', e);
      }
    });

    ws.on('close', () => {
      mcpClients.delete(ws);
      process.stderr.write(`[MCP] MCP client disconnected (total: ${mcpClients.size})\n`);
      mainWindow?.webContents.send('mcp-client-count', mcpClients.size);
      if (mcpClients.size === 0) {
        mainWindow?.webContents.send('mcp-status', 'disconnected');
      }

      // Clean up queries from disconnected client
      for (const [queryId, client] of queryToClient) {
        if (client === ws) {
          queryToClient.delete(queryId);
        }
      }
    });
  });

  httpServer.listen(WS_PORT, '127.0.0.1', () => {
    process.stderr.write(`[MCP] WebSocket server listening on port ${WS_PORT}\n`);
  });

  httpServer.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`[MCP] Port ${WS_PORT} already in use — another Electron instance is probably running. Exiting.\n`);
      app.quit();
    } else {
      process.stderr.write(`[MCP] HTTP server error: ${err.message}\n`);
    }
  });
}

// --- IPC Handlers ---

ipcMain.handle('approve-query', async (_event, { id, query }) => {
  try {
    const result = await executeQuery(query);
    return { success: true, data: result };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.on('send-result', (_event, { id, data }) => {
  const client = queryToClient.get(id);
  if (client && client.readyState === WebSocket.OPEN) {
    ws_sendResult(client, id, data);
  }
  dismissTelegramQuery(id, '✅ Handled in app');
});

ipcMain.on('send-error', (_event, { id, error }) => {
  const client = queryToClient.get(id);
  if (client && client.readyState === WebSocket.OPEN) {
    ws_sendError(client, id, error);
  }
  dismissTelegramQuery(id, '⚠️ Error (handled in app)');
});

ipcMain.on('reject-query', (_event, { id, reason }) => {
  const client = queryToClient.get(id);
  if (client && client.readyState === WebSocket.OPEN) {
    ws_sendRejected(client, id, reason);
  }
  dismissTelegramQuery(id, '🚫 Rejected in app');
});

ipcMain.handle('get-db-settings', () => {
  return store.get('db');
});

ipcMain.handle('save-db-settings', async (_event, settings) => {
  store.set('db', settings);
  if (dbConnection) {
    await dbConnection.end().catch(() => {});
    dbConnection = null;
  }
  return true;
});

ipcMain.handle('test-db-connection', async () => {
  try {
    const conn = await getDbConnection();
    await conn.ping();
    return { success: true };
  } catch (e: any) {
    dbConnection = null;
    return { success: false, error: e.message };
  }
});

// SQL Scripts
function getScriptsDir(): string {
  return scriptsDirOverride || process.env.SCRIPTS_DIR || store.get('scriptsDir') as string || '';
}

ipcMain.handle('get-scripts', async () => {
  const dir = getScriptsDir();
  if (!dir) return { success: false, error: 'Scripts directory not configured. Go to Settings.' };
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .map(f => {
        const stat = fs.statSync(path.join(dir, f));
        return { name: f, modified: stat.mtime.toISOString(), size: stat.size };
      })
      .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    return { success: true, files };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('read-script', async (_event, filename: string) => {
  const dir = getScriptsDir();
  if (!dir) return { success: false, error: 'Scripts directory not configured' };
  try {
    const content = fs.readFileSync(path.join(dir, filename), 'utf-8');
    return { success: true, content };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-script-external', async (_event, filename: string) => {
  const dir = getScriptsDir();
  if (dir) shell.openPath(path.join(dir, filename));
});

ipcMain.handle('get-scripts-dir', () => getScriptsDir());

// Telegram settings
ipcMain.handle('get-telegram-settings', () => ({
  botToken: store.get('telegram.botToken') || '',
  chatId: store.get('telegram.chatId') || '',
  enabled: store.get('telegram.enabled') || false,
}));

ipcMain.handle('save-telegram-settings', async (_event, settings: { botToken: string; chatId: string; enabled: boolean }) => {
  store.set('telegram.botToken', settings.botToken);
  store.set('telegram.chatId', settings.chatId);
  store.set('telegram.enabled', settings.enabled);
  telegramEnabled = settings.enabled;
  initTelegram();
  return true;
});

ipcMain.on('set-app-icon', (_event, pngDataUrl: string) => {
  try {
    const img = nativeImage.createFromDataURL(pngDataUrl);
    mainWindow?.setIcon(img);
  } catch (e: any) {
    process.stderr.write(`[MCP] Set icon error: ${e.message}\n`);
  }
});

// --- File Watcher for SQL Scripts ---
let knownScripts = new Set<string>();
let watcherReady = false;
let currentWatcher: fs.FSWatcher | null = null;

function initScriptWatcher() {
  const dir = getScriptsDir();
  if (currentWatcher) { currentWatcher.close(); currentWatcher = null; }
  knownScripts.clear();
  watcherReady = false;

  if (!dir || !fs.existsSync(dir)) return;

  try {
    const existing = fs.readdirSync(dir).filter(f => f.endsWith('.sql'));
    existing.forEach(f => knownScripts.add(f));
    watcherReady = true;

    currentWatcher = fs.watch(dir, (eventType, filename) => {
      if (!filename || !filename.endsWith('.sql') || !watcherReady) return;

      const filePath = path.join(dir, filename);
      if (!fs.existsSync(filePath)) return;
      if (knownScripts.has(filename)) {
        mainWindow?.webContents.send('script-changed', { name: filename, isNew: false });
        return;
      }

      knownScripts.add(filename);
      mainWindow?.webContents.send('script-changed', { name: filename, isNew: true });

      mainWindow?.flashFrame(true);
      mainWindow?.webContents.send('show-notification', {
        title: 'Neues SQL Script',
        body: filename,
      });
    });

    process.stderr.write(`[MCP] Watching scripts dir: ${dir}\n`);
  } catch (e: any) {
    process.stderr.write(`[MCP] Script watcher error: ${e.message}\n`);
  }
}

// --- App lifecycle ---
app.setAppUserModelId('com.woizzer.mcp-sql-proxy');

app.whenReady().then(() => {
  createWindow();
  startWebSocketServer();
  initScriptWatcher();
  initTelegram();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

import { app, BrowserWindow, ipcMain, Notification, shell, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import WebSocket from 'ws';
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
let ws: WebSocket | null = null;
let dbConnection: mysql.Connection | null = null;
let scriptsDirOverride: string = '';

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

      if (action === 'approve') {
        telegramBot?.answerCallbackQuery(callbackQuery.id, { text: 'Executing...' });
        try {
          const result = await executeQuery(pending.query);
          // Send result back to MCP
          if (ws && ws.readyState === WebSocket.OPEN) {
            const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            ws.send(JSON.stringify({ type: 'result', id: pending.id, data: result }));
          }
          // Update Telegram message
          const preview = JSON.stringify(result).substring(0, 200);
          telegramBot?.editMessageText(
            `✅ *Executed*\n\`\`\`sql\n${pending.query}\n\`\`\`\nResult: \`${preview}...\``,
            { chat_id: callbackQuery.message!.chat.id, message_id: callbackQuery.message!.message_id, parse_mode: 'Markdown' }
          ).catch(() => {});
          // Remove from Electron UI pending list
          mainWindow?.webContents.send('query-handled-remotely', pending.id);
        } catch (e: any) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', id: pending.id, error: e.message }));
          }
          telegramBot?.editMessageText(
            `❌ *Error*\n\`\`\`sql\n${pending.query}\n\`\`\`\nError: ${e.message}`,
            { chat_id: callbackQuery.message!.chat.id, message_id: callbackQuery.message!.message_id, parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      } else if (action === 'reject') {
        telegramBot?.answerCallbackQuery(callbackQuery.id, { text: 'Rejected' });
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'rejected', id: pending.id, reason: 'Rejected via Telegram' }));
        }
        telegramBot?.editMessageText(
          `🚫 *Rejected*\n\`\`\`sql\n${pending.query}\n\`\`\``,
          { chat_id: callbackQuery.message!.chat.id, message_id: callbackQuery.message!.message_id, parse_mode: 'Markdown' }
        ).catch(() => {});
        mainWindow?.webContents.send('query-handled-remotely', pending.id);
      }

      pendingTelegramQueries.delete(queryId);
    });

    process.stderr.write('[MCP] Telegram bot started\n');
  } catch (e: any) {
    process.stderr.write(`[MCP] Telegram bot error: ${e.message}\n`);
  }
}

function sendQueryToTelegram(id: string, query: string, description?: string) {
  if (!telegramBot || !telegramEnabled) return;
  const chatId = store.get('telegram.chatId') as string;
  if (!chatId) return;

  pendingTelegramQueries.set(id, { id, query, description });

  const text = `🔍 *New SQL Query*${description ? `\n_${description}_` : ''}\n\`\`\`sql\n${query}\n\`\`\``;

  telegramBot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
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
  });
}

function dismissTelegramQuery(queryId: string, statusText: string) {
  const msgRef = telegramMessageIds.get(queryId);
  if (!msgRef || !telegramBot) return;

  const pending = pendingTelegramQueries.get(queryId);
  const queryPreview = pending ? pending.query.substring(0, 100) : '';

  telegramBot.editMessageText(
    `${statusText}\n\`\`\`sql\n${queryPreview}\n\`\`\``,
    { chat_id: msgRef.chatId, message_id: msgRef.messageId, parse_mode: 'Markdown' }
  ).catch(() => {});

  pendingTelegramQueries.delete(queryId);
  telegramMessageIds.delete(queryId);
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

  // Send current MCP status once the page is loaded, open settings on first launch
  mainWindow.webContents.on('did-finish-load', () => {
    const status = (ws && ws.readyState === WebSocket.OPEN) ? 'connected' : 'disconnected';
    mainWindow?.webContents.send('mcp-status', status);

    // First launch: open settings if DB user not configured
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

  // CALL statements (stored procedures) return nested arrays: [[resultSet1, resultSet2, ...], fields]
  // Extract all result sets that contain actual row data
  if (Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0])) {
    const resultSets: any[][] = [];
    for (const rs of rows as any[]) {
      if (Array.isArray(rs) && rs.length > 0 && typeof rs[0] === 'object' && !Array.isArray(rs[0])) {
        resultSets.push(rs);
      }
    }
    // Single result set: return flat array; multiple: wrap with _resultSetIndex marker
    if (resultSets.length === 1) return resultSets[0];
    if (resultSets.length > 1) return { _multipleResultSets: true, resultSets };
    return rows[0];
  }

  return rows;
}

// --- WebSocket connection to MCP server ---
function connectToMcp() {
  const port = process.env.MCP_WS_PORT || '52345';
  ws = new WebSocket(`ws://127.0.0.1:${port}`);

  ws.on('open', () => {
    mainWindow?.webContents.send('mcp-status', 'connected');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'set_scripts_dir') {
        scriptsDirOverride = msg.path || '';
        store.set('scriptsDir', scriptsDirOverride); // persist for next launch
        mainWindow?.webContents.send('scripts-dir-changed', scriptsDirOverride);
        initScriptWatcher();
      } else if (msg.type === 'query') {
        // Forward to renderer
        mainWindow?.webContents.send('new-query', {
          id: msg.id,
          query: msg.query,
          description: msg.description,
        });
        // Flash/focus window
        mainWindow?.flashFrame(true);
        if (mainWindow?.isMinimized()) mainWindow.restore();
        mainWindow?.focus();

        // Send notification request to renderer (Web Notification API)
        mainWindow?.webContents.send('show-notification', {
          title: 'MCP SQL Proxy',
          body: msg.description || 'Neue SQL-Query wartet auf Freigabe',
        });

        // Send to Telegram if enabled
        sendQueryToTelegram(msg.id, msg.query, msg.description);
      }
    } catch (e) {
      console.error('Failed to parse MCP message:', e);
    }
  });

  ws.on('close', () => {
    mainWindow?.webContents.send('mcp-status', 'disconnected');
    // Reconnect after delay
    setTimeout(connectToMcp, 2000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    // Will trigger close → reconnect
  });
}

// --- IPC Handlers ---

// Execute approved query
ipcMain.handle('approve-query', async (_event, { id, query }) => {
  try {
    const result = await executeQuery(query);
    return { success: true, data: result };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

// Send result back to MCP
ipcMain.on('send-result', (_event, { id, data }) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'result', id, data }));
  }
  dismissTelegramQuery(id, '✅ Handled in app');
});

// Send error back to MCP
ipcMain.on('send-error', (_event, { id, error }) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', id, error }));
  }
  dismissTelegramQuery(id, '⚠️ Error (handled in app)');
});

// Reject query
ipcMain.on('reject-query', (_event, { id, reason }) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'rejected', id, reason }));
  }
  dismissTelegramQuery(id, '🚫 Rejected in app');
});

// DB settings
ipcMain.handle('get-db-settings', () => {
  return store.get('db');
});

ipcMain.handle('save-db-settings', async (_event, settings) => {
  store.set('db', settings);
  // Close existing connection so next query uses new settings
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
  // Cleanup previous watcher
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
  connectToMcp();
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

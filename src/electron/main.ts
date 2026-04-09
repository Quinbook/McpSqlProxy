import { app, BrowserWindow, ipcMain, Notification, shell, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import WebSocket from 'ws';
import * as mysql from 'mysql2/promise';
import Store from 'electron-store';

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
});

// Send error back to MCP
ipcMain.on('send-error', (_event, { id, error }) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', id, error }));
  }
});

// Reject query
ipcMain.on('reject-query', (_event, { id, reason }) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'rejected', id, reason }));
  }
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
  return scriptsDirOverride || process.env.SCRIPTS_DIR || '';
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

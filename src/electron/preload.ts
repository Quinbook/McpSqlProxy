import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  // Query handling
  onNewQuery: (callback: (query: any) => void) => {
    ipcRenderer.on('new-query', (_event, query) => callback(query));
  },
  approveQuery: (id: string, query: string) => ipcRenderer.invoke('approve-query', { id, query }),
  sendResult: (id: string, data: any) => ipcRenderer.send('send-result', { id, data }),
  sendError: (id: string, error: string) => ipcRenderer.send('send-error', { id, error }),
  rejectQuery: (id: string, reason: string) => ipcRenderer.send('reject-query', { id, reason }),

  // MCP status
  onMcpStatus: (callback: (status: string) => void) => {
    ipcRenderer.on('mcp-status', (_event, status) => callback(status));
  },
  onMcpClientCount: (callback: (count: number) => void) => {
    ipcRenderer.on('mcp-client-count', (_event, count) => callback(count));
  },

  // DB settings
  getDbSettings: () => ipcRenderer.invoke('get-db-settings'),
  saveDbSettings: (settings: any) => ipcRenderer.invoke('save-db-settings', settings),
  testDbConnection: () => ipcRenderer.invoke('test-db-connection'),

  // SQL Scripts
  getScripts: () => ipcRenderer.invoke('get-scripts'),
  readScript: (filename: string) => ipcRenderer.invoke('read-script', filename),
  openScriptExternal: (filename: string) => ipcRenderer.invoke('open-script-external', filename),
  getScriptsDir: () => ipcRenderer.invoke('get-scripts-dir'),
  onOpenSettings: (callback: () => void) => {
    ipcRenderer.on('open-settings', () => callback());
  },
  onScriptChanged: (callback: (data: any) => void) => {
    ipcRenderer.on('script-changed', (_event, data) => callback(data));
  },
  onScriptsDirChanged: (callback: (dir: string) => void) => {
    ipcRenderer.on('scripts-dir-changed', (_event, dir) => callback(dir));
  },
  onShowNotification: (callback: (data: any) => void) => {
    ipcRenderer.on('show-notification', (_event, data) => callback(data));
  },
  onQueryHandledRemotely: (callback: (data: { id: string; status: string; query: string }) => void) => {
    ipcRenderer.on('query-handled-remotely', (_event, data) => callback(data));
  },

  // Telegram
  getTelegramSettings: () => ipcRenderer.invoke('get-telegram-settings'),
  saveTelegramSettings: (settings: any) => ipcRenderer.invoke('save-telegram-settings', settings),
  setAppIcon: (pngDataUrl: string) => ipcRenderer.send('set-app-icon', pngDataUrl),
});

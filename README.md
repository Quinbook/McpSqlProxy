# MCP SQL Proxy

A desktop bridge between [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (via MCP) and your MySQL/MariaDB database. Every SQL query from Claude lands in an Electron approval UI before it touches the database -- giving you full control over what gets executed.

![Architecture](https://img.shields.io/badge/MCP-Claude_Code-blueviolet) ![Electron](https://img.shields.io/badge/Electron-35-47848F) ![MySQL](https://img.shields.io/badge/MySQL%2FMariaDB-compatible-orange)

## How it works

```
Claude Code  --MCP/stdio-->  MCP Server  --WebSocket-->  Electron UI  --mysql2-->  Database
                                                              |
                                                         You approve,
                                                        edit, or reject
```

1. Claude calls the `execute_sql` MCP tool
2. The query appears in the Electron UI with a toast notification
3. You review, optionally edit the query, then click **Execute** or **Reject**
4. Results are displayed in an interactive table
5. You review the results, then send them back to Claude

## Features

**Query Approval Flow**
- Review and edit queries before execution
- Approve, reject, or modify any SQL Claude wants to run
- Toast notifications (in-app + OS) when a query arrives

**Interactive Results**
- Sortable result table with multiple result set support (stored procedures)
- Row checkboxes -- deselect rows you don't want to send back
- Double-click cells to edit values before sending
- Remove columns with one click
- DateTime auto-formatting (`YYYY-MM-DD HH:mm:ss`)

**Manual Query Mode**
- Write and execute your own queries without Claude
- Copy query + results as formatted Markdown for pasting into Claude
- Full query history with reload support

**SQL Script Browser**
- Browse SQL change scripts from a configured directory
- File watcher with auto-detection of new scripts
- New scripts highlighted with badge counter
- Open scripts in your default editor or load into the query editor
- Auto-switches between Scripts and Query view based on context

**Other**
- Resizable sidebars
- DB connection settings with auto-test on startup
- MCP connection status indicator

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- A MySQL or MariaDB database

### Install

```bash
git clone https://github.com/Quinbook/McpSqlProxy.git
cd McpSqlProxy
npm install
npm run build
```

### Configure Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "sql-proxy": {
      "command": "node",
      "args": ["C:\\path\\to\\McpSqlProxy\\dist\\mcp\\server.js"]
    }
  }
}
```

Then connect in Claude Code with `/mcp`.

### Configure Database

On first launch, click **Settings** in the top right corner and enter your database credentials. Click **Test Connection** to verify, then **Save**. Credentials are stored locally via `electron-store`.

## Usage

### With Claude Code

Once connected, Claude can call the `execute_sql` tool. Each query pops up in the UI for your approval. After execution, review the results and click **Send to Claude** or **Send as Text**.

### Manual Queries

When no Claude query is pending, the UI shows a manual query editor. Write SQL, click Execute, and optionally copy the results for Claude with **Copy for Claude**.

### SQL Scripts

Click the **Scripts** button in the header to browse SQL files from the configured scripts directory. The file watcher automatically detects new scripts and highlights them.

## Configuring Claude Code

For Claude to use the tool correctly, add the following rules to your project's `CLAUDE.md` or Claude Code memory:

### Database Rules

```markdown
- Database is MariaDB/MySQL -- use `CALL` syntax for stored procedures, not `EXEC`
- For test queries, use `sp_GetSession(0)` as the auth/session parameter
- Use `i_company = 3` (or your test company ID) for testing
- All database access in application code must go through stored procedures via SqlHelper
- Never write direct SQL in application code
```

### Script Rules

```markdown
- All database changes (new tables, altered columns, new/modified SPs) must be saved
  as SQL scripts in the configured scripts directory (e.g. `C:\GIT-WOIZZER\WoizzerDatabase\changes\`)
- Never modify existing stored procedures in place -- always create a new versioned copy
  (e.g. `sp_GetShifts` -> `sp_GetShifts2`) and update the application code to call the new version
- After creating scripts, the SQL Proxy app will automatically detect and highlight them
```

### Example Memory Entry

If you use Claude Code's auto-memory feature, save a reference like:

```markdown
---
name: MCP SQL Proxy for DB queries
description: Use MCP tool execute_sql for direct SQL queries against the dev DB (MariaDB, CALL syntax for SPs)
type: reference
---

For database queries two paths are available:

1. **MCP SQL Proxy** (`mcp__sql-proxy__execute_sql`) -- direct SQL queries against the dev DB
   - Stored procedures: `CALL sp_Name(...)` (not EXEC)
   - Auth parameter: `sp_GetSession(0)`
   - Test company: `i_company = 3`
   - User approves every query before execution

2. **Database change scripts** -- read SP definitions and change scripts from the scripts directory
```

### Script Directory Configuration

The scripts directory is configured in `src/electron/main.ts`:

```typescript
const SCRIPTS_DIR = 'C:\\path\\to\\your\\database\\changes';
```

Change this path to point to your SQL change scripts directory and rebuild (`npm run build`).

## Development

```bash
# Build
npm run build

# Run Electron standalone (without MCP)
npm start

# Run MCP server only
npm run mcp
```

## Architecture

| Component | File | Role |
|-----------|------|------|
| MCP Server | `src/mcp/server.ts` | Stdio transport for Claude, WebSocket bridge to Electron |
| Electron Main | `src/electron/main.ts` | Window management, DB connection, IPC handlers, file watcher |
| Preload | `src/electron/preload.ts` | Secure IPC bridge (contextIsolation) |
| Renderer | `src/renderer/index.html` | Single-file UI (Tailwind CSS) |

## License

MIT

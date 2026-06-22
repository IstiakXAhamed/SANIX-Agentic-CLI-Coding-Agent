/**
 * @file SANIX Desktop — Electron Main Process
 * @author Istiak Ahamed
 * @description Cross-platform desktop GUI for SANIX.
 *
 * Features:
 * - Dark themed window with SANIX branding
 * - System tray with quick actions
 * - Auto-starts SANIX REST API server
 * - Deep links (sanix://)
 * - Native notifications
 * - Window state persistence
 * - Menu bar (File/Edit/View/Agent/Tools/Help)
 *
 * @packageDocumentation
 */

import { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain, Notification } from 'electron';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const isDev = !app.isPackaged;
const SANIX_BG = '#0D1117';
const SANIX_CYAN = '#00D4FF';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

// ─── Window State Persistence ───────────────────────────────────────────────
interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

function getConfigDir(): string {
  const dir = join(homedir(), '.sanix');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function loadWindowState(): WindowState {
  const path = join(getConfigDir(), 'desktop-state.json');
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8')) as WindowState;
    }
  } catch { /* ignore */ }
  return { width: 1400, height: 900, maximized: false };
}

function saveWindowState(state: WindowState): void {
  const path = join(getConfigDir(), 'desktop-state.json');
  try {
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch { /* ignore */ }
}

// ─── Create Window ──────────────────────────────────────────────────────────
function createWindow(): void {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: SANIX_BG,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Load the dashboard
  const dashboardUrl = isDev
    ? 'http://127.0.0.1:7332'
    : 'http://127.0.0.1:7332'; // Same in production (dashboard runs locally)

  mainWindow.loadURL(dashboardUrl).catch(() => {
    // Fallback: show a local HTML page
    mainWindow?.loadDataURL(
      'data:text/html,' +
      encodeURIComponent(`
        <html style="background:${SANIX_BG};color:${SANIX_CYAN};font-family:system-ui;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;">
        <h1>⟡ SANIX</h1>
        <p>Starting SANIX server...</p>
        <p style="color:#8B949E;font-size:14px;">If this persists, run: sanix serve</p>
        </html>
      `),
    );
  });

  mainWindow.once('ready-to-show', () => {
    if (state.maximized) {
      mainWindow?.maximize();
    } else {
      mainWindow?.show();
    }
  });

  // Save window state on close
  mainWindow.on('close', () => {
    if (!mainWindow) return;
    const bounds = mainWindow.getBounds();
    saveWindowState({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: mainWindow.isMaximized(),
    });
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── Menu ───────────────────────────────────────────────────────────────────
function createMenu(): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send('menu:new-session') },
        { type: 'separator' },
        { label: 'Open...', accelerator: 'CmdOrCtrl+O', click: () => mainWindow?.webContents.send('menu:open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => mainWindow?.webContents.send('menu:save') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Agent',
      submenu: [
        { label: 'Run Agent...', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.send('menu:agent-run') },
        { label: 'Chat', accelerator: 'CmdOrCtrl+T', click: () => mainWindow?.webContents.send('menu:agent-chat') },
        { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: () => mainWindow?.webContents.send('menu:agent-stop') },
        { type: 'separator' },
        { label: 'Agent List', click: () => mainWindow?.webContents.send('menu:agent-list') },
        { label: 'UltraWorker', click: () => mainWindow?.webContents.send('menu:agent-ultra') },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Sandbox', click: () => mainWindow?.webContents.send('menu:tools-sandbox') },
        { label: 'Browser Automation', click: () => mainWindow?.webContents.send('menu:tools-browser') },
        { label: 'Knowledge Graph', click: () => mainWindow?.webContents.send('menu:tools-kg') },
        { label: 'RAG Pipeline', click: () => mainWindow?.webContents.send('menu:tools-rag') },
        { type: 'separator' },
        { label: 'Plugin Marketplace', click: () => mainWindow?.webContents.send('menu:tools-marketplace') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Documentation', click: () => shell.openExternal('https://github.com/istiak-ahamed/sanix') },
        { label: 'Report Issue', click: () => shell.openExternal('https://github.com/istiak-ahamed/sanix/issues') },
        { type: 'separator' },
        { label: 'Check for Updates...', click: () => checkForUpdates() },
        { type: 'separator' },
        { label: `About SANIX`, click: () => {
          const { dialog } = require('electron');
          dialog.showMessageBox(mainWindow!, {
            type: 'info',
            title: 'About SANIX',
            message: 'SANIX v1.0.0',
            detail: 'Sanim\'s Agentic Neural Intelligence eXecutor\n\nCreated by: Istiak Ahamed\nLicense: MIT\n\n42 packages • 22 agents • 18 LLM adapters\n\nCopyright © 2026 Istiak Ahamed. All rights reserved.',
            buttons: ['OK'],
          });
        }},
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// ─── System Tray ────────────────────────────────────────────────────────────
function createTray(): void {
  // Create a simple tray icon (1x1 cyan pixel as placeholder)
  const size = 16;
  const icon = nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('SANIX');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open SANIX', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'New Chat', click: () => mainWindow?.webContents.send('tray:new-chat') },
    { label: 'Run Agent', click: () => mainWindow?.webContents.send('tray:run-agent') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => mainWindow?.show());
}

// ─── Notifications ──────────────────────────────────────────────────────────
function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// ─── Update Check (placeholder) ─────────────────────────────────────────────
async function checkForUpdates(): Promise<void> {
  showNotification('SANIX', 'Checking for updates...');
  // TODO: Implement auto-updater
}

// ─── App Lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  Menu.setApplicationMenu(createMenu());
  createWindow();
  createTray();

  // Auto-start SANIX server (best effort)
  import('node:child_process').then(({ spawn }) => {
    try {
      const child = spawn('sanix', ['serve'], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', () => {
        // sanix not found — user will need to start it manually
      });
      child.unref();
    } catch {
      // Ignore — server may already be running
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Cleanup
  tray?.destroy();
});

// ─── IPC Handlers ───────────────────────────────────────────────────────────
ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('system:openExternal', (_event, url: string) => {
  if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
    return shell.openExternal(url);
  }
});

ipcMain.handle('system:showNotification', (_event, opts: { title: string; body: string }) => {
  if (opts && typeof opts.title === 'string') {
    showNotification(opts.title, opts.body ?? '');
  }
});

// Deep link handler
app.setAsDefaultProtocolClient('sanix');
app.on('open-url', (event, url) => {
  event.preventDefault();
  mainWindow?.webContents.send('deep-link', url);
});

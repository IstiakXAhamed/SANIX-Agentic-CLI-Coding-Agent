/**
 * @file SANIX Desktop — Preload Script
 * @description Secure bridge between renderer and main process.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sanix', {
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
  },
  system: {
    openExternal: (url: string) => ipcRenderer.invoke('system:openExternal', url),
    showNotification: (opts: { title: string; body: string }) =>
      ipcRenderer.invoke('system:showNotification', opts),
  },
  onDeepLink: (callback: (url: string) => void) => {
    ipcRenderer.on('deep-link', (_event, url) => callback(url));
  },
  onMenuAction: (callback: (action: string) => void) => {
    const channels = [
      'menu:new-session', 'menu:open', 'menu:save',
      'menu:agent-run', 'menu:agent-chat', 'menu:agent-stop',
      'menu:agent-list', 'menu:agent-ultra',
      'menu:tools-sandbox', 'menu:tools-browser', 'menu:tools-kg',
      'menu:tools-rag', 'menu:tools-marketplace',
      'tray:new-chat', 'tray:run-agent',
    ];
    channels.forEach((ch) => {
      ipcRenderer.on(ch, () => callback(ch));
    });
  },
});

// Bridge between the rail UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('switchboard', {
  platform: process.platform,
  init: () => ipcRenderer.invoke('ui:init'),
  onState: (fn) => ipcRenderer.on('state', (_e, state) => fn(state)),
  activate: (id) => ipcRenderer.send('ui:activate', id),
  contextMenu: (id) => ipcRenderer.send('ui:context', id),
  retry: (id) => ipcRenderer.send('ui:retry', id),
  setPanel: (name) => ipcRenderer.send('ui:panel', name),
  addPreset: (presetId) => ipcRenderer.send('ui:add', { presetId }),
  addCustom: (name, url) => ipcRenderer.send('ui:add', { name, url }),
  setDockIcon: (dataUrl) => ipcRenderer.send('ui:dock-icon', dataUrl),
  installUpdate: () => ipcRenderer.send('ui:update'),
  checkUpdates: () => ipcRenderer.send('ui:check-updates'),
  toggleNotifications: () => ipcRenderer.send('ui:toggle-notifications'),
  toggleSound: () => ipcRenderer.send('ui:toggle-sound'),
});

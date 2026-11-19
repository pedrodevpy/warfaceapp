// Bridge between the banner window and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toasts', {
  onList: (fn) => ipcRenderer.on('toasts', (_e, list) => fn(list)),
  click: (key) => ipcRenderer.send('toast:click', key),
  dismiss: (key) => ipcRenderer.send('toast:dismiss', key),
});

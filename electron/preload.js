const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dmDashDesktop', Object.freeze({
  openCampaign: () => ipcRenderer.invoke('campaign:open'),
  saveCampaign: payload => ipcRenderer.invoke('campaign:save', payload)
}));

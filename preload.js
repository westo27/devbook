'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    append: (text, time, day) => ipcRenderer.invoke('note:append', text, time, day),
    read: day => ipcRenderer.invoke('note:read', day),
    delete: (index, day) => ipcRenderer.invoke('note:delete', index, day),
    edit: (index, text, day) => ipcRenderer.invoke('note:edit', index, text, day),
    sprintWindow: date => ipcRenderer.invoke('sprint:window', date),
    generateSprint: opts => ipcRenderer.invoke('sprint:generate', opts),
    generateMonth: opts => ipcRenderer.invoke('month:generate', opts),
    gitCommits: date => ipcRenderer.invoke('git:commits', date),
    copyText: text => ipcRenderer.invoke('clipboard:write', text),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    saveSettings: opts => ipcRenderer.invoke('settings:save', opts),
    close: () => ipcRenderer.send('win:close'),
});

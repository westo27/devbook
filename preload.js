'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    append: (text, time, day) => ipcRenderer.invoke('note:append', text, time, day),
    read: day => ipcRenderer.invoke('note:read', day),
    delete: (index, expected, day) => ipcRenderer.invoke('note:delete', index, expected, day),
    edit: (index, expected, text, day) => ipcRenderer.invoke('note:edit', index, expected, text, day),
    insert: (index, text, day) => ipcRenderer.invoke('note:insert', index, text, day),
    onNotesChanged: cb => ipcRenderer.on('notes:changed', (_e, filename) => cb(filename)),
    sprintWindow: date => ipcRenderer.invoke('sprint:window', date),
    generateSprint: opts => ipcRenderer.invoke('sprint:generate', opts),
    generateMonth: opts => ipcRenderer.invoke('month:generate', opts),
    gitCommits: date => ipcRenderer.invoke('git:commits', date),
    copyText: text => ipcRenderer.invoke('clipboard:write', text),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    saveSettings: opts => ipcRenderer.invoke('settings:save', opts),
});

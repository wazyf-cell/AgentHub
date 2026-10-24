const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("agentHub", {
  settings: () => ipcRenderer.invoke("room:settings"),
  pickWorkspace: () => ipcRenderer.invoke("room:pick-workspace"),
  listRooms: () => ipcRenderer.invoke("room:list"),
  showRoom: (roomId) => ipcRenderer.invoke("room:show", roomId),
  events: (roomId) => ipcRenderer.invoke("room:events", roomId),
  platforms: () => ipcRenderer.invoke("room:platforms"),
  models: () => ipcRenderer.invoke("room:models"),
  capabilities: () => ipcRenderer.invoke("room:capabilities"),
  syncModels: () => ipcRenderer.invoke("room:models-sync"),
  initRoom: (input) => ipcRenderer.invoke("room:init", input),
  updateRoom: (roomId, room) => ipcRenderer.invoke("room:update", { roomId, room }),
  run: (input) => ipcRenderer.invoke("room:run", input),
  stop: () => ipcRenderer.invoke("room:stop"),
  openPath: (targetPath) => ipcRenderer.invoke("local:open-path", targetPath),
  openLegacy: () => ipcRenderer.invoke("room:open-legacy"),
  onRunEvent: (callback) => subscribe("room:run-event", callback),
  onRunLog: (callback) => subscribe("room:run-log", callback),
  onRunFinished: (callback) => subscribe("room:run-finished", callback),
});

// The legacy batch-runner page still loads with this preload.
contextBridge.exposeInMainWorld("agentSpaceLocal", {
  settings: () => ipcRenderer.invoke("local:settings"),
  init: () => ipcRenderer.invoke("local:init"),
  detect: () => ipcRenderer.invoke("local:detect"),
  run: (input) => ipcRenderer.invoke("local:run", input),
  cancel: () => ipcRenderer.invoke("local:cancel"),
  openPath: (targetPath) => ipcRenderer.invoke("local:open-path", targetPath),
  onRunEvent: (callback) => subscribe("local:run-event", callback),
  onRunLog: (callback) => subscribe("local:run-log", callback),
});

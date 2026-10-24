const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentSpaceLocal", {
  settings: () => ipcRenderer.invoke("local:settings"),
  init: () => ipcRenderer.invoke("local:init"),
  detect: () => ipcRenderer.invoke("local:detect"),
  run: (input) => ipcRenderer.invoke("local:run", input),
  cancel: () => ipcRenderer.invoke("local:cancel"),
  openPath: (targetPath) => ipcRenderer.invoke("local:open-path", targetPath),
  onRunEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("local:run-event", listener);
    return () => ipcRenderer.removeListener("local:run-event", listener);
  },
  onRunLog: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("local:run-log", listener);
    return () => ipcRenderer.removeListener("local:run-log", listener);
  },
});

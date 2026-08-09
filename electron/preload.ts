import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS, type AgentManagerApi, type ManagerEvent, type StartSessionRequest } from '../src/shared/manager-api'

const api: AgentManagerApi = {
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.listSessions),
  startSession: (request: StartSessionRequest) => ipcRenderer.invoke(IPC_CHANNELS.startSession, request),
  write: (sessionId, data) => ipcRenderer.invoke(IPC_CHANNELS.write, sessionId, data),
  resize: (sessionId, cols, rows) => ipcRenderer.invoke(IPC_CHANNELS.resize, sessionId, cols, rows),
  stopSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.stopSession, sessionId),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: ManagerEvent): void => listener(message)
    ipcRenderer.on(IPC_CHANNELS.event, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.event, handler)
  },
}

contextBridge.exposeInMainWorld('agentManager', api)

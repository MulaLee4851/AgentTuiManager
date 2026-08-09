/// <reference types="vite/client" />

import type { AgentManagerApi } from './shared/manager-api'

declare global {
  interface Window { agentManager: AgentManagerApi }
}

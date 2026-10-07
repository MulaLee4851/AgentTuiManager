import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

import App from './App'
import { AppearanceProvider } from './appearance-settings'
import './ui-typography.css'

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')
createRoot(root).render(<StrictMode><AppearanceProvider><App /></AppearanceProvider></StrictMode>)

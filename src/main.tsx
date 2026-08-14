import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
// Explicit SW registration (see vite.config.ts's `injectRegister: false`):
// the plugin's own auto-injected registration script is what's disabled by
// that option, not this virtual module — this is the documented replacement
// for it. `devOptions.enabled` (vite.config.ts) makes this register against
// the real dev-sw.js in `npm run dev`, not just production builds.
import { registerSW } from 'virtual:pwa-register'

import './i18n'
import './index.css'
import App from './App'
import { AuthProvider } from '@/lib/auth/AuthProvider'
import { ToastProvider } from '@/components/ui'

// registerType: 'prompt' (vite.config.ts) — this never force-reloads on its
// own; update-prompt UI is future work (see PROGRESS.md), not in scope here.
registerSW()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)

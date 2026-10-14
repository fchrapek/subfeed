import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './lib/sw'
import App from './App'
import { PlayerProvider } from './components/Player'
import { SheetProvider } from './components/Sheet'
import './styles.css'

// Ask the browser not to evict our on-device state under storage pressure, so
// channels / watched / queue reliably survive restarts (best-effort; installed
// PWAs are usually granted this automatically).
if (navigator.storage?.persist) {
  void navigator.storage.persisted().then((granted) => {
    if (!granted) void navigator.storage.persist()
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SheetProvider>
      <PlayerProvider>
        <App />
      </PlayerProvider>
    </SheetProvider>
  </StrictMode>,
)

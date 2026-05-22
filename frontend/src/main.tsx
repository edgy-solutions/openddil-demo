import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import Root from './Root.tsx'
import { loadBranding } from './branding'

// Apply optional customer branding (title + favicon) before the first
// render so the nav bar and tab title paint correctly on the first frame.
loadBranding().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  )
})

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import Root from './Root.tsx'
import { loadDeployment } from './deployment'

// Apply optional deployment config (title + favicon) before the first
// render so the nav bar and tab title paint correctly on the first frame.
loadDeployment().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  )
})

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import SourcesPane from './components/SourcesPane'

const assetId = new URLSearchParams(window.location.search).get('asset_id') ?? ''

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SourcesPane assetId={assetId} />
  </StrictMode>,
)

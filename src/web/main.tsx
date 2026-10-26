import { createRoot } from 'react-dom/client'
import WebApp from './App'
import { BrowserSession } from './session'
import { loadWebConfig } from './config'
import '../renderer/style.css'
import './style.css'

void loadWebConfig().then(config => {
  const session = new BrowserSession({ ...config, origin: location.origin })
  createRoot(document.getElementById('root')!).render(<WebApp session={session} />)
})

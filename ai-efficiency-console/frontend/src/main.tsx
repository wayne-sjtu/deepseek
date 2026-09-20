import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ScopeProvider } from './lib/ScopeContext'
import './styles/index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <ScopeProvider>
        <App />
      </ScopeProvider>
    </BrowserRouter>
  </React.StrictMode>,
)

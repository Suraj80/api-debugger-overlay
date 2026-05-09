import React from 'react'
import { createRoot } from 'react-dom/client'

function Popup() {
  return (
    <div style={{ width: 300, padding: 16, fontFamily: 'sans-serif' }}>
      <h2 style={{ margin: 0, fontSize: 14 }}>API Debugger Overlay</h2>
      <p style={{ fontSize: 12, color: '#666' }}>Settings coming in Week 3.</p>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Popup />)

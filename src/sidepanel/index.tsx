import React from 'react'
import { createRoot } from 'react-dom/client'

function SidePanel() {
  return (
    <div style={{ padding: 16, fontFamily: 'sans-serif' }}>
      <h2 style={{ margin: 0, fontSize: 14 }}>Session Dashboard</h2>
      <p style={{ fontSize: 12, color: '#666' }}>Dependency map coming in Week 4.</p>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<SidePanel />)

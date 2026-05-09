import React, { useState, useEffect } from 'react'

export interface RequestEntry {
  id: string
  url: string
  method: string
  status: number
  duration: number
}

export function Overlay() {
  const [requests, setRequests] = useState<RequestEntry[]>([])
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const handler = (msg: any) => {
      if (msg.type === 'REQUEST_COMPLETE') {
        setRequests(prev => [msg.payload, ...prev].slice(0, 100))
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  if (!visible) return (
    <button onClick={() => setVisible(true)}>API</button>
  )

  return (
    <div style={{ position:'fixed', bottom:16, right:16,
      width:360, maxHeight:'60vh', overflow:'auto',
      background:'#0F172A', color:'#F8FAFC',
      borderRadius:12, zIndex:2147483647,
      fontFamily:'monospace', fontSize:12 }}>
      <div style={{ padding:'10px 12px', borderBottom:'1px solid #1E293B',
        display:'flex', justifyContent:'space-between' }}>
        <span>API Debugger ({requests.length})</span>
        <button onClick={() => setVisible(false)}>✕</button>
      </div>
      {requests.map(r => (
        <div key={r.id} style={{ padding:'8px 12px', borderBottom:'1px solid #1E293B' }}>
          <span style={{ color: r.status >= 400 ? '#F87171' : '#34D399' }}>
            {r.status}
          </span>
          {' '}{r.method}{' '}{r.url.slice(0, 40)}
          <span style={{ float:'right', color:'#94A3B8' }}>{r.duration}ms</span>
        </div>
      ))}
    </div>
  )
}
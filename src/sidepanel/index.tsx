import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { RequestEntry } from '../shared/types'
import '../index.css'

type Tab = 'session' | 'deps' | 'replay'
type DiffLine = { text: string; kind: 'same' | 'add' | 'del' }

const SAMPLE_REQUESTS: RequestEntry[] = [
  createSampleRequest('/api/users', 'GET', 200, 142),
  createSampleRequest('/api/users/42', 'GET', 200, 486, ['/api/users']),
  createSampleRequest('/api/orders?user=42', 'GET', 200, 860, ['/api/users/42']),
  createSampleRequest('/api/recommendations', 'POST', 201, 1710, ['/api/users/42']),
  createSampleRequest('/api/billing/session', 'GET', 500, 1320),
]

export function SidePanel() {
  const [tab, setTab] = useState<Tab>('session')
  const [requests] = useState<RequestEntry[]>(SAMPLE_REQUESTS)

  return (
    <div className="api-theme-shell api-sidepanel">
      <header className="api-sidepanel-header">
        <span className="api-sidepanel-title">API Debugger</span>
        <button className="api-sidepanel-close" title="Close">x</button>
      </header>

      <nav className="api-sidepanel-tabs">
        {([
          ['session', 'Session'],
          ['deps', 'Dependency Map'],
          ['replay', 'Replay'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            className={`api-sidepanel-tab${tab === key ? ' is-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="api-sidepanel-content api-scroll">
        {tab === 'session' && <SessionTab requests={requests} />}
        {tab === 'deps' && <DependencyTab requests={requests} />}
        {tab === 'replay' && <ReplayTab />}
      </main>
    </div>
  )
}

function SessionTab({ requests }: { requests: RequestEntry[] }) {
  const total = requests.length
  const avg = total ? Math.round(requests.reduce((sum, r) => sum + r.duration, 0) / total) : 0
  const errors = requests.filter(r => r.status >= 400).length
  const errorRate = total ? Math.round((errors / total) * 1000) / 10 : 0
  const perMin = Math.round(total * 1.2)
  const avgColor = avg < 500 ? 'var(--api-success)' : avg < 1500 ? 'var(--api-warning)' : 'var(--api-danger)'
  const errColor = errorRate === 0 ? 'var(--api-success)' : errorRate <= 5 ? 'var(--api-warning)' : 'var(--api-danger)'

  const byEndpoint = new Map<string, { method: string; url: string; total: number; count: number }>()
  requests.forEach(request => {
    const path = getPath(request.url)
    const key = `${request.method} ${path}`
    const entry = byEndpoint.get(key) ?? { method: request.method, url: path, total: 0, count: 0 }
    entry.total += request.duration
    entry.count += 1
    byEndpoint.set(key, entry)
  })

  const worst = Array.from(byEndpoint.values())
    .map(entry => ({ ...entry, avg: Math.round(entry.total / entry.count) }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5)

  return (
    <div>
      <div className="api-sidepanel-card-grid">
        <StatCard title="Total Requests" value={String(total)} subtext={`${perMin}/min`} />
        <StatCard title="Avg Latency" value={formatMs(avg)} subtext="time to response" valueColor={avgColor} />
        <StatCard title="Error Rate" value={`${errorRate}%`} subtext="4xx + 5xx / total" valueColor={errColor} />
      </div>

      <section className="api-sidepanel-section">
        <SectionHeading>Latency Timeline</SectionHeading>
        <LatencyChart requests={requests} />
      </section>

      <section className="api-sidepanel-section">
        <SectionHeading>Worst Offenders</SectionHeading>
        {worst.length === 0 && <div className="api-muted">No data yet.</div>}
        {worst.map((entry, index) => (
          <div className="api-offender-row" key={`${entry.url}-${index}`}>
            <span className="api-offender-index">{index + 1}</span>
            <MethodPill method={entry.method} />
            <span className="api-offender-path">{entry.url}</span>
            <span style={{ color: 'var(--api-danger)', fontSize: 12, fontWeight: 750 }}>{formatMs(entry.avg)}</span>
          </div>
        ))}
      </section>

      <section className="api-sidepanel-section">
        <button className="api-primary-wide">Export Session Report</button>
      </section>
    </div>
  )
}

function DependencyTab({ requests }: { requests: RequestEntry[] }) {
  const { nodes, edges } = useMemo(() => {
    const map = new Map<string, { id: string; label: string; count: number; totalLatency: number }>()

    requests.forEach(request => {
      const path = getPath(request.url)
      const segments = path.split('/').filter(Boolean)
      const label = `/${segments[segments.length - 1] ?? ''}`
      const entry = map.get(path) ?? { id: path, label, count: 0, totalLatency: 0 }
      entry.count += 1
      entry.totalLatency += request.duration
      map.set(path, entry)
    })

    const edgeList: { from: string; to: string; latency: number }[] = []
    requests.forEach(request => {
      const to = getPath(request.url)
      request.dependsOn.forEach(source => {
        const from = getPath(source)
        if (map.has(from) && map.has(to)) edgeList.push({ from, to, latency: request.duration })
      })
    })

    return { nodes: Array.from(map.values()), edges: edgeList }
  }, [requests])

  if (nodes.length < 2 || edges.length === 0) {
    return (
      <section className="api-sidepanel-section">
        <SectionHeading>API Dependency Graph</SectionHeading>
        <p className="api-muted">Nodes = endpoints. Edges = inferred call chains. Node size = call frequency.</p>
        <div className="api-dependency-empty">
          <DependencyGhost />
          <div style={{ fontSize: 13 }}>No dependencies mapped yet</div>
          <div style={{ color: 'var(--api-border-strong)', fontSize: 12 }}>Relationships appear after connected requests are captured.</div>
        </div>
      </section>
    )
  }

  const width = 360
  const height = 360
  const centerX = width / 2
  const centerY = height / 2
  const positions = new Map<string, { x: number; y: number }>()

  nodes.forEach((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2
    const radius = 130
    positions.set(node.id, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    })
  })

  return (
    <section className="api-sidepanel-section">
      <SectionHeading>API Dependency Graph</SectionHeading>
      <p className="api-muted">Nodes = endpoints. Edges = inferred call chains. Node size = call frequency.</p>
      <svg viewBox={`0 0 ${width} ${height}`} className="api-dependency-graph">
        {edges.map((edge, index) => {
          const start = positions.get(edge.from)
          const end = positions.get(edge.to)
          if (!start || !end) return null
          const color = latencyColor(edge.latency)
          return (
            <line
              key={index}
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              stroke={color}
              strokeWidth="1.5"
            />
          )
        })}
        {nodes.map(node => {
          const position = positions.get(node.id)
          if (!position) return null
          const radius = Math.min(24, 8 + node.count * 2)

          return (
            <g key={node.id}>
              <circle cx={position.x} cy={position.y} r={radius} fill="var(--api-surface)" stroke="var(--api-color-primary-soft)" strokeWidth="1.5">
                <title>{node.id}</title>
              </circle>
              <text x={position.x} y={position.y + radius + 12} fontSize="10" fill="var(--api-text-muted)" textAnchor="middle" fontFamily="ui-monospace, monospace">
                {node.label}
              </text>
            </g>
          )
        })}
        <g transform={`translate(8, ${height - 56})`} fontSize="10" fill="var(--api-text-subtle)">
          <line x1="0" y1="6" x2="20" y2="6" stroke="var(--api-success)" strokeWidth="1.5" />
          <text x="26" y="9">Fast under 500ms</text>
          <line x1="0" y1="22" x2="20" y2="22" stroke="var(--api-warning)" strokeWidth="1.5" />
          <text x="26" y="25">Slow 500ms+</text>
          <line x1="0" y1="38" x2="20" y2="38" stroke="var(--api-danger)" strokeWidth="1.5" />
          <text x="26" y="41">Very slow 1.5s+</text>
        </g>
      </svg>
    </section>
  )
}

function ReplayTab() {
  const [method, setMethod] = useState('GET')
  const [url, setUrl] = useState('https://api.example.com/users/42')
  const [headers, setHeaders] = useState<{ k: string; v: string }[]>([{ k: 'Authorization', v: 'Bearer ...' }])
  const [body, setBody] = useState('{\n  "name": "Ada"\n}')
  const [sending, setSending] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const lineNumbers = body.split('\n').map((_, index) => index + 1)

  const send = () => {
    setSending(true)
    window.setTimeout(() => {
      setSending(false)
      setShowDiff(true)
    }, 900)
  }

  const diff = computeDiff(
    '{\n  "id": 42,\n  "name": "Ada",\n  "email": "ada@old.com",\n  "active": true\n}',
    '{\n  "id": 42,\n  "name": "Ada",\n  "email": "ada@new.com",\n  "role": "admin",\n  "active": true\n}',
  )

  return (
    <div className="api-replay">
      <div className="api-replay-row">
        <select className="api-replay-select api-replay-method" value={method} onChange={event => setMethod(event.target.value)}>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(item => <option key={item}>{item}</option>)}
        </select>
        <input className="api-replay-input" value={url} onChange={event => setUrl(event.target.value)} />
      </div>

      <div>
        <SectionHeading>Headers</SectionHeading>
        {headers.map((header, index) => (
          <div className="api-header-row" key={index} style={{ marginBottom: 6 }}>
            <input
              className="api-replay-input"
              value={header.k}
              placeholder="Key"
              onChange={event => {
                const next = [...headers]
                next[index] = { ...next[index], k: event.target.value }
                setHeaders(next)
              }}
            />
            <input
              className="api-replay-input"
              value={header.v}
              placeholder="Value"
              onChange={event => {
                const next = [...headers]
                next[index] = { ...next[index], v: event.target.value }
                setHeaders(next)
              }}
            />
            <button className="api-sidepanel-plain" onClick={() => setHeaders(headers.filter((_, headerIndex) => headerIndex !== index))}>x</button>
          </div>
        ))}
        <button className="api-sidepanel-plain" onClick={() => setHeaders([...headers, { k: '', v: '' }])}>+ Add header</button>
      </div>

      <div>
        <SectionHeading>Body</SectionHeading>
        <div className="api-body-editor">
          <div className="api-line-numbers">
            {lineNumbers.map(number => <div key={number}>{number}</div>)}
          </div>
          <textarea className="api-replay-textarea" value={body} onChange={event => setBody(event.target.value)} />
        </div>
      </div>

      <button className="api-primary-wide" onClick={send} disabled={sending}>
        {sending && <span className="api-spinner" />}
        Send Request
      </button>

      {showDiff ? (
        <div className="api-diff-grid">
          <DiffPanel title="Original Response" lines={diff.left} />
          <DiffPanel title="New Response" lines={diff.right} />
        </div>
      ) : (
        <div className="api-replay-empty">
          <span style={{ color: 'var(--api-border-strong)', fontSize: 32 }}>↻</span>
          <div style={{ fontSize: 13 }}>No replay yet</div>
          <div style={{ color: 'var(--api-border-strong)', fontSize: 11 }}>Right-click any request in the overlay.</div>
        </div>
      )}
    </div>
  )
}

function StatCard({ title, value, subtext, valueColor = 'var(--api-text)' }: { title: string; value: string; subtext: string; valueColor?: string }) {
  return (
    <div className="api-stat-card">
      <div className="api-stat-title">{title}</div>
      <div className="api-stat-value" style={{ '--stat-color': valueColor } as React.CSSProperties}>{value}</div>
      <div className="api-stat-subtext">{subtext}</div>
    </div>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <div className="api-section-heading">{children}</div>
}

function LatencyChart({ requests }: { requests: RequestEntry[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<{ x: number; y: number; r: RequestEntry } | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    const dpr = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    canvas.width = width * dpr
    canvas.height = height * dpr

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const styles = getComputedStyle(canvas)
    const primary = styles.getPropertyValue('--api-color-primary-soft').trim() || '#cbb8ff'
    const border = styles.getPropertyValue('--api-border-strong').trim() || '#5d536b'
    const success = styles.getPropertyValue('--api-success').trim() || '#8fe6bc'
    const warning = styles.getPropertyValue('--api-warning').trim() || '#ffd36f'
    const danger = styles.getPropertyValue('--api-danger').trim() || '#ff8f8f'

    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    if (requests.length === 0) return

    const max = Math.max(...requests.map(request => request.duration), 2000)
    ;[500, 1500].forEach(threshold => {
      const y = height - (threshold / max) * (height - 16) - 8
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = border
      ctx.globalAlpha = 0.35
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
    })

    ctx.globalAlpha = 1
    ctx.setLineDash([])

    const points = requests.map((request, index) => ({
      x: (index / Math.max(1, requests.length - 1)) * (width - 16) + 8,
      y: height - (request.duration / max) * (height - 16) - 8,
      request,
    }))

    ctx.strokeStyle = primary
    ctx.globalAlpha = 0.45
    ctx.lineWidth = 1
    ctx.beginPath()
    points.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)))
    ctx.stroke()
    ctx.globalAlpha = 1

    points.forEach(point => {
      ctx.beginPath()
      ctx.arc(point.x, point.y, 3, 0, Math.PI * 2)
      ctx.fillStyle = point.request.status >= 400 ? warning : point.request.isSlow ? danger : success
      ctx.fill()
    })
  }, [requests])

  return (
    <div className="api-latency-chart">
      <canvas
        ref={ref}
        onMouseMove={event => {
          const rect = event.currentTarget.getBoundingClientRect()
          const x = event.clientX - rect.left
          const index = Math.round((x / rect.width) * (requests.length - 1))
          const request = requests[index]
          if (request) setHover({ x: event.clientX, y: event.clientY, r: request })
        }}
        onMouseLeave={() => setHover(null)}
      />
      {hover && (
        <div className="api-chart-tooltip" style={{ top: hover.y - 56, left: hover.x + 8 }}>
          <div>{getPath(hover.r.url).slice(0, 30)}</div>
          <div style={{ color: 'var(--api-text-muted)' }}>{Math.round(hover.r.duration)}ms - {hover.r.status}</div>
        </div>
      )}
    </div>
  )
}

function MethodPill({ method }: { method: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    GET: { bg: 'rgba(203, 184, 255, 0.18)', color: 'var(--api-color-primary-soft)' },
    POST: { bg: 'rgba(143, 230, 188, 0.14)', color: 'var(--api-success)' },
    PUT: { bg: 'rgba(201, 167, 77, 0.2)', color: 'var(--api-warning)' },
    PATCH: { bg: 'rgba(128, 105, 191, 0.26)', color: 'var(--api-color-secondary-soft)' },
    DELETE: { bg: 'rgba(255, 143, 143, 0.15)', color: 'var(--api-danger)' },
  }
  const color = colors[method.toUpperCase()] ?? colors.GET

  return <span className="api-method-pill" style={{ '--method-bg': color.bg, '--method-color': color.color } as React.CSSProperties}>{method}</span>
}

function DependencyGhost() {
  return (
    <svg width="120" height="80" viewBox="0 0 120 80">
      <circle cx="20" cy="40" r="10" fill="none" stroke="var(--api-border-strong)" strokeWidth="1.5" strokeDasharray="3 3" />
      <circle cx="60" cy="20" r="10" fill="none" stroke="var(--api-border-strong)" strokeWidth="1.5" strokeDasharray="3 3" />
      <circle cx="60" cy="60" r="10" fill="none" stroke="var(--api-border-strong)" strokeWidth="1.5" strokeDasharray="3 3" />
      <circle cx="100" cy="40" r="10" fill="none" stroke="var(--api-border-strong)" strokeWidth="1.5" strokeDasharray="3 3" />
      <line x1="30" y1="40" x2="50" y2="22" stroke="var(--api-border-strong)" strokeDasharray="3 3" />
      <line x1="30" y1="40" x2="50" y2="58" stroke="var(--api-border-strong)" strokeDasharray="3 3" />
      <line x1="70" y1="22" x2="90" y2="38" stroke="var(--api-border-strong)" strokeDasharray="3 3" />
      <line x1="70" y1="58" x2="90" y2="42" stroke="var(--api-border-strong)" strokeDasharray="3 3" />
    </svg>
  )
}

function DiffPanel({ title, lines }: { title: string; lines: DiffLine[] }) {
  return (
    <div className="api-diff-panel">
      <div className="api-diff-title">{title}</div>
      <pre className="api-diff-code">
        {lines.map((line, index) => (
          <div key={index} className={`api-diff-line${line.kind === 'add' ? ' is-add' : ''}${line.kind === 'del' ? ' is-del' : ''}`}>
            {line.kind === 'del' ? '- ' : line.kind === 'add' ? '+ ' : '  '}
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  )
}

function computeDiff(a: string, b: string): { left: DiffLine[]; right: DiffLine[] } {
  const leftLines = a.split('\n')
  const rightLines = b.split('\n')
  const leftSet = new Set(leftLines)
  const rightSet = new Set(rightLines)

  return {
    left: leftLines.map(text => ({ text, kind: rightSet.has(text) ? 'same' : 'del' })),
    right: rightLines.map(text => ({ text, kind: leftSet.has(text) ? 'same' : 'add' })),
  }
}

function createSampleRequest(path: string, method: string, status: number, duration: number, dependsOn: string[] = []): RequestEntry {
  return {
    id: `${method}-${path}-${duration}`,
    url: `https://api.example.com${path}`,
    method,
    status,
    duration,
    startTime: performance.now(),
    requestSize: 128,
    responseSize: 2048,
    requestHeaders: { Accept: 'application/json' },
    responseBody: '{"ok":true}',
    isDuplicate: false,
    isSlow: duration > 1500,
    aiSuggestion: null,
    dependsOn: dependsOn.map(item => `https://api.example.com${item}`),
    fingerprint: `${method}:${path}`,
    ttfb: Math.round(duration * 0.4),
  }
}

function getPath(url: string) {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function formatMs(ms: number) {
  return ms > 999 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function latencyColor(ms: number) {
  if (ms < 500) return 'var(--api-success)'
  if (ms < 1500) return 'var(--api-warning)'
  return 'var(--api-danger)'
}

createRoot(document.getElementById('root')!).render(<SidePanel />)

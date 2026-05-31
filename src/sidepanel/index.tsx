/* eslint-disable react-refresh/only-export-components */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { ReplayRequest, ReplayResult, ReplayTargetSnapshot, RequestEntry, SessionSnapshot } from '../shared/types'
import { getSettings } from '../shared/settings'
import '../index.css'

type Tab = 'session' | 'deps' | 'replay'
type DiffLine = { text: string; kind: 'same' | 'add' | 'del' }
type DependencyGraphNode = {
  id: string
  label: string
  count: number
  incoming: number
  outgoing: number
  level: number
}
type DependencyGraphEdge = {
  from: string
  to: string
  latency: number
  count: number
}
type DependencyGraphLayoutNode = DependencyGraphNode & {
  x: number
  y: number
}
const MAX_DEPENDENCY_GRAPH_REQUESTS = 50
type SessionUpdatedMessage = {
  type: 'SESSION_UPDATED'
  tabId: number
  payload: RequestEntry[]
}
type ReplayTargetSelectedMessage = {
  type: 'REPLAY_TARGET_SELECTED'
  tabId: number
  payload: ReplayRequest
}
type DependenciesUpdatedMessage = {
  type: 'DEPENDENCIES_UPDATED'
  payload: {
    requestId: string
    dependsOn: string[]
  }
}

declare global {
  interface Window {
    __apiDebuggerSidePanelRoot?: Root
  }
}

function isSessionUpdatedMessage(message: unknown): message is SessionUpdatedMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type?: unknown }).type === 'SESSION_UPDATED' &&
    'tabId' in message &&
    'payload' in message
  )
}

function isReplayTargetSelectedMessage(message: unknown): message is ReplayTargetSelectedMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type?: unknown }).type === 'REPLAY_TARGET_SELECTED' &&
    'tabId' in message &&
    'payload' in message
  )
}

function isDependenciesUpdatedMessage(message: unknown): message is DependenciesUpdatedMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type?: unknown }).type === 'DEPENDENCIES_UPDATED' &&
    'payload' in message
  )
}

export function SidePanel() {
  const [tab, setTab] = useState<Tab>('session')
  const [sessionTabId, setSessionTabId] = useState<number | null>(null)
  const [requests, setRequests] = useState<RequestEntry[]>([])
  const [replayTarget, setReplayTarget] = useState<ReplayRequest | null>(null)

  useEffect(() => {
    let cancelled = false

    const loadSession = () => {
      chrome.runtime.sendMessage({ type: 'GET_SESSION' }).then((snapshot: SessionSnapshot | undefined) => {
        if (cancelled || !snapshot) return

        setSessionTabId(snapshot.tabId)
        setRequests(snapshot.requests)
      }).catch(() => {
        if (cancelled) return

        setSessionTabId(null)
        setRequests([])
      })

      chrome.runtime.sendMessage({ type: 'GET_REPLAY_TARGET' }).then((snapshot: ReplayTargetSnapshot | undefined) => {
        if (cancelled || !snapshot) return

        setSessionTabId(currentTabId => currentTabId ?? snapshot.tabId)
        setReplayTarget(snapshot.request)
        if (snapshot.request) {
          setTab('replay')
        }
      }).catch(() => {
        if (!cancelled) setReplayTarget(null)
      })
    }

    const handleMessage = (message: unknown) => {
      if (isReplayTargetSelectedMessage(message)) {
        setSessionTabId(message.tabId)
        setReplayTarget(message.payload)
        setTab('replay')
        return
      }

      if (isDependenciesUpdatedMessage(message)) {
        setRequests(currentRequests => currentRequests.map(request => (
          request.id === message.payload.requestId
            ? { ...request, dependsOn: message.payload.dependsOn }
            : request
        )))
        return
      }

      if (!isSessionUpdatedMessage(message)) return

      setSessionTabId(currentTabId => {
        if (currentTabId === message.tabId || currentTabId == null) {
          setRequests(message.payload)
          return message.tabId
        }

        return currentTabId
      })
    }

    loadSession()
    chrome.runtime.onMessage.addListener(handleMessage)
    window.addEventListener('focus', loadSession)
    document.addEventListener('visibilitychange', loadSession)

    return () => {
      cancelled = true
      chrome.runtime.onMessage.removeListener(handleMessage)
      window.removeEventListener('focus', loadSession)
      document.removeEventListener('visibilitychange', loadSession)
    }
  }, [])

  return (
    <div className="api-theme-shell api-sidepanel">
      <nav className="api-sidepanel-tabs" aria-label="Side panel views">
        {([
          ['session', 'Session'],
          ['deps', 'Dependency Map'],
          ['replay', 'Replay'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            className={`api-sidepanel-tab${tab === key ? ' is-active' : ''}`}
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="api-sidepanel-content api-scroll">
        {tab === 'session' && <SessionTab requests={requests} />}
        {tab === 'deps' && <DependencyTab requests={requests} />}
        {tab === 'replay' && (
          <ReplayTab
            key={replayTarget?.id ?? 'empty-replay'}
            tabId={sessionTabId}
            request={replayTarget}
            originalRequest={requests.find(candidate => candidate.id === replayTarget?.id) ?? null}
          />
        )}
      </main>
    </div>
  )
}

function SessionTab({ requests }: { requests: RequestEntry[] }) {
  const [exportStatus, setExportStatus] = useState('')
  const total = requests.length
  const avg = total ? Math.round(requests.reduce((sum, r) => sum + r.duration, 0) / total) : 0
  const errors = requests.filter(r => r.status >= 400).length
  const errorRate = total ? Math.round((errors / total) * 1000) / 10 : 0
  const perMin = Math.round(total * 1.2)
  const avgColor = latencyColor(avg)
  const errColor = errorRate === 0 ? 'var(--api-success)' : errorRate <= 5 ? 'var(--api-warning)' : 'var(--api-danger)'

  const byEndpoint = new Map<string, { method: string; url: string; total: number; ttfbTotal: number; ttfbCount: number; count: number }>()
  requests.forEach(request => {
    const path = getPath(request.url)
    const key = `${request.method} ${path}`
    const entry = byEndpoint.get(key) ?? { method: request.method, url: path, total: 0, ttfbTotal: 0, ttfbCount: 0, count: 0 }
    entry.total += request.duration
    if (request.ttfb > 0) {
      entry.ttfbTotal += request.ttfb
      entry.ttfbCount += 1
    }
    entry.count += 1
    byEndpoint.set(key, entry)
  })

  const worst = Array.from(byEndpoint.values())
    .map(entry => ({
      ...entry,
      avg: Math.round(entry.total / entry.count),
      avgTtfb: entry.ttfbCount > 0 ? Math.round(entry.ttfbTotal / entry.ttfbCount) : 0,
    }))
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
            <span style={{ color: 'var(--api-text-subtle)', fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
              TTFB {entry.avgTtfb > 0 ? formatMs(entry.avgTtfb) : '-'}
            </span>
            <span style={{ color: latencyColor(entry.avg), fontSize: 12, fontWeight: 750 }}>{formatMs(entry.avg)}</span>
          </div>
        ))}
      </section>

      <section className="api-sidepanel-section">
        <button
          className="api-primary-wide"
          onClick={() => {
            setExportStatus('')
            exportSessionReport(requests)
              .then(filename => {
                setExportStatus(`Saved ${filename}`)
                window.setTimeout(() => setExportStatus(''), 3500)
              })
              .catch(error => {
                setExportStatus(`Export failed: ${error instanceof Error ? error.message : String(error)}`)
              })
          }}
          disabled={requests.length === 0}
        >
          Export Session Report
        </button>
        {exportStatus && (
          <div className="api-muted" style={{ marginTop: 8, fontSize: 12 }}>
            {exportStatus}
          </div>
        )}
      </section>
    </div>
  )
}

function DependencyTab({ requests }: { requests: RequestEntry[] }) {
  const graph = useMemo(() => buildDependencyGraph(requests), [requests])
  const { nodes, edges } = graph

  if (edges.length === 0) {
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
  const height = 420
  const positions = new Map(
    buildDependencyLayout(nodes, width, height, {
      top: 48,
      right: 34,
      bottom: 62,
      left: 34,
    }).map(node => [node.id, node]),
  )

  return (
    <section className="api-sidepanel-section">
      <SectionHeading>API Dependency Graph</SectionHeading>
      <p className="api-muted">Grouped by endpoint path. Only connected endpoints are shown. Top rows are root calls; lower rows are downstream dependents.</p>
      <svg viewBox={`0 0 ${width} ${height}`} className="api-dependency-graph" role="img" aria-label={`API dependency graph with ${nodes.length} endpoints and ${edges.length} inferred dependencies`}>
        <desc>Directed edges show inferred request chains. Node size represents call frequency and edge color represents average latency.</desc>
        <defs>
          <marker id="api-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="var(--api-border-strong)" />
          </marker>
        </defs>
        {edges.map((edge, index) => {
          const start = positions.get(edge.from)
          const end = positions.get(edge.to)
          if (!start || !end) return null
          const color = latencyColor(edge.latency)
          const curveY = start.y + (end.y - start.y) * 0.45
          const path = `M ${start.x.toFixed(1)} ${(start.y + Math.min(20, 8 + start.count * 1.5)).toFixed(1)} C ${start.x.toFixed(1)} ${curveY.toFixed(1)} ${end.x.toFixed(1)} ${(curveY + 10).toFixed(1)} ${end.x.toFixed(1)} ${(end.y - Math.min(20, 8 + end.count * 1.5)).toFixed(1)}`

          return (
            <g key={`${edge.from}-${edge.to}-${index}`}>
              <path
                d={path}
                fill="none"
                stroke={color}
                strokeWidth={Math.min(3.2, 1.4 + edge.count * 0.35)}
                markerEnd="url(#api-arrow)"
                opacity="0.9"
              />
              <title>{getEndpointLabel(edge.from)} to {getEndpointLabel(edge.to)} - {edge.count} call chain(s), avg {formatMs(edge.latency)}</title>
            </g>
          )
        })}
        {nodes.map(node => {
          const position = positions.get(node.id)
          if (!position) return null

          return (
            <DependencyNode
              key={node.id}
              x={position.x}
              y={position.y}
              radius={Math.min(20, 8 + node.count * 1.5)}
              label={node.label}
              fullPath={node.id}
              count={node.count}
            />
          )
        })}
        <g transform={`translate(10, 18)`} fontSize="9" fill="var(--api-text-subtle)">
          <text x="0" y="0">Roots</text>
          <text x={width - 74} y="0">Downstream</text>
        </g>
        <g transform={`translate(12, ${height - 22})`} fontSize="10" fill="var(--api-text-subtle)">
          <line x1="0" y1="6" x2="20" y2="6" stroke="#22C55E" strokeWidth="1.5" />
          <text x="26" y="9">Fast under 500ms</text>
          <line x1="136" y1="6" x2="156" y2="6" stroke="#F59E0B" strokeWidth="1.5" />
          <text x="162" y="9">Slow 500ms+</text>
          <line x1="270" y1="6" x2="290" y2="6" stroke="#EF4444" strokeWidth="1.5" />
          <text x="296" y="9">Very slow 1.5s+</text>
        </g>
      </svg>
      <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
        {edges.slice(0, 8).map(edge => (
          <div key={`${edge.from}-${edge.to}`} className="api-muted" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 8, alignItems: 'center', fontSize: 11 }}>
            <span title={edge.from} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getEndpointLabel(edge.from)}</span>
            <span style={{ color: latencyColor(edge.latency), fontFamily: 'ui-monospace, monospace' }}>{'->'} {formatMs(edge.latency)}</span>
            <span title={edge.to} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getEndpointLabel(edge.to)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function DependencyNode({
  x,
  y,
  radius,
  label,
  fullPath,
  count,
}: {
  x: number
  y: number
  radius: number
  label: string
  fullPath: string
  count: number
}) {
  return (
    <g>
      <circle cx={x} cy={y} r={radius} fill="var(--api-surface)" stroke="var(--api-color-primary-soft)" strokeWidth="1.5">
        <title>{fullPath}</title>
      </circle>
      <circle cx={x + radius - 2} cy={y - radius + 2} r="8" fill="var(--api-color-primary)" stroke="var(--api-bg)" strokeWidth="1.5" />
      <text x={x + radius - 2} y={y - radius + 5} fill="var(--api-text)" fontSize="8" fontWeight="800" textAnchor="middle">
        {count}
      </text>
      <text x={x} y={y + radius + 13} fill="var(--api-text)" fontSize="10" fontWeight="700" textAnchor="middle">
        {label}
      </text>
    </g>
  )
}

function headersToRows(headers: Record<string, string>) {
  const rows = Object.entries(headers).map(([k, v]) => ({ k, v }))
  return rows.length > 0 ? rows : [{ k: '', v: '' }]
}

function rowsToHeaders(rows: { k: string; v: string }[]) {
  return rows.reduce<Record<string, string>>((acc, row) => {
    const key = row.k.trim()
    if (key) acc[key] = row.v
    return acc
  }, {})
}

function ReplayTab({
  tabId,
  request,
  originalRequest,
}: {
  tabId: number | null
  request: ReplayRequest | null
  originalRequest: RequestEntry | null
}) {
  const replayRef = useRef<HTMLDivElement>(null)
  const [method, setMethod] = useState(request?.method ?? 'GET')
  const [url, setUrl] = useState(request?.url ?? '')
  const [headers, setHeaders] = useState<{ k: string; v: string }[]>(headersToRows(request?.headers ?? {}))
  const [body, setBody] = useState(request?.body ?? '')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<ReplayResult | null>(null)
  const [bodyError, setBodyError] = useState('')
  const lineNumbers = body.split('\n').map((_, index) => index + 1)
  const headerMap = rowsToHeaders(headers)
  const expectsJsonBody = /\bjson\b/i.test(headerMap['content-type'] ?? '') || /^[\s[{]/.test(body.trim())
  const hasChanges = request
    ? (
        method !== request.method ||
        url !== request.url ||
        body !== (request.body ?? '') ||
        JSON.stringify(headerMap) !== JSON.stringify(request.headers)
      )
    : false

  const formatBody = () => {
    if (!body.trim()) {
      setBodyError('')
      return
    }

    try {
      setBody(JSON.stringify(JSON.parse(body), null, 2))
      setBodyError('')
    } catch {
      setBodyError('Body is not valid JSON. Fix it before formatting or replaying.')
    }
  }

  const resetReplay = () => {
    setMethod(request?.method ?? 'GET')
    setUrl(request?.url ?? '')
    setHeaders(headersToRows(request?.headers ?? {}))
    setBody(request?.body ?? '')
    setBodyError('')
    setResult(null)
  }

  const send = () => {
    if (!tabId || !url) return
    if (body.trim() && expectsJsonBody) {
      try {
        JSON.parse(body)
        setBodyError('')
      } catch {
        setBodyError('Body is not valid JSON. Fix it before replaying.')
        return
      }
    }

    setSending(true)
    setResult(null)

    chrome.runtime.sendMessage({
      type: 'RUN_REPLAY',
      tabId,
      payload: {
        id: request?.id ?? crypto.randomUUID(),
        method,
        url,
        headers: headerMap,
        body: body.trim() ? body : null,
        originalResponseBody: request?.originalResponseBody ?? null,
      },
    }).then((replayResult: ReplayResult) => {
      setResult(replayResult)
    }).catch(error => {
      setResult({
        status: 0,
        duration: 0,
        responseBody: String(error),
        responseHeaders: {},
      })
    }).finally(() => {
      setSending(false)
    })
  }

  const diff = computeDiff(
    request?.originalResponseBody ?? '',
    result?.responseBody ?? '',
  )
  const diffSummary = summarizeDiff(diff)

  useEffect(() => {
    const replay = replayRef.current
    if (!replay) return

    const firstFocusable = replay.querySelector<HTMLElement>('select, input, textarea, button:not(:disabled)')
    firstFocusable?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return

      const focusable = Array.from(
        replay.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'),
      ).filter(element => !element.hasAttribute('hidden') && element.offsetParent !== null)

      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
        return
      }

      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    replay.addEventListener('keydown', handleKeyDown)
    return () => replay.removeEventListener('keydown', handleKeyDown)
  }, [request?.id])

  return (
    <div
      className="api-replay"
      ref={replayRef}
      role="region"
      aria-label="Request replay editor"
    >
      {request && (
        <div className="api-replay-summary">
          <div className="api-replay-summary-row">
            <MethodPill method={request.method} />
            <span className="api-muted">{getPath(request.url)}</span>
            {originalRequest && <span className="api-muted">Original {formatMs(originalRequest.duration)} · {originalRequest.status}</span>}
          </div>
          <div className="api-replay-summary-row">
            <span className={`api-replay-badge${hasChanges ? ' is-dirty' : ''}`}>{hasChanges ? 'Edited' : 'Original values'}</span>
            {originalRequest?.ttfb ? <span className="api-muted">TTFB {formatMs(originalRequest.ttfb)}</span> : null}
            {originalRequest ? <span className="api-muted">Resp {formatBytes(originalRequest.responseSize)}</span> : null}
            {originalRequest?.timingSource ? <span className="api-muted">Source {originalRequest.timingSource === 'performance' ? 'Browser' : originalRequest.timingSource.toUpperCase()}</span> : null}
          </div>
        </div>
      )}

      <div className="api-replay-row">
        <select
          className="api-replay-select api-replay-method"
          value={method}
          onChange={event => setMethod(event.target.value)}
          aria-label="Replay HTTP method"
        >
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(item => <option key={item}>{item}</option>)}
        </select>
        <input
          className="api-replay-input"
          value={url}
          onChange={event => setUrl(event.target.value)}
          aria-label="Replay request URL"
        />
      </div>

      <div>
        <div className="api-replay-section-head">
          <SectionHeading>Headers</SectionHeading>
          <span className="api-muted">{Object.keys(headerMap).length} active</span>
        </div>
        {headers.map((header, index) => (
          <div className="api-header-row" key={index} style={{ marginBottom: 6 }}>
            <input
              className="api-replay-input"
              value={header.k}
              placeholder="Key"
              aria-label={`Header ${index + 1} key`}
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
              aria-label={`Header ${index + 1} value`}
              onChange={event => {
                const next = [...headers]
                next[index] = { ...next[index], v: event.target.value }
                setHeaders(next)
              }}
            />
            <button className="api-sidepanel-plain" aria-label={`Remove header ${index + 1}`} onClick={() => setHeaders(headers.filter((_, headerIndex) => headerIndex !== index))}>x</button>
          </div>
        ))}
        <button className="api-sidepanel-plain" onClick={() => setHeaders([...headers, { k: '', v: '' }])}>+ Add header</button>
      </div>

      <div>
        <div className="api-replay-section-head">
          <SectionHeading>Body</SectionHeading>
          <div className="api-replay-tools">
            <button className="api-sidepanel-plain" type="button" onClick={formatBody}>Format JSON</button>
            <button className="api-sidepanel-plain" type="button" onClick={resetReplay}>Reset</button>
          </div>
        </div>
        <div className="api-body-editor">
          <div className="api-line-numbers">
            {lineNumbers.map(number => <div key={number}>{number}</div>)}
          </div>
          <textarea className="api-replay-textarea" value={body} onChange={event => setBody(event.target.value)} aria-label="Replay request body" />
        </div>
        {bodyError && <div className="api-replay-error">{bodyError}</div>}
      </div>

      <button className="api-primary-wide" onClick={send} disabled={sending || !tabId || !url} aria-busy={sending}>
        {sending && <span className="api-spinner" />}
        {sending ? 'Sending...' : 'Send Request'}
      </button>

      {!request && !result ? (
        <div className="api-replay-empty">
          <span style={{ color: 'var(--api-border-strong)', fontSize: 32 }}>↻</span>
          <div style={{ fontSize: 13 }}>No replay yet</div>
          <div style={{ color: 'var(--api-border-strong)', fontSize: 11 }}>Click Replay on a captured request in the overlay.</div>
        </div>
      ) : result ? (
        <>
          <div className="api-replay-result">
            <div className="api-replay-summary-row">
              <span className={`api-replay-badge${result.status >= 400 || result.status === 0 ? ' is-error' : ' is-success'}`}>
                {result.status || 'failed'}
              </span>
              <span className="api-muted">Replay completed in {formatMs(result.duration)}</span>
              <span className="api-muted">{result.responseHeaders['content-type'] ?? 'unknown content-type'}</span>
            </div>
            <div className="api-replay-summary-row">
              <span className="api-muted">{diffSummary.same} unchanged</span>
              <span className="api-muted">{diffSummary.added} added</span>
              <span className="api-muted">{diffSummary.removed} removed</span>
            </div>
          </div>
          <div className="api-diff-grid">
            <DiffPanel title="Original Response" lines={diff.left} />
            <DiffPanel title="Replay Response" lines={diff.right} />
          </div>
        </>
      ) : (
        <div className="api-replay-empty">
          <span style={{ color: 'var(--api-border-strong)', fontSize: 32 }}>↻</span>
          <div style={{ fontSize: 13 }}>Ready to replay</div>
          <div style={{ color: 'var(--api-border-strong)', fontSize: 11 }}>Edit the request and send it from the original tab.</div>
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
    const muted = styles.getPropertyValue('--api-text-subtle').trim() || '#79737f'
    const success = styles.getPropertyValue('--api-success').trim() || '#8fe6bc'
    const warning = styles.getPropertyValue('--api-warning').trim() || '#ffd36f'
    const danger = styles.getPropertyValue('--api-danger').trim() || '#ff8f8f'
    const chartLeft = 42
    const chartRight = 8
    const chartTop = 8
    const chartBottom = 8

    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    if (requests.length === 0) return

    const max = Math.max(...requests.map(request => request.duration), 2000)
    const chartWidth = Math.max(0, width - chartLeft - chartRight)
    const chartHeight = Math.max(0, height - chartTop - chartBottom)
    const axisTicks = Array.from(new Set([
      0,
      Math.round(max * 0.25),
      Math.round(max * 0.5),
      Math.round(max * 0.75),
      max,
    ])).sort((left, right) => left - right)

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    ctx.fillStyle = muted
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'

    axisTicks.forEach(threshold => {
      const y = height - (threshold / max) * chartHeight - chartBottom
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = border
      ctx.globalAlpha = 0.35
      ctx.beginPath()
      ctx.moveTo(chartLeft, y)
      ctx.lineTo(width - chartRight, y)
      ctx.stroke()
      ctx.fillText(formatAxisLatency(threshold), chartLeft - 6, y)
    })

    ctx.globalAlpha = 1
    ctx.setLineDash([])

    const points = requests.map((request, index) => ({
      x: chartLeft + (index / Math.max(1, requests.length - 1)) * chartWidth,
      y: height - (request.duration / max) * chartHeight - chartBottom,
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
        role="img"
        aria-label={`Latency chart for ${requests.length} captured requests`}
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

function formatAxisLatency(value: number) {
  if (value >= 1000) {
    const seconds = value / 1000
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`
  }

  return `${value}ms`
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

export function computeDiff(a: string, b: string): { left: DiffLine[]; right: DiffLine[] } {
  const leftLines = a.split('\n')
  const rightLines = b.split('\n')
  const leftSet = new Set(leftLines)
  const rightSet = new Set(rightLines)

  return {
    left: leftLines.map(text => ({ text, kind: rightSet.has(text) ? 'same' : 'del' })),
    right: rightLines.map(text => ({ text, kind: leftSet.has(text) ? 'same' : 'add' })),
  }
}

function summarizeDiff(diff: { left: DiffLine[]; right: DiffLine[] }) {
  return {
    same: diff.right.filter(line => line.kind === 'same').length,
    added: diff.right.filter(line => line.kind === 'add').length,
    removed: diff.left.filter(line => line.kind === 'del').length,
  }
}

export async function exportSessionReport(requests: RequestEntry[]) {
  if (requests.length === 0) {
    throw new Error('No requests captured yet.')
  }

  const settings = await getSettings()
  const html = buildSessionReportHtml(requests, settings.largePayloadThresholdKb)
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')
  const filename = `api-debugger-session-${stamp}.html`

  try {
    if (chrome.downloads?.download) {
      await chrome.downloads.download({
        url,
        filename,
        saveAs: true,
      })
    } else {
      downloadWithAnchor(url, filename)
    }

    return filename
  } catch {
    downloadWithAnchor(url, filename)
    return filename
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
}

function downloadWithAnchor(url: string, filename: string) {
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

export function buildSessionReportHtml(requests: RequestEntry[], largePayloadThresholdKb: number) {
  const generatedAt = new Date()
  const total = requests.length
  const avg = total ? Math.round(requests.reduce((sum, request) => sum + request.duration, 0) / total) : 0
  const errors = requests.filter(request => request.status >= 400).length
  const errorRate = total ? Math.round((errors / total) * 1000) / 10 : 0
  const duplicates = requests.filter(request => request.isDuplicate).length
  const largePayloads = requests.filter(request => isLargePayload(request, largePayloadThresholdKb)).length
  const failedRequests = requests.filter(request => request.status === 0).length
  const capturedRequestBodies = requests.filter(request => request.requestBody != null && request.requestBody !== '').length
  const capturedResponseBodies = requests.filter(request => request.responseBody != null && request.responseBody !== '').length
  const slowest = [...requests].sort((a, b) => b.duration - a.duration)[0]
  const aiSuggestions = requests.filter(request => request.aiSuggestion)
  const rows = requests.map(request => `
    <tr>
      <td><span class="method">${escapeHtml(request.method)}</span></td>
      <td><span class="url">${escapeHtml(request.url)}</span></td>
      <td class="${request.status >= 500 ? 'danger' : request.status >= 400 ? 'warning' : 'success'}">${request.status || '-'}</td>
      <td>${formatMs(request.duration)}</td>
      <td>${formatBytes(request.requestSize)}</td>
      <td>${formatBytes(request.responseSize)}</td>
      <td>${request.ttfb > 0 ? formatMs(request.ttfb) : '-'}</td>
      <td><span class="source source-${request.timingSource}">${timingSourceLabel(request.timingSource)}</span></td>
      <td>${buildFlagBadges(request, largePayloadThresholdKb)}</td>
      <td>${escapeHtml(new Date(request.startTime).toLocaleTimeString())}</td>
    </tr>
    <tr class="details-row">
      <td colspan="10">
        <details>
          <summary>Payload and timing details</summary>
          <div class="timing-grid">
            ${buildTimingCells(request, largePayloadThresholdKb)}
          </div>
          <div class="payload-grid">
            <div>
              <h3>Request</h3>
              <pre>${escapeHtml(formatPayloadPreview({
                headers: request.requestHeaders,
                body: request.requestBody,
                captureNote: request.requestBody == null && request.requestSize > 0
                  ? `[request body unavailable in capture, ${formatBytes(request.requestSize)} transferred]`
                  : undefined,
                fingerprint: request.fingerprint,
                duplicateOf: request.duplicateOf,
              }, request.requestBody, request.requestSize, 'request'))}</pre>
            </div>
            <div>
              <h3>Response</h3>
              <pre>${escapeHtml(formatPayloadPreview(request.responseBody, request.responseBody, request.responseSize, 'response'))}</pre>
            </div>
            ${request.aiSuggestion ? `
              <div>
                <h3>AI Suggestion</h3>
                <pre>${escapeHtml(request.aiSuggestion)}</pre>
              </div>
            ` : ''}
          </div>
        </details>
      </td>
    </tr>
  `).join('')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>API Debugger Session Report</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #121015;
      --surface: #1e1b22;
      --raised: #292630;
      --border: #403a49;
      --border-strong: #5d536b;
      --text: #eee8f5;
      --muted: #9c96a6;
      --subtle: #79737f;
      --primary: #cbb8ff;
      --success: #8fe6bc;
      --warning: #ffd36f;
      --danger: #ff8f8f;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 48px;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 22px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 18px;
    }
    h1, h2, h3 { margin: 0; }
    h1 { font-size: 24px; }
    h2 { margin: 26px 0 12px; font-size: 16px; }
    h3 { margin-bottom: 8px; color: var(--muted); font-size: 12px; text-transform: uppercase; }
    .muted { color: var(--muted); }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      padding: 12px;
    }
    .label {
      color: var(--subtle);
      font-size: 11px;
      text-transform: uppercase;
    }
    .value {
      margin-top: 4px;
      font-size: 22px;
      font-weight: 800;
    }
    .chart, .graph {
      width: 100%;
      min-height: 160px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      padding: 12px;
      overflow: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--border);
      background: var(--surface);
      font-size: 12px;
    }
    th, td {
      border-bottom: 1px solid var(--border);
      padding: 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--subtle);
      font-size: 11px;
      text-transform: uppercase;
      background: var(--raised);
    }
    .url {
      display: inline-block;
      max-width: 420px;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--muted);
    }
    .method, .badge {
      display: inline-flex;
      margin-right: 4px;
      border-radius: 4px;
      padding: 2px 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      font-weight: 800;
    }
    .method { background: rgba(203, 184, 255, 0.16); color: var(--primary); }
    .badge { border: 1px solid var(--border-strong); }
    .warn-bg { background: rgba(201, 167, 77, 0.18); color: var(--warning); }
    .danger-bg { background: rgba(255, 143, 143, 0.14); color: var(--danger); }
    .source {
      display: inline-flex;
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      padding: 2px 7px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
      font-weight: 800;
      white-space: nowrap;
    }
    .source-cdp { background: rgba(143, 230, 188, 0.12); color: var(--success); }
    .source-performance { background: rgba(137, 194, 255, 0.12); color: #89c2ff; }
    .source-proxy { background: rgba(201, 167, 77, 0.16); color: var(--warning); }
    .success { color: var(--success); }
    .warning { color: var(--warning); }
    .danger { color: var(--danger); }
    details summary { cursor: pointer; color: var(--primary); }
    .details-row td { background: #18151d; padding: 8px 12px; }
    .timing-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 8px;
      margin-top: 10px;
      margin-bottom: 10px;
    }
    .timing-cell {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
      padding: 8px;
    }
    .timing-cell .label {
      display: block;
      margin-bottom: 3px;
      font-size: 10px;
    }
    .timing-cell .value {
      margin: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
    }
    .payload-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
      margin-top: 10px;
    }
    pre {
      max-height: 340px;
      margin: 0;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #111014;
      color: var(--muted);
      padding: 10px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .suggestion {
      border-left: 3px solid var(--primary);
      border-radius: 6px;
      background: var(--surface);
      padding: 12px;
      margin-bottom: 10px;
    }
    .callout {
      margin-top: 12px;
      border: 1px solid var(--border);
      border-left: 3px solid var(--primary);
      border-radius: 8px;
      background: rgba(41, 38, 48, 0.52);
      color: var(--muted);
      padding: 12px 14px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>API Debugger Session Report</h1>
        <div class="muted">Generated ${escapeHtml(generatedAt.toLocaleString())}</div>
      </div>
      <div class="muted">${total} captured requests</div>
    </header>

    <section class="stats">
      <div class="card"><div class="label">Total Requests</div><div class="value">${total}</div></div>
      <div class="card"><div class="label">Average Latency</div><div class="value">${formatMs(avg)}</div></div>
      <div class="card"><div class="label">Error Rate</div><div class="value">${errorRate}%</div></div>
      <div class="card"><div class="label">Duplicate Calls</div><div class="value">${duplicates}</div></div>
      <div class="card"><div class="label">Failed / Aborted</div><div class="value">${failedRequests}</div></div>
      <div class="card"><div class="label">Large Payloads</div><div class="value">${largePayloads}</div><div class="muted">over ${formatBytes(largePayloadThresholdKb * 1024)}</div></div>
      <div class="card"><div class="label">Slowest Endpoint</div><div class="value" style="font-size: 13px; overflow-wrap: anywhere;">${slowest ? escapeHtml(`${formatMs(slowest.duration)} ${getPath(slowest.url)}`) : '-'}</div></div>
    </section>

    <h2>Capture Fidelity</h2>
    <section class="stats">
      <div class="card"><div class="label">Captured Request Bodies</div><div class="value">${capturedRequestBodies}</div><div class="muted">${total - capturedRequestBodies} unavailable or empty</div></div>
      <div class="card"><div class="label">Captured Response Bodies</div><div class="value">${capturedResponseBodies}</div><div class="muted">${total - capturedResponseBodies} unavailable or empty</div></div>
      <div class="card"><div class="label">Report Validation</div><div class="value">OK</div><div class="muted">Built from ${total} live session entries</div></div>
    </section>
    <div class="callout">
      Binary, oversized, unreadable, aborted, and restricted-environment payloads are rendered with explicit placeholders so the exported report mirrors the live capture state.
    </div>

    <h2>Latency Timeline</h2>
    <div class="chart">${buildLatencySvg(requests)}</div>

    <h2>Dependency Map</h2>
    <div class="graph">${buildDependencySvg(requests)}</div>

    <h2>Request Feed</h2>
    <table>
      <thead>
        <tr>
          <th>Method</th>
          <th>URL</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Req Size</th>
          <th>Resp Size</th>
          <th>TTFB</th>
          <th>Source</th>
          <th>Flags</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <h2>AI Suggestions</h2>
    ${aiSuggestions.length > 0
      ? aiSuggestions.map(request => `
        <div class="suggestion">
          <div class="muted">${escapeHtml(request.method)} ${escapeHtml(getPath(request.url))}</div>
          <div>${escapeHtml(request.aiSuggestion ?? '')}</div>
        </div>
      `).join('')
      : '<div class="muted">No AI suggestions were captured in this session.</div>'}
  </main>
</body>
</html>`
}

function buildLatencySvg(requests: RequestEntry[]) {
  const width = 980
  const height = 240
  const padding = 34
  if (requests.length === 0) {
    return '<div class="muted">No requests were captured in this session.</div>'
  }

  const max = Math.max(...requests.map(request => request.duration), 100)
  const avg = Math.round(requests.reduce((sum, request) => sum + request.duration, 0) / requests.length)
  const points = requests.map((request, index) => {
    const x = padding + (index / Math.max(1, requests.length - 1)) * (width - padding * 2)
    const y = height - padding - (request.duration / max) * (height - padding * 2 - 18)
    return { x, y, request }
  })
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')
  const fillPath = points.length > 0
    ? `${path} L ${points.at(-1)?.x.toFixed(1)} ${height - padding} L ${points[0].x.toFixed(1)} ${height - padding} Z`
    : ''
  const avgY = height - padding - (avg / max) * (height - padding * 2 - 18)
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(step => {
    const value = Math.round(max * step)
    const y = height - padding - step * (height - padding * 2 - 18)

    return `
      <line x1="${padding}" y1="${y.toFixed(1)}" x2="${width - padding}" y2="${y.toFixed(1)}" stroke="#403a49" stroke-width="1" opacity="${step === 0 ? '1' : '0.45'}" />
      <text x="${padding - 8}" y="${(y + 4).toFixed(1)}" fill="#79737f" font-size="10" text-anchor="end">${formatMs(value)}</text>
    `
  }).join('')
  const dots = points.map(point => `
    <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${point.request.isSlow || point.request.status >= 400 ? '5' : '3.5'}" fill="${point.request.isSlow ? '#ff8f8f' : point.request.status >= 400 ? '#ffd36f' : '#8fe6bc'}" stroke="#121015" stroke-width="1.5">
      <title>${escapeHtml(`${point.request.method} ${getPath(point.request.url)} - ${formatMs(point.request.duration)} - ${timingSourceLabel(point.request.timingSource)}`)}</title>
    </circle>
  `).join('')
  const sourceLegend = [
    ['#8fe6bc', '2xx / fast'],
    ['#ffd36f', '4xx / warning'],
    ['#ff8f8f', 'Slow / 5xx'],
  ].map(([color, label], index) => `
    <g transform="translate(${width - 300 + index * 100}, 18)">
      <circle cx="0" cy="0" r="4" fill="${color}" />
      <text x="9" y="4" fill="#9c96a6" font-size="10">${label}</text>
    </g>
  `).join('')

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Latency timeline">
    <defs>
      <linearGradient id="latency-fill" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#cbb8ff" stop-opacity="0.28" />
        <stop offset="100%" stop-color="#cbb8ff" stop-opacity="0.02" />
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#18151d" />
    <text x="${padding}" y="22" fill="#eee8f5" font-size="13" font-weight="800">Latency over session</text>
    <text x="${padding}" y="39" fill="#79737f" font-size="10">Average ${formatMs(avg)} across ${requests.length} requests</text>
    ${sourceLegend}
    ${gridLines}
    <line x1="${padding}" y1="${avgY.toFixed(1)}" x2="${width - padding}" y2="${avgY.toFixed(1)}" stroke="#ffd36f" stroke-width="1" stroke-dasharray="4 5" opacity="0.75" />
    <text x="${width - padding}" y="${(avgY - 6).toFixed(1)}" fill="#ffd36f" font-size="10" text-anchor="end">avg ${formatMs(avg)}</text>
    <path d="${fillPath}" fill="url(#latency-fill)" />
    <path d="${path}" fill="none" stroke="#cbb8ff" stroke-width="2" opacity="0.8" />
    ${dots}
  </svg>`
}

export function buildDependencySvg(requests: RequestEntry[]) {
  const { nodes, edges } = buildDependencyGraph(requests)

  if (edges.length === 0) {
    return '<div class="muted">No inferred dependencies were captured in this session.</div>'
  }

  const width = 980
  const height = 430
  const positions = new Map(
    buildDependencyLayout(nodes, width, height, {
      top: 72,
      right: 48,
      bottom: 56,
      left: 48,
    }).map(node => [node.id, node]),
  )
  const lines = edges.map(edge => {
    const start = positions.get(edge.from)
    const end = positions.get(edge.to)
    if (!start || !end) return ''
    const startRadius = Math.min(20, 8 + start.count * 1.5)
    const endRadius = Math.min(20, 8 + end.count * 1.5)
    const startY = start.y + startRadius
    const endY = end.y - endRadius
    const midX = (start.x + end.x) / 2
    const midY = (startY + endY) / 2
    const curveY = startY + (endY - startY) * 0.45

    return `<g>
      <path d="M ${start.x.toFixed(1)} ${startY.toFixed(1)} C ${start.x.toFixed(1)} ${curveY.toFixed(1)} ${end.x.toFixed(1)} ${(curveY + 14).toFixed(1)} ${end.x.toFixed(1)} ${endY.toFixed(1)}" fill="none" stroke="${latencyColor(edge.latency)}" stroke-width="${Math.min(4, 1.2 + edge.count * 0.5).toFixed(1)}" marker-end="url(#report-arrow)" opacity="0.88">
        <title>${escapeHtml(`${getEndpointLabel(edge.from)} -> ${getEndpointLabel(edge.to)} - ${edge.count} call chain(s), avg ${formatMs(edge.latency)}`)}</title>
      </path>
      <text x="${midX.toFixed(1)}" y="${(midY - 5).toFixed(1)}" fill="#9c96a6" font-size="9" text-anchor="middle">${formatMs(edge.latency)}</text>
    </g>`
  }).join('')
  const nodeMarkup = nodes.map(node => {
    const position = positions.get(node.id)!
    const count = node.count
    const nodeRadius = Math.min(20, 8 + count * 1.5)
    return `<g>
      <circle cx="${position.x.toFixed(1)}" cy="${position.y.toFixed(1)}" r="${nodeRadius + 7}" fill="rgba(203, 184, 255, 0.07)" />
      <circle cx="${position.x.toFixed(1)}" cy="${position.y.toFixed(1)}" r="${nodeRadius}" fill="#292630" stroke="#cbb8ff" stroke-width="1.5">
        <title>${escapeHtml(`${node.id} - ${count} captured call(s)`)}</title>
      </circle>
      <circle cx="${(position.x + nodeRadius - 2).toFixed(1)}" cy="${(position.y - nodeRadius + 2).toFixed(1)}" r="8" fill="#8069bf" stroke="#121015" stroke-width="1.5" />
      <text x="${(position.x + nodeRadius - 2).toFixed(1)}" y="${(position.y - nodeRadius + 5).toFixed(1)}" fill="#eee8f5" font-size="8" font-weight="800" text-anchor="middle">${count}</text>
      <text x="${position.x.toFixed(1)}" y="${(position.y + nodeRadius + 16).toFixed(1)}" fill="#eee8f5" font-size="10" font-weight="700" text-anchor="middle">${escapeHtml(trimMiddle(node.label, 26))}</text>
      <text x="${position.x.toFixed(1)}" y="${(position.y + nodeRadius + 29).toFixed(1)}" fill="#79737f" font-size="9" text-anchor="middle">${escapeHtml(trimMiddle(node.id, 34))}</text>
    </g>`
  }).join('')

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Dependency map">
    <defs>
      <marker id="report-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
        <path d="M0,0 L9,4.5 L0,9 Z" fill="#9c96a6" />
      </marker>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#18151d" />
    <text x="18" y="24" fill="#eee8f5" font-size="13" font-weight="800">Inferred API dependencies</text>
    <text x="18" y="41" fill="#79737f" font-size="10">Grouped by endpoint path. Only connected endpoints are shown. Edge labels show downstream average latency.</text>
    <g transform="translate(${width - 380}, 26)" font-size="10" fill="#9c96a6">
      <line x1="0" y1="0" x2="22" y2="0" stroke="#22C55E" stroke-width="2" /><text x="30" y="4">Fast</text>
      <line x1="86" y1="0" x2="108" y2="0" stroke="#F59E0B" stroke-width="2" /><text x="116" y="4">500ms+</text>
      <line x1="200" y1="0" x2="222" y2="0" stroke="#EF4444" stroke-width="2" /><text x="230" y="4">1.5s+</text>
    </g>
    <text x="18" y="62" fill="#9c96a6" font-size="10">Root requests appear near the top; downstream requests flow downward.</text>
    ${lines}
    ${nodeMarkup}
  </svg>`
}

function buildDependencyGraph(requests: RequestEntry[]) {
  const graphRequests = requests.slice(-MAX_DEPENDENCY_GRAPH_REQUESTS)
  const requestById = new Map(graphRequests.map(request => [request.id, request]))
  const nodeMap = new Map<string, { id: string; label: string; count: number }>()
  const edgeMap = new Map<string, DependencyGraphEdge>()

  graphRequests.forEach(request => {
    const path = getPath(request.url)
    const entry = nodeMap.get(path) ?? {
      id: path,
      label: getEndpointLabel(path),
      count: 0,
    }
    entry.count += 1
    nodeMap.set(path, entry)
  })

  graphRequests.forEach(request => {
    const to = getPath(request.url)
    request.dependsOn.forEach(sourceId => {
      const source = requestById.get(sourceId)
      if (!source) return

      const from = getPath(source.url)
      if (!nodeMap.has(from) || !nodeMap.has(to) || from === to) return

      const key = `${from} -> ${to}`
      const edge = edgeMap.get(key) ?? { from, to, latency: 0, count: 0 }
      edge.latency += request.duration
      edge.count += 1
      edgeMap.set(key, edge)
    })
  })

  const edges = Array.from(edgeMap.values())
    .map(edge => ({ ...edge, latency: Math.round(edge.latency / edge.count) }))
    .sort((a, b) => b.count - a.count || b.latency - a.latency)

  const connectedIds = new Set(edges.flatMap(edge => [edge.from, edge.to]))
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()

  edges.forEach(edge => {
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + edge.count)
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + edge.count)
  })

  const nodes = assignDependencyLevels(
    Array.from(nodeMap.values())
      .filter(node => connectedIds.has(node.id))
      .map(node => ({
        ...node,
        incoming: incoming.get(node.id) ?? 0,
        outgoing: outgoing.get(node.id) ?? 0,
      })),
    edges,
  )
    .sort((a, b) => a.level - b.level || b.count - a.count || a.label.localeCompare(b.label))

  return { nodes, edges }
}

function assignDependencyLevels(
  nodes: Array<{ id: string; label: string; count: number; incoming: number; outgoing: number }>,
  edges: DependencyGraphEdge[],
): DependencyGraphNode[] {
  const incomingCounts = new Map(nodes.map(node => [node.id, 0]))
  const children = new Map<string, string[]>()
  const parents = new Map<string, string[]>()

  edges.forEach(edge => {
    incomingCounts.set(edge.to, (incomingCounts.get(edge.to) ?? 0) + 1)
    const childList = children.get(edge.from) ?? []
    childList.push(edge.to)
    children.set(edge.from, childList)

    const parentList = parents.get(edge.to) ?? []
    parentList.push(edge.from)
    parents.set(edge.to, parentList)
  })

  const levels = new Map<string, number>()
  const queue = nodes
    .filter(node => (incomingCounts.get(node.id) ?? 0) === 0)
    .sort((a, b) => b.outgoing - a.outgoing || b.count - a.count || a.label.localeCompare(b.label))
    .map(node => node.id)

  queue.forEach(id => levels.set(id, 0))

  while (queue.length > 0) {
    const currentId = queue.shift()!
    const currentLevel = levels.get(currentId) ?? 0

    ;(children.get(currentId) ?? []).forEach(childId => {
      levels.set(childId, Math.max(levels.get(childId) ?? 0, currentLevel + 1))
      incomingCounts.set(childId, (incomingCounts.get(childId) ?? 1) - 1)
      if ((incomingCounts.get(childId) ?? 0) === 0) {
        queue.push(childId)
      }
    })
  }

  nodes.forEach(node => {
    if (levels.has(node.id)) return

    const parentLevels = (parents.get(node.id) ?? [])
      .map(parentId => levels.get(parentId))
      .filter((level): level is number => typeof level === 'number')
    levels.set(node.id, parentLevels.length > 0 ? Math.max(...parentLevels) + 1 : 0)
  })

  return nodes.map(node => ({
    ...node,
    level: levels.get(node.id) ?? 0,
  }))
}

function buildDependencyLayout(
  nodes: DependencyGraphNode[],
  width: number,
  height: number,
  padding: { top: number; right: number; bottom: number; left: number },
): DependencyGraphLayoutNode[] {
  const maxLevel = Math.max(...nodes.map(node => node.level), 0)
  const grouped = new Map<number, DependencyGraphNode[]>()

  nodes.forEach(node => {
    const levelNodes = grouped.get(node.level) ?? []
    levelNodes.push(node)
    grouped.set(node.level, levelNodes)
  })

  return Array.from(grouped.entries())
    .sort((a, b) => a[0] - b[0])
    .flatMap(([level, levelNodes]) => {
      const sorted = [...levelNodes].sort((a, b) => b.outgoing - a.outgoing || b.count - a.count || a.label.localeCompare(b.label))
      const y = maxLevel === 0
        ? (padding.top + (height - padding.bottom)) / 2
        : padding.top + (level / maxLevel) * (height - padding.top - padding.bottom)
      const usableWidth = width - padding.left - padding.right

      return sorted.map((node, index) => {
        const x = sorted.length === 1
          ? width / 2
          : padding.left + (index / (sorted.length - 1)) * usableWidth

        return {
          ...node,
          x,
          y,
        }
      })
    })
}

function formatJsonLike(value: unknown) {
  if (value == null || value === '') return ''
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }

  return JSON.stringify(value, null, 2)
}

function formatPayloadPreview(value: unknown, rawBody: string | null, size: number, label: 'request' | 'response') {
  if (typeof value === 'string' && value.trim()) {
    return formatJsonLike(value)
  }

  if (value && typeof value === 'object') {
    return formatJsonLike(value)
  }

  if (rawBody && rawBody.trim()) {
    return formatJsonLike(rawBody)
  }

  if (size > 0) {
    return `[${label} body unavailable in capture, ${formatBytes(size)} transferred]`
  }

  return `[no ${label} body captured]`
}

function timingSourceLabel(source: RequestEntry['timingSource']) {
  if (source === 'cdp') return 'CDP'
  if (source === 'performance') return 'Browser'
  return 'Proxy'
}

function isLargePayload(request: RequestEntry, largePayloadThresholdKb: number) {
  return request.responseSize > largePayloadThresholdKb * 1024
}

function buildFlagBadges(request: RequestEntry, largePayloadThresholdKb: number) {
  return [
    request.isSlow ? '<span class="badge danger-bg">SLOW</span>' : '',
    request.duplicateCount > 1 ? `<span class="badge warn-bg">DUP x${request.duplicateCount}</span>` : '',
    isLargePayload(request, largePayloadThresholdKb) ? `<span class="badge warn-bg">LARGE ${escapeHtml(formatBytes(request.responseSize))}</span>` : '',
  ].filter(Boolean).join('')
}

function buildTimingCells(request: RequestEntry, largePayloadThresholdKb: number) {
  const cells = [
    ['Source', timingSourceLabel(request.timingSource)],
    ['Duration', formatMs(request.duration)],
    ['TTFB', request.ttfb > 0 ? formatMs(request.ttfb) : '-'],
    ['DNS', request.dnsTime > 0 ? formatMs(request.dnsTime) : '-'],
    ['Connect', request.connectTime > 0 ? formatMs(request.connectTime) : '-'],
    ['SSL', request.sslTime > 0 ? formatMs(request.sslTime) : '-'],
    ['Request', request.requestTime > 0 ? formatMs(request.requestTime) : '-'],
    ['Response', request.responseTime > 0 ? formatMs(request.responseTime) : '-'],
    ['Transfer', formatBytes(request.transferSize)],
    ['Decoded', formatBytes(request.decodedBodySize)],
    ['Payload Limit', formatBytes(largePayloadThresholdKb * 1024)],
  ]

  return cells.map(([label, value]) => `
    <div class="timing-cell">
      <span class="label">${escapeHtml(label)}</span>
      <div class="value">${escapeHtml(value)}</div>
    </div>
  `).join('')
}

function escapeHtml(value: unknown) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function trimMiddle(value: string, max: number) {
  if (value.length <= max) return value
  const keep = Math.max(4, Math.floor((max - 3) / 2))
  return `${value.slice(0, keep)}...${value.slice(-keep)}`
}

function getPath(url: string) {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function getEndpointLabel(path: string) {
  const segments = path.split('/').filter(Boolean)
  const usefulSegments = segments.slice(-2)
  const label = usefulSegments.length > 0 ? `/${usefulSegments.join('/')}` : '/'

  return trimMiddle(label, 32)
}

function formatMs(ms: number) {
  return ms > 999 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function latencyColor(ms: number) {
  if (ms < 300) return '#22C55E'
  if (ms <= 800) return '#F59E0B'
  return '#EF4444'
}

if (typeof document !== 'undefined') {
  const rootElement = document.getElementById('root')
  if (rootElement) {
    const root = window.__apiDebuggerSidePanelRoot ?? createRoot(rootElement)
    window.__apiDebuggerSidePanelRoot = root
    root.render(<SidePanel />)
  }
}

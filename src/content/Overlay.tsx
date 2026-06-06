import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AISuggestionResponse, RequestEntry } from '../shared/types'
import { saveSettings, type ApiDebuggerSettings } from '../shared/settings'
import { useSettings, useUpdateSettings } from '../shared/SettingsContext'
import { sendRuntimeMessage } from '../shared/sendMessage'
import overlayThemeCss from './Overlay.css?raw'

interface RequestCompleteMessage {
  type: 'REQUEST_COMPLETE'
  payload: RequestEntry
}

interface RequestUpdatedMessage {
  type: 'REQUEST_UPDATED'
  payload: RequestEntry
}

type OverlayState = 'feed' | 'paused' | 'minimised' | 'hidden'
type JsonExpandMode = 'all' | 'none' | null
type JsonTab = 'response' | 'request'
type AISuggestionState = 'idle' | 'loading' | 'result' | 'error'
const brandIconUrl = chrome.runtime.getURL('icons/favicon-32x32.png')

function isRequestCompleteMessage(msg: unknown): msg is RequestCompleteMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as { type?: unknown }).type === 'REQUEST_COMPLETE' &&
    'payload' in msg
  )
}

function isRequestUpdatedMessage(msg: unknown): msg is RequestUpdatedMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as { type?: unknown }).type === 'REQUEST_UPDATED' &&
    'payload' in msg
  )
}

function LiveDot({ isCapturing }: { isCapturing: boolean }) {
  return <span className={`apidbg-live-dot${isCapturing ? ' is-capturing' : ''}`} />
}

function BrandMark() {
  return (
    <span className="apidbg-brand-mark" aria-hidden="true">
      <img src={brandIconUrl} alt="" />
    </span>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 5h9M6 5V3.5h4V5m-5.5 0 .6 7h5.8l.6-7M6.6 7.2v2.7M9.4 7.2v2.7" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4.5v7M10 4.5v7" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4.5l5 3.5-5 3.5v-7z" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function SidePanelIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="1.5" strokeWidth="1.4" />
      <path d="M9.5 3v10" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function MinimiseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 8h7" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    GET: { bg: 'rgba(203, 184, 255, 0.18)', color: 'var(--api-color-primary-soft)' },
    POST: { bg: 'rgba(143, 230, 188, 0.14)', color: 'var(--api-success)' },
    PUT: { bg: 'rgba(73, 145, 255, 0.14)', color: 'var(--api-info)' },
    PATCH: { bg: 'rgba(255, 177, 51, 0.14)', color: 'var(--api-warning)' },
    DELETE: { bg: 'rgba(255, 143, 143, 0.15)', color: 'var(--api-danger)' },
  }
  const c = colors[method.toUpperCase()] ?? colors.GET

  return (
    <span
      className="apidbg-method"
      style={{ '--method-bg': c.bg, '--method-color': c.color } as React.CSSProperties}
    >
      {method.toUpperCase()}
    </span>
  )
}

function StatusBadge({ status }: { status: number }) {
  const style = status >= 500
    ? {
        '--badge-color': 'var(--api-danger)',
        '--badge-bg': 'rgba(255, 92, 82, 0.11)',
        '--badge-border': 'rgba(255, 120, 111, 0.24)',
      }
    : status >= 400
      ? {
          '--badge-color': 'var(--api-warning)',
          '--badge-bg': 'rgba(255, 177, 51, 0.1)',
          '--badge-border': 'rgba(255, 191, 75, 0.24)',
        }
      : status >= 300
        ? {
            '--badge-color': 'var(--api-info)',
            '--badge-bg': 'rgba(73, 145, 255, 0.1)',
            '--badge-border': 'rgba(101, 168, 255, 0.24)',
          }
        : status >= 200
          ? {
              '--badge-color': 'var(--api-success)',
              '--badge-bg': 'rgba(57, 218, 151, 0.1)',
              '--badge-border': 'rgba(83, 230, 164, 0.22)',
            }
          : {
              '--badge-color': 'var(--api-text-muted)',
              '--badge-bg': 'rgba(126, 151, 183, 0.08)',
              '--badge-border': 'var(--api-border)',
            }

  return <span className="apidbg-status" style={style as React.CSSProperties}>{status || '-'}</span>
}

function latencyColor(ms: number) {
  if (ms < 300) return 'var(--api-success)'
  if (ms <= 800) return 'var(--api-warning)'
  return 'var(--api-danger)'
}

function Duration({ ms }: { ms: number }) {
  const color = latencyColor(ms)
  const display = ms > 999 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`

  return <span className="apidbg-duration" style={{ '--badge-color': color } as React.CSSProperties}>{display}</span>
}

function TimingSourceChip({ source }: { source: RequestEntry['timingSource'] }) {
  const label = source === 'cdp' ? 'CDP' : source === 'performance' ? 'BR' : 'JS'
  const style = source === 'cdp'
    ? {
        '--chip-bg': 'rgba(98, 214, 157, 0.14)',
        '--chip-border': 'rgba(98, 214, 157, 0.4)',
        '--chip-color': '#8fe6bc',
      }
    : source === 'performance'
    ? {
        '--chip-bg': 'rgba(77, 163, 255, 0.14)',
        '--chip-border': 'rgba(77, 163, 255, 0.4)',
        '--chip-color': '#89c2ff',
      }
    : {
        '--chip-bg': 'rgba(201, 167, 77, 0.16)',
        '--chip-border': 'rgba(201, 167, 77, 0.38)',
        '--chip-color': 'var(--api-warning)',
      }

  return (
    <span
      className="apidbg-timing-chip"
      style={style as React.CSSProperties}
      title={source === 'cdp' ? 'Chrome DevTools Protocol timing' : source === 'performance' ? 'Browser timing' : 'JavaScript proxy timing'}
    >
      {label}
    </span>
  )
}

function DupBadge({ count }: { count: number }) {
  return (
    <span
      className="apidbg-badge"
      style={{
        '--badge-bg': 'rgba(201, 167, 77, 0.18)',
        '--badge-border': 'rgba(201, 167, 77, 0.45)',
        '--badge-color': 'var(--api-warning)',
      } as React.CSSProperties}
      title={`${count} matching requests in this session`}
    >
      DUP x{count}
    </span>
  )
}

function SlowBadge() {
  return (
    <span
      className="apidbg-badge"
      style={{
        '--badge-bg': 'var(--api-danger-bg)',
        '--badge-border': 'rgba(255, 143, 143, 0.45)',
        '--badge-color': 'var(--api-danger)',
      } as React.CSSProperties}
    >
      SLOW
    </span>
  )
}

function LargePayloadBadge({ size }: { size: number }) {
  return (
    <span
      className="apidbg-badge"
      style={{
        '--badge-bg': 'rgba(201, 167, 77, 0.18)',
        '--badge-border': 'rgba(201, 167, 77, 0.45)',
        '--badge-color': 'var(--api-warning)',
      } as React.CSSProperties}
      title={`Large response payload: ${formatBytes(size)}`}
    >
      LARGE
    </span>
  )
}

function SpinnerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="apidbg-spinner">
      <circle cx="12" cy="12" r="9" stroke="var(--api-color-primary-soft)" strokeWidth="2.5" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="var(--api-color-primary-soft)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone: 'purple' | 'green' | 'danger' | 'amber'
}) {
  return (
    <div className={`apidbg-metric-card is-${tone}`}>
      <div className="apidbg-metric-icon" aria-hidden="true">
        {label === 'Total calls' && (
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M6.5 4.5c-2 1.2-2.8 3.8-1.6 5.8 1.7 2.8 4 5.1 6.8 6.8 2 1.2 4.6.4 5.8-1.6l.6-1c.3-.6.2-1.3-.4-1.7l-2.3-1.5c-.5-.3-1.2-.2-1.6.2l-.8.9a11 11 0 0 1-5.4-5.4l.9-.8c.4-.4.5-1.1.2-1.6L7.2 2.3C6.8 1.7 6.1 1.6 5.5 2l-1 .6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {label === 'Avg response' && (
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M3 14.5h3.2l2.2-4 2.7 2.1 2.3-5.1 3.6-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M14.2 5.5H17v2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {label === 'Errors' && (
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M10 3.1 17 16H3L10 3.1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M10 7.5v4M10 14h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        )}
        {label === 'Duplicates' && (
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M6.2 6.2h7.6v7.6H6.2z" stroke="currentColor" strokeWidth="1.35" />
            <path d="M3.5 10A6.5 6.5 0 0 1 10 3.5M16.5 10A6.5 6.5 0 0 1 10 16.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
          </svg>
        )}
      </div>
      <div className="apidbg-metric-copy">
        <span className="apidbg-metric-label">{label}</span>
        <span className="apidbg-metric-value">{value}</span>
      </div>
      <span className="apidbg-metric-detail">{detail}</span>
    </div>
  )
}

function escapeJsonPathKey(key: string) {
  return key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function appendJsonPath(parentPath: string, key: string, parentIsArray: boolean) {
  if (parentIsArray) return `${parentPath}[${key}]`
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return `${parentPath}.${key}`
  return `${parentPath}["${escapeJsonPathKey(key)}"]`
}

function stringifyJsonValue(value: unknown) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'

  return JSON.stringify(value, null, 2)
}

function JsonPathCopyButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      className={`apidbg-json-copy${copied ? ' is-copied' : ''}`}
      title={`Copy path: ${path}`}
      aria-label={`Copy JSON path ${path}`}
      onClick={event => {
        event.stopPropagation()
        navigator.clipboard?.writeText(path)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? 'Copied' : 'Path'}
    </button>
  )
}

function JsonNode({
  k,
  value,
  depth,
  search,
  forceExpand,
  path,
}: {
  k?: string
  value: unknown
  depth: number
  search: string
  forceExpand: JsonExpandMode
  path: string
}) {
  const [open, setOpen] = useState(depth < 2)
  const isOpen = forceExpand === 'all' ? true : forceExpand === 'none' ? false : open

  const isObj = value && typeof value === 'object' && !Array.isArray(value)
  const isArr = Array.isArray(value)
  const valueText = stringifyJsonValue(value)
  const normalizedSearch = search.trim().toLowerCase()
  const matches = Boolean(
    normalizedSearch &&
    (
      k?.toLowerCase().includes(normalizedSearch) ||
      path.toLowerCase().includes(normalizedSearch) ||
      (typeof valueText === 'string' && valueText.toLowerCase().includes(normalizedSearch))
    ),
  )
  const dim = normalizedSearch && !matches ? 0.35 : 1
  const indent = depth * 16

  if (isObj || isArr) {
    const obj = value as Record<string, unknown> | unknown[]
    const entries = isArr
      ? (obj as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
      : Object.entries(obj as Record<string, unknown>)
    const count = entries.length

    return (
      <div style={{ opacity: dim, paddingLeft: depth === 0 ? 0 : 12, borderLeft: depth === 0 ? 'none' : '1px solid var(--api-border)' }}>
        <div
          className="apidbg-json-row"
          role="treeitem"
          tabIndex={0}
          aria-expanded={isOpen}
          aria-label={`${path}, ${isArr ? 'array' : 'object'}, ${count} ${isArr ? 'items' : 'keys'}`}
          onClick={() => setOpen(o => !o)}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setOpen(o => !o)
            }
            if (event.key === 'ArrowRight' && !isOpen) {
              event.preventDefault()
              setOpen(true)
            }
            if (event.key === 'ArrowLeft' && isOpen) {
              event.preventDefault()
              setOpen(false)
            }
          }}
          style={{ cursor: 'pointer', paddingLeft: indent }}
        >
          <span style={{ display: 'inline-block', width: 10, color: 'var(--api-text-subtle)', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', fontSize: 10 }}>
            {'>'}
          </span>
          {k !== undefined && (
            <span className={`apidbg-json-key${matches ? ' is-match' : ''}`}>
              "{k}"
            </span>
          )}
          {k !== undefined && <span className="apidbg-json-punct">:</span>}
          {!isOpen && (
            <span className="apidbg-json-preview">
              {isArr ? `[...] ${count} items` : `{...} ${count} keys`}
            </span>
          )}
          {isOpen && <span className="apidbg-json-punct">{isArr ? '[' : '{'}</span>}
          <span className="apidbg-json-path" title={path}>{path}</span>
          <JsonPathCopyButton path={path} />
        </div>
        {isOpen && (
          <div role="group">
            {entries.map(([ck, cv]) => (
              <JsonNode
                key={ck}
                k={ck}
                value={cv}
                depth={depth + 1}
                search={search}
                forceExpand={forceExpand}
                path={appendJsonPath(path, ck, isArr)}
              />
            ))}
            <div className="apidbg-json-closing" style={{ paddingLeft: indent + 14 }}>
              {isArr ? ']' : '}'}
            </div>
          </div>
        )}
      </div>
    )
  }

  const valueType = value === null ? 'null' : typeof value
  const valueClass = `apidbg-json-value-${valueType}`

  return (
    <div
      className="apidbg-json-row"
      role="treeitem"
      tabIndex={0}
      aria-label={`${path}, ${valueType}, ${valueText}`}
      style={{ opacity: dim, paddingLeft: indent + 14 }}
    >
      {k !== undefined && (
        <>
          <span className={`apidbg-json-key${matches ? ' is-match' : ''}`}>
            "{k}"
          </span>
          <span className="apidbg-json-punct">:</span>
        </>
      )}
      <span className={valueClass}>{valueText}</span>
      <span className="apidbg-json-path" title={path}>{path}</span>
      <JsonPathCopyButton path={path} />
    </div>
  )
}

function countKeys(v: unknown, depth = 0): number {
  if (depth > 8) return 0
  if (Array.isArray(v)) return v.reduce((a: number, x) => a + countKeys(x, depth + 1), 0)
  if (v && typeof v === 'object') {
    return Object.keys(v).length + Object.values(v).reduce((a: number, x) => a + countKeys(x, depth + 1), 0)
  }
  return 0
}

function parseBody(body: string | null): unknown {
  if (!body) return null

  try {
    return JSON.parse(body)
  } catch {
    return { body }
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function getPath(url: string) {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}

function formatTimingSourceLabel(source: RequestEntry['timingSource']) {
  return source === 'cdp' ? 'CDP' : source === 'performance' ? 'Browser' : 'Proxy'
}

function getSparklineChartMax(requests: RequestEntry[]) {
  const max = Math.max(...requests.map(r => r.duration), 100)
  return Math.max(100, Math.ceil(max / 100) * 100)
}

function getSparklineLeftPadding(chartMax: number) {
  const label = `${chartMax}ms`
  return Math.max(38, label.length * 6 + 12)
}

function Sparkline({
  requests,
  overlaySize,
  collapsed,
  onToggleCollapsed,
}: {
  requests: RequestEntry[]
  overlaySize: ApiDebuggerSettings['overlaySize']
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<{ x: number; y: number; r: RequestEntry } | null>(null)

  useEffect(() => {
    const c = ref.current
    if (!c) return

    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth
    const h = c.clientHeight
    c.width = w * dpr
    c.height = h * dpr

    const ctx = c.getContext('2d')
    if (!ctx) return

    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    if (collapsed || requests.length < 2) return

    const styles = getComputedStyle(c)
    const lineColor = styles.getPropertyValue('--api-chart-line').trim() || '#8b6cff'
    const slowColor = styles.getPropertyValue('--api-danger').trim() || '#ff8f8f'
    const gridColor = styles.getPropertyValue('--api-chart-grid').trim() || 'rgba(130, 153, 183, 0.12)'
    const labelColor = styles.getPropertyValue('--api-text-subtle').trim() || '#718096'
    const chartMax = getSparklineChartMax(requests)
    const padding = { top: 12, right: 4, bottom: 12, left: getSparklineLeftPadding(chartMax) }
    const chartWidth = Math.max(1, w - padding.left - padding.right)
    const chartHeight = Math.max(1, h - padding.top - padding.bottom)
    const points = requests.map((r, i) => ({
      x: padding.left + (i / (requests.length - 1)) * chartWidth,
      y: padding.top + chartHeight - (r.duration / chartMax) * chartHeight,
      r,
    }))

    ctx.font = '10px Inter, ui-sans-serif, system-ui'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ;[0, 0.5, 1].forEach(step => {
      const y = padding.top + chartHeight - step * chartHeight
      ctx.beginPath()
      ctx.strokeStyle = gridColor
      ctx.lineWidth = 1
      ctx.setLineDash(step === 0 ? [] : [3, 5])
      ctx.moveTo(padding.left, y)
      ctx.lineTo(w - padding.right, y)
      ctx.stroke()
      ctx.fillStyle = labelColor
      ctx.fillText(`${Math.round(chartMax * step)}ms`, padding.left - 7, y)
    })
    ctx.setLineDash([])

    const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom)
    gradient.addColorStop(0, 'rgba(139, 108, 255, 0.3)')
    gradient.addColorStop(1, 'rgba(139, 108, 255, 0)')
    ctx.beginPath()
    ctx.moveTo(points[0].x, h - padding.bottom)
    ctx.lineTo(points[0].x, points[0].y)
    points.slice(1).forEach((point, index) => {
      const previous = points[index]
      const midpoint = (previous.x + point.x) / 2
      ctx.bezierCurveTo(midpoint, previous.y, midpoint, point.y, point.x, point.y)
    })
    ctx.lineTo(points[points.length - 1].x, h - padding.bottom)
    ctx.closePath()
    ctx.fillStyle = gradient
    ctx.fill()

    ctx.shadowColor = lineColor
    ctx.shadowBlur = 8
    ctx.strokeStyle = lineColor
    ctx.lineWidth = 2.2
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    points.slice(1).forEach((point, index) => {
      const previous = points[index]
      const midpoint = (previous.x + point.x) / 2
      ctx.bezierCurveTo(midpoint, previous.y, midpoint, point.y, point.x, point.y)
    })
    ctx.stroke()
    ctx.shadowBlur = 0

    points.forEach(p => {
      ctx.beginPath()
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#f6f2ff'
      ctx.fill()
      ctx.lineWidth = 2.5
      ctx.strokeStyle = p.r.isSlow ? slowColor : lineColor
      ctx.stroke()
    })
  }, [collapsed, overlaySize, requests])

  const chartMax = getSparklineChartMax(requests)
  const chartLeftPadding = getSparklineLeftPadding(chartMax)

  return (
    <div className="apidbg-chart-card">
      <div className="apidbg-chart-heading">
        <div>
          <span className="apidbg-chart-title">Response timeline</span>
        </div>
        <span className="apidbg-chart-tools">
          <button
            className="apidbg-chart-toggle"
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Show graph' : 'Minimise graph'}
            title={collapsed ? 'Show graph' : 'Minimise graph'}
          >
            {collapsed ? <ExpandIcon /> : <MinimiseIcon />}
          </button>
        </span>
      </div>
      {!collapsed && (
        <div className="apidbg-sparkline">
          <canvas
            ref={ref}
            onMouseMove={event => {
              const rect = event.currentTarget.getBoundingClientRect()
              const x = event.clientX - rect.left
              const chartX = Math.max(0, x - chartLeftPadding)
              const chartWidth = Math.max(1, rect.width - chartLeftPadding - 4)
              const idx = Math.round((chartX / chartWidth) * (requests.length - 1))
              const r = requests[Math.max(0, Math.min(requests.length - 1, idx))]
              if (r) setHover({ x: event.clientX, y: event.clientY, r })
            }}
            onMouseLeave={() => setHover(null)}
          />
        </div>
      )}
      {!collapsed && hover && (
        <div className="apidbg-tooltip" style={{ top: hover.y - 36, left: hover.x + 8 }}>
          {getPath(hover.r.url)} - {Math.round(hover.r.duration)}ms
        </div>
      )}
    </div>
  )
}

function AICard({
  state,
  text,
  error,
  url,
  onDismiss,
}: {
  state: AISuggestionState
  text?: string
  error?: string
  url: string
  onDismiss: () => void
}) {
  if (state === 'idle') return null

  if (state === 'loading') {
    return (
      <div className="apidbg-ai-card">
        <div className="apidbg-ai-title">
          <SpinnerIcon />
          <span style={{ color: 'var(--api-text-muted)', fontSize: 13 }}>Analysing request...</span>
        </div>
        <div style={{ height: 10, width: '90%', borderRadius: 4, marginTop: 10, background: 'var(--api-surface-raised)' }} />
        <div style={{ height: 10, width: '72%', borderRadius: 4, marginTop: 6, background: 'var(--api-surface-raised)' }} />
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="apidbg-ai-card">
        <div className="apidbg-ai-title">
          <span style={{ color: 'var(--api-danger)', fontSize: 14 }}>!</span>
          <span style={{ color: 'var(--api-text)', fontSize: 13, fontWeight: 700 }}>AI Diagnosis</span>
          <span title={url} style={{ marginLeft: 'auto', color: 'var(--api-text-subtle)', fontSize: 11, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
        </div>
        <div className="apidbg-ai-text">{error ?? 'Unknown error. Check your API key.'}</div>
        <div className="apidbg-ai-footer">
          <button className="apidbg-plain-button" onClick={onDismiss} style={{ marginLeft: 'auto' }}>Dismiss</button>
        </div>
      </div>
    )
  }

  const formatAiText = (value: string) => {
    const lines = value.split('\n')
    const labels = new Set(['General info:', 'Output:', 'Solution to issue:'])

    return lines.map((line, index) => {
      const trimmedLine = line.trim()
      if (labels.has(trimmedLine)) {
        return (
          <React.Fragment key={`label-${index}`}>
            {index > 0 ? '\n' : null}
            <span className="apidbg-ai-section-label">{trimmedLine}</span>
            {'\n'}
          </React.Fragment>
        )
      }

      return (
        <React.Fragment key={`line-${index}`}>
          {line}
          {index < lines.length - 1 ? '\n' : null}
        </React.Fragment>
      )
    })
  }

  const patterns = ['N+1', 'over-fetching', 'waterfall', 'pagination']
  let parts: React.ReactNode[] = [formatAiText(text ?? 'General info:\nNo details available.\n\nOutput:\nNo output returned.\n\nSolution to issue:\nNo suggestion returned.')]

  patterns.forEach(pattern => {
    parts = parts.flatMap(part => {
      if (typeof part !== 'string') return [part]
      return part.split(new RegExp(`(${pattern})`, 'i')).map((segment, index) => (
        segment.toLowerCase() === pattern.toLowerCase()
          ? <span key={`${pattern}-${index}`} className="apidbg-ai-pill">{segment}</span>
          : segment
      ))
    })
  })

  return (
    <div className="apidbg-ai-card">
      <div className="apidbg-ai-title">
        <span style={{ color: 'var(--api-color-primary-soft)', fontSize: 14 }}>*</span>
        <span style={{ color: 'var(--api-text)', fontSize: 13, fontWeight: 700 }}>AI Diagnosis</span>
        <span title={url} style={{ marginLeft: 'auto', color: 'var(--api-text-subtle)', fontSize: 11, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
      </div>
      <div className="apidbg-ai-text">{parts}</div>
      <div className="apidbg-ai-footer">
        <span style={{ color: 'var(--api-text-subtle)', fontSize: 11 }}>Generated just now</span>
        <button className="apidbg-plain-button" onClick={onDismiss} style={{ marginLeft: 'auto' }}>Dismiss</button>
      </div>
    </div>
  )
}

type DetailMetaKind = 'duration' | 'ttfb' | 'timing' | 'request' | 'response' | 'transfer'

function DetailMetaIcon({ kind }: { kind: DetailMetaKind }) {
  if (kind === 'duration') {
    return (
      <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M9 5.2v4.1l2.6 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  if (kind === 'ttfb') {
    return (
      <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M2.2 10h3l1.6-5 2.7 9 1.8-6 1.2 2h3.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  if (kind === 'timing') {
    return (
      <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2.8 9h12.4M9 2.5c1.8 1.8 2.7 4 2.7 6.5S10.8 13.7 9 15.5C7.2 13.7 6.3 11.5 6.3 9S7.2 4.3 9 2.5Z" stroke="currentColor" strokeWidth="1.1" />
      </svg>
    )
  }

  const isUpload = kind === 'request'
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="12" height="12" rx="2.3" stroke="currentColor" strokeWidth="1.3" />
      <path
        d={isUpload ? 'M9 12V6.2M6.8 8.4 9 6.2l2.2 2.2' : 'M9 6v5.8M6.8 9.6 9 11.8l2.2-2.2'}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function MetadataBarItem({
  kind,
  label,
  value,
}: {
  kind: DetailMetaKind
  label: string
  value: string
}) {
  return (
    <div className="apidbg-metadata-item">
      <span className="apidbg-metadata-icon"><DetailMetaIcon kind={kind} /></span>
      <span className="apidbg-metadata-copy">
        <span className="apidbg-metadata-label">{label}</span>
        <span className="apidbg-metadata-value">{value}</span>
      </span>
    </div>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.3" />
      <path d="m10.2 10.2 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3H3v3M10 3h3v3M6 13H3v-3M10 13h3v-3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.2" y="4.8" width="7.3" height="8" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.5 10.5H3a1.5 1.5 0 0 1-1.5-1.5V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function BracesIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 2.5H5.2c-1 0-1.5.5-1.5 1.5v2.2c0 .8-.4 1.2-1.2 1.2.8 0 1.2.4 1.2 1.2V11c0 1 .5 1.5 1.5 1.5H6M10 2.5h.8c1 0 1.5.5 1.5 1.5v2.2c0 .8.4 1.2 1.2 1.2-.8 0-1.2.4-1.2 1.2V11c0 1-.5 1.5-1.5 1.5H10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M7 1.8c.4 2.6 1.6 3.8 4.2 4.2C8.6 6.4 7.4 7.6 7 10.2 6.6 7.6 5.4 6.4 2.8 6 5.4 5.6 6.6 4.4 7 1.8ZM12.3 9.5c.2 1.4.9 2.1 2.3 2.3-1.4.2-2.1.9-2.3 2.3-.2-1.4-.9-2.1-2.3-2.3 1.4-.2 2.1-.9 2.3-2.3Z" fill="currentColor" />
    </svg>
  )
}

function ReplayIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m5.2 3.2 6.4 4.2a.8.8 0 0 1 0 1.3l-6.4 4.1A.8.8 0 0 1 4 12.2V3.8a.8.8 0 0 1 1.2-.6Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

function formatRequestTimestamp(startTime: number) {
  return new Date(startTime).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatRelativeTime(startTime: number) {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - startTime) / 1000))
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  return `${elapsedHours}h ago`
}

function RequestRow({ req }: { req: RequestEntry }) {
  const settings = useSettings()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<JsonTab>('response')
  const [search, setSearch] = useState('')
  const [forceExpand, setForceExpand] = useState<JsonExpandMode>(null)
  const [aiState, setAiState] = useState<AISuggestionState>('idle')
  const [aiSuggestion, setAiSuggestion] = useState('')
  const [aiError, setAiError] = useState('')
  const [copied, setCopied] = useState(false)

  const path = useMemo(() => getPath(req.url), [req.url])
  const parsedBody = useMemo(() => parseBody(req.responseBody), [req.responseBody])
  const requestObj = useMemo(() => ({
    method: req.method,
    url: req.url,
    headers: req.requestHeaders,
    body: req.requestBody,
  }), [req])

  const jsonValue = tab === 'response' ? parsedBody ?? { body: null } : requestObj
  const isLargePayload = req.responseSize > settings.largePayloadThresholdKb * 1024

  const copyJson = () => {
    navigator.clipboard?.writeText(
      tab === 'response'
        ? (req.responseBody ?? JSON.stringify(jsonValue, null, 2))
        : JSON.stringify(requestObj, null, 2),
    )
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const replayRequest = () => {
    void sendRuntimeMessage({
      type: 'SELECT_REPLAY',
      payload: {
        id: req.id,
        method: req.method,
        url: req.url,
        headers: req.requestHeaders,
        body: req.requestBody,
        originalResponseBody: req.responseBody,
      },
    })
  }

  const triggerAI = async () => {
    setAiState('loading')
    setAiError('')

    try {
      const response = await sendRuntimeMessage({
        type: 'ASK_AI_SUGGESTION',
        payload: {
          id: req.id,
          method: req.method,
          url: req.url,
          status: req.status,
          duration: req.duration,
          ttfb: req.ttfb,
          responseSize: req.responseSize,
          isSlow: req.isSlow,
          isDuplicate: req.isDuplicate,
          duplicateCount: req.duplicateCount,
          dependsOnCount: req.dependsOn.length,
        },
      }) as AISuggestionResponse | undefined

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Unable to ask AI. Check the extension service worker.')
      }

      setAiSuggestion(response.suggestion ?? 'No suggestion returned.')
      setAiState('result')
    } catch (err: unknown) {
      setAiState('error')
      setAiError(err instanceof Error ? err.message : 'Unknown error. Check your API key.')
    }
  }

  return (
    <div
      className={`apidbg-row-wrap${req.duplicateCount > 1 ? ' has-duplicates' : ''}`}
      data-method={req.method.toLowerCase()}
    >
      <div
        className="apidbg-row"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${req.method} ${path}, status ${req.status || 'unknown'}, ${Math.round(req.duration)} milliseconds`}
        onClick={() => setOpen(o => !o)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(o => !o)
          }
        }}
      >
        <MethodBadge method={req.method} />
        <span className="apidbg-endpoint-cell">
          <span className="apidbg-path" title={req.url}>{path}</span>
          {(req.duplicateCount > 1 || req.isSlow || isLargePayload) && (
            <span className="apidbg-row-flags">
              {req.duplicateCount > 1 && <DupBadge count={req.duplicateCount} />}
              {req.isSlow && <SlowBadge />}
              {isLargePayload && <LargePayloadBadge size={req.responseSize} />}
            </span>
          )}
        </span>
        <StatusBadge status={req.status} />
        <TimingSourceChip source={req.timingSource} />
        <Duration ms={req.duration} />
        <svg
          className={`apidbg-chevron${open ? ' is-open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 4L6 8L10 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {open && (
        <div className="apidbg-detail">
          <div className="apidbg-detail-toolbar">
            <div className="apidbg-tabs">
              {(['response', 'request'] as const).map(t => (
                <button
                  key={t}
                  className={`apidbg-tab${tab === t ? ' is-active' : ''}`}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="apidbg-row-tools">
              <label className="apidbg-search-wrap">
                <SearchIcon />
                <input
                  className="apidbg-search"
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Search keys..."
                />
              </label>
            </div>
          </div>

          <div className="apidbg-metadata-bar">
            <MetadataBarItem kind="ttfb" label="TTFB" value={req.ttfb > 0 ? `${req.ttfb}ms` : '-'} />
            <MetadataBarItem kind="timing" label="Timing" value={formatTimingSourceLabel(req.timingSource)} />
            <MetadataBarItem kind="request" label="Request" value={formatBytes(req.requestSize)} />
            <MetadataBarItem kind="response" label="Response" value={formatBytes(req.responseSize)} />
          </div>

          {(isLargePayload || req.duplicateCount > 1) && (
            <div className="apidbg-detail-context">
              {isLargePayload && (
                <span>Payload limit <strong>{formatBytes(settings.largePayloadThresholdKb * 1024)}</strong></span>
              )}
              {req.duplicateCount > 1 && (
                <span>Duplicate group <strong>{req.duplicateCount} calls</strong></span>
              )}
            </div>
          )}

          <div className="apidbg-json-editor">
            <div className="apidbg-editor-actions">
              <button
                className={`apidbg-editor-action${copied ? ' is-success' : ''}`}
                type="button"
                onClick={copyJson}
                aria-label="Copy JSON"
                title="Copy JSON"
              >
                <CopyIcon />
              </button>
              <button
                className="apidbg-editor-action"
                type="button"
                onClick={() => setForceExpand(null)}
                aria-label="JSON formatted view"
                title="JSON formatted view"
              >
                <BracesIcon />
              </button>
              <button
                className="apidbg-editor-action"
                type="button"
                onClick={() => setForceExpand(forceExpand === 'all' ? 'none' : 'all')}
                aria-label={forceExpand === 'all' ? 'Collapse all JSON' : 'Expand all JSON'}
                title={forceExpand === 'all' ? 'Collapse all' : 'Expand all'}
              >
                <ExpandIcon />
              </button>
            </div>

            <div className="apidbg-editor-body">
              <div
                className="apidbg-json-box apidbg-scroll"
                role="tree"
                aria-label={`${tab === 'response' ? 'Response' : 'Request'} JSON tree`}
              >
                <JsonNode
                  value={jsonValue}
                  depth={0}
                  search={search}
                  forceExpand={forceExpand}
                  path={tab}
                />
              </div>
            </div>

            <div className="apidbg-json-footer">
              <span className="apidbg-json-meta">
                {formatBytes(tab === 'response' ? req.responseSize : req.requestSize)} &middot; {countKeys(jsonValue)} keys
              </span>
              <span className="apidbg-json-footer-actions">
                <span className="apidbg-json-format">
                  JSON
                  <svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="m2 3.5 3 3 3-3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <button
                  className="apidbg-copy-json"
                  onClick={copyJson}
                  style={{ color: copied ? 'var(--api-success)' : undefined }}
                >
                  {copied ? 'Copied' : 'Copy JSON'}
                </button>
              </span>
            </div>
          </div>

          <div className="apidbg-detail-actions">
            <div className="apidbg-detail-action-buttons">
              <button className="apidbg-primary-button" onClick={triggerAI}>
                <SparkleIcon />
                Ask AI
              </button>
              <button className="apidbg-secondary-button" onClick={replayRequest}>
                <ReplayIcon />
                Replay
              </button>
            </div>
            <div className="apidbg-request-time">
              <span>{formatRequestTimestamp(req.startTime)}</span>
              <span className="apidbg-time-separator">&middot;</span>
              <span>{formatRelativeTime(req.startTime)}</span>
              <button
                className="apidbg-collapse-detail"
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Collapse details"
                title="Collapse details"
              >
                <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="m2 8 4-4 4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>

          <AICard
            state={aiState}
            url={path}
            text={aiSuggestion || req.aiSuggestion || 'No suggestion returned.'}
            error={aiError}
            onDismiss={() => setAiState('idle')}
          />
        </div>
      )}
    </div>
  )
}

function EmptyFeed() {
  return (
    <div className="apidbg-empty">
      <svg width="40" height="40" viewBox="0 0 40 40" className="apidbg-wave">
        <path d="M2 20 Q 10 8 18 20 T 34 20" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
        <path d="M2 26 Q 10 14 18 26 T 34 26" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.5" />
      </svg>
      <div style={{ color: 'var(--api-text-subtle)', fontSize: 13, fontWeight: 600 }}>Waiting for requests</div>
      <div style={{ color: 'var(--api-border-strong)', fontSize: 12 }}>Navigate or interact with the page</div>
    </div>
  )
}

class OverlayErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 12, color: '#F87171', fontSize: 12 }}>
          Overlay error - reload the page to reset.
        </div>
      )
    }

    return this.props.children
  }
}

function positionClass(position: ApiDebuggerSettings['overlayPosition']) {
  return `is-${position.toLowerCase().replaceAll(' ', '-')}`
}

function sizeClass(size: ApiDebuggerSettings['overlaySize']) {
  return `is-size-${size.toLowerCase()}`
}

function getInitialOverlayState(settings: ApiDebuggerSettings, initialPaused: boolean): OverlayState {
  if (!settings.captureEnabled) return 'hidden'
  if (!settings.showOverlayOnLoad) return 'minimised'
  if (initialPaused) return 'paused'
  return 'feed'
}

export function Overlay({ initialPaused }: { initialPaused: boolean }) {
  const settings = useSettings()
  const updateSettings = useUpdateSettings()
  const [requests, setRequests] = useState<RequestEntry[]>([])
  const [totalRequests, setTotalRequests] = useState(0)
  const [state, setState] = useState<OverlayState>(() => getInitialOverlayState(settings, initialPaused))
  const [sweep, setSweep] = useState(false)
  const [graphCollapsed, setGraphCollapsed] = useState(false)
  const effectiveState: OverlayState = !settings.captureEnabled
    ? 'hidden'
    : (state === 'hidden' ? getInitialOverlayState({ ...settings, captureEnabled: true }, initialPaused) : state)
  const stateRef = useRef<OverlayState>(state)
  const pausedRef = useRef(initialPaused)
  const bufferedRequestsRef = useRef<RequestEntry[]>([])
  const trackedRequestIdsRef = useRef<Set<string>>(new Set())

  const upsertRequest = (currentRequests: RequestEntry[], nextRequest: RequestEntry) => {
    const existingIndex = currentRequests.findIndex(request => request.id === nextRequest.id)
    if (existingIndex === -1) {
      return [nextRequest, ...currentRequests].slice(0, 100)
    }

    const nextRequests = [...currentRequests]
    nextRequests[existingIndex] = nextRequest
    return nextRequests
  }

  const upsertBufferedRequest = (nextRequest: RequestEntry) => {
    const currentBuffered = bufferedRequestsRef.current
    const existingIndex = currentBuffered.findIndex(request => request.id === nextRequest.id)

    if (existingIndex === -1) {
      bufferedRequestsRef.current = [nextRequest, ...currentBuffered].slice(0, 100)
    } else {
      const nextBuffered = [...currentBuffered]
      nextBuffered[existingIndex] = nextRequest
      bufferedRequestsRef.current = nextBuffered
    }

  }

  useEffect(() => {
    const handler = (msg: unknown) => {
      if (isRequestCompleteMessage(msg)) {
        if (!trackedRequestIdsRef.current.has(msg.payload.id)) {
          trackedRequestIdsRef.current.add(msg.payload.id)
          setTotalRequests(current => current + 1)
        }
        if (stateRef.current === 'paused') {
          upsertBufferedRequest(msg.payload)
          return
        }
        setRequests(prev => upsertRequest(prev, msg.payload))
      }
      if (isRequestUpdatedMessage(msg)) {
        if (!trackedRequestIdsRef.current.has(msg.payload.id)) {
          trackedRequestIdsRef.current.add(msg.payload.id)
          setTotalRequests(current => current + 1)
        }
        if (stateRef.current === 'paused') {
          upsertBufferedRequest(msg.payload)
          return
        }
        setRequests(prev => upsertRequest(prev, msg.payload))
      }
    }
    try {
      if (!chrome.runtime?.id) return

      chrome.runtime.onMessage.addListener(handler)
      return () => {
        try {
          chrome.runtime.onMessage.removeListener(handler)
        } catch {
          // Extension context may be unavailable after a reload.
        }
      }
    } catch {
      return
    }
  }, [])

  useEffect(() => {
    stateRef.current = effectiveState

    if (effectiveState !== 'feed' || bufferedRequestsRef.current.length === 0) {
      return
    }

    setRequests(currentRequests => (
      bufferedRequestsRef.current.reduce(
        (nextRequests, bufferedRequest) => upsertRequest(nextRequests, bufferedRequest),
        currentRequests,
      )
    ))
    bufferedRequestsRef.current = []
  }, [effectiveState])

  const visibleRequestCount = requests.length
  const total = totalRequests
  const avg = visibleRequestCount ? Math.round(requests.reduce((sum, r) => sum + r.duration, 0) / visibleRequestCount) : 0
  const errors = requests.filter(r => r.status >= 400).length
  const errorRate = visibleRequestCount ? Math.round((errors / visibleRequestCount) * 1000) / 10 : 0
  const dupes = requests.filter(r => r.isDuplicate).length
  const isCapturing = effectiveState !== 'paused'
  const showSparkline = settings.showOverlayGraph && requests.length >= 3
  const overlayPositionClass = positionClass(settings.overlayPosition)
  const overlaySizeClass = sizeClass(settings.overlaySize)

  const openSidePanel = () => {
    void sendRuntimeMessage({ type: 'OPEN_SIDE_PANEL' })
  }

  const clearSession = () => {
    setSweep(true)
    window.setTimeout(() => {
      setRequests([])
      setTotalRequests(0)
      bufferedRequestsRef.current = []
      trackedRequestIdsRef.current = new Set()
      void sendRuntimeMessage({ type: 'CLEAR_SESSION' })
      setSweep(false)
    }, 300)
  }

  const expandOverlay = () => {
    setState(pausedRef.current ? 'paused' : 'feed')
    persistShowOnLoad(true)
  }

  const persistShowOnLoad = (showOverlayOnLoad: boolean) => {
    const nextSettings = {
      ...settings,
      showOverlayOnLoad,
    }

    updateSettings(nextSettings)
    void saveSettings(nextSettings).catch(() => {
      // Ignore transient extension storage errors during reloads.
    })
  }

  const setPausedState = (paused: boolean) => {
    pausedRef.current = paused
    setState(paused ? 'paused' : 'feed')
    void sendRuntimeMessage({
      type: 'SET_OVERLAY_PAUSED',
      payload: { paused },
    })
  }

  if (effectiveState === 'hidden') {
    return null
  }

  if (effectiveState === 'minimised') {
    return (
      <>
        <style>{overlayThemeCss}</style>
        <button
          className={`apidbg-minimised ${overlayPositionClass} ${overlaySizeClass}`}
          onClick={expandOverlay}
        >
          <LiveDot isCapturing />
          <span>API</span>
          <span style={{ color: 'var(--api-text-subtle)', fontSize: 10 }}>^</span>
        </button>
      </>
    )
  }

  return (
    <>
      <style>{overlayThemeCss}</style>
      <div className={`apidbg-overlay ${overlayPositionClass} ${overlaySizeClass}`}>
        <div className="apidbg-header">
          <div className="apidbg-title-row">
            <div className="apidbg-brand">
              <BrandMark />
              <div className="apidbg-title">
                <span>API Debugger</span>
                <span className="apidbg-title-caption">Live network intelligence</span>
              </div>
            </div>
            <div className="apidbg-actions">
              {requests.length > 0 && (
                <button
                  className="apidbg-header-button"
                  onClick={clearSession}
                  aria-label="Clear session"
                  title="Clear"
                >
                  <TrashIcon />
                  <span>Clear</span>
                </button>
              )}
              <button
                className="apidbg-icon-button"
                onClick={() => setPausedState(isCapturing)}
                aria-label={isCapturing ? 'Pause capture' : 'Resume capture'}
                title={isCapturing ? 'Pause' : 'Resume'}
              >
                {isCapturing ? <PauseIcon /> : <PlayIcon />}
              </button>
              <button
                className="apidbg-icon-button"
                onClick={openSidePanel}
                aria-label="Open side panel"
                title="Open side panel"
              >
                <SidePanelIcon />
              </button>
                <button
                  className="apidbg-icon-button"
                  onClick={() => {
                    setState('minimised')
                    persistShowOnLoad(false)
                  }}
                  aria-label="Minimise overlay"
                  title="Minimise"
                >
                <MinimiseIcon />
              </button>
            </div>
          </div>

          <div className="apidbg-metrics">
            <MetricCard label="Total calls" value={String(total)} detail="captured" tone="purple" />
            <MetricCard
              label="Avg response"
              value={`${avg}ms`}
              detail={avg < 300 ? 'healthy' : avg <= 800 ? 'moderate' : 'slow'}
              tone={avg < 300 ? 'green' : avg <= 800 ? 'amber' : 'danger'}
            />
            <MetricCard label="Errors" value={String(errors)} detail={`${errorRate}% rate`} tone={errors > 0 ? 'danger' : 'green'} />
            <MetricCard label="Duplicates" value={String(dupes)} detail="matching calls" tone={dupes > 0 ? 'amber' : 'purple'} />
          </div>
        </div>

        {showSparkline && (
          <Sparkline
            requests={requests}
            overlaySize={settings.overlaySize}
            collapsed={graphCollapsed}
            onToggleCollapsed={() => setGraphCollapsed(value => !value)}
          />
        )}

        {effectiveState === 'paused' && (
          <div className="apidbg-paused">
            <span>Capture paused - new requests are ignored</span>
            <button className="apidbg-link-button" onClick={() => setPausedState(false)}>Resume</button>
          </div>
        )}

        <div className="apidbg-table-shell">
          <div className="apidbg-table-head" aria-hidden="true">
            <span>Method</span>
            <span>Endpoint</span>
            <span>Status</span>
            <span>Region</span>
            <span>Time</span>
            <span />
          </div>
          <OverlayErrorBoundary>
            <div className={`apidbg-list apidbg-scroll${effectiveState === 'paused' ? ' is-paused' : ''}`}>
              {sweep && <div className="apidbg-sweep" />}
              {requests.length === 0 ? <EmptyFeed /> : requests.map(r => <RequestRow key={r.id} req={r} />)}
            </div>
          </OverlayErrorBoundary>
        </div>
      </div>
    </>
  )
}


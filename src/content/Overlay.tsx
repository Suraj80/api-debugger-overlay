import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { RequestEntry } from '../shared/types'

interface RequestCompleteMessage {
  type: 'REQUEST_COMPLETE'
  payload: RequestEntry
}

type OverlayState = 'feed' | 'paused' | 'minimised'
type JsonExpandMode = 'all' | 'none' | null
type JsonTab = 'response' | 'request'
type AISuggestionState = 'idle' | 'loading' | 'result'

function isRequestCompleteMessage(msg: unknown): msg is RequestCompleteMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as { type?: unknown }).type === 'REQUEST_COMPLETE' &&
    'payload' in msg
  )
}

const overlayThemeCss = `
  :host {
    color-scheme: dark;
    --api-color-primary: #8069bf;
    --api-color-primary-soft: #cbb8ff;
    --api-color-primary-strong: #3a1670;
    --api-color-secondary: #7c7296;
    --api-color-secondary-soft: #d9d0ef;
    --api-color-tertiary: #c9a74d;
    --api-color-tertiary-soft: #ffe6a2;
    --api-color-neutral: #79767d;
    --api-bg: #121015;
    --api-surface: #1e1b22;
    --api-surface-raised: #292630;
    --api-border: #403a49;
    --api-border-strong: #5d536b;
    --api-text: #eee8f5;
    --api-text-muted: #9c96a6;
    --api-text-subtle: #79737f;
    --api-danger: #ff8f8f;
    --api-danger-bg: #3f1518;
    --api-success: #8fe6bc;
    --api-warning: #ffd36f;
  }

  @keyframes apidbg-pulse-glow {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.7; transform: scale(1.15); }
  }

  @keyframes apidbg-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  @keyframes apidbg-slide-in-up {
    from { transform: translateY(8px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  @keyframes apidbg-sweep {
    0% { top: 0; opacity: 0.3; }
    100% { top: 100%; opacity: 0; }
  }

  @keyframes apidbg-pulse-soft {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }

  @keyframes apidbg-wave-pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  .apidbg-overlay,
  .apidbg-minimised {
    box-sizing: border-box;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .apidbg-overlay *,
  .apidbg-minimised * {
    box-sizing: border-box;
  }

  .apidbg-overlay button,
  .apidbg-overlay input,
  .apidbg-minimised button {
    font: inherit;
  }

  .apidbg-overlay {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147483647;
    display: flex;
    width: 380px;
    max-height: 60vh;
    overflow: hidden;
    flex-direction: column;
    border: 1px solid var(--api-border);
    border-radius: 8px;
    background: var(--api-bg);
    color: var(--api-text);
    box-shadow: 0 25px 50px rgba(0, 0, 0, 0.58);
  }

  .apidbg-header {
    flex-shrink: 0;
    border-bottom: 1px solid var(--api-border);
    background: var(--api-bg);
    padding: 10px 14px;
  }

  .apidbg-title-row,
  .apidbg-title,
  .apidbg-actions,
  .apidbg-chip-row,
  .apidbg-paused,
  .apidbg-row,
  .apidbg-row-tools,
  .apidbg-tabs,
  .apidbg-detail-actions,
  .apidbg-ai-title,
  .apidbg-ai-footer,
  .apidbg-minimised {
    display: flex;
    align-items: center;
  }

  .apidbg-title-row {
    justify-content: space-between;
    gap: 12px;
  }

  .apidbg-title {
    gap: 8px;
    min-width: 0;
    font-size: 13px;
    font-weight: 750;
  }

  .apidbg-actions {
    gap: 10px;
  }

  .apidbg-icon-button {
    border: 0;
    background: none;
    color: var(--api-text-subtle);
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
    padding: 2px;
  }

  .apidbg-icon-button:hover {
    color: var(--api-color-primary-soft);
  }

  .apidbg-chip-row {
    gap: 6px;
    margin-top: 8px;
    flex-wrap: wrap;
  }

  .apidbg-chip {
    border-radius: 99px;
    background: var(--api-surface-raised);
    color: var(--chip-color, var(--api-text-muted));
    font-size: 11px;
    padding: 3px 10px;
  }

  .apidbg-sparkline {
    position: relative;
    padding: 0 12px 4px;
  }

  .apidbg-sparkline canvas {
    display: block;
    width: 100%;
    height: 36px;
  }

  .apidbg-tooltip {
    position: fixed;
    z-index: 2147483647;
    pointer-events: none;
    border: 1px solid var(--api-border);
    border-radius: 6px;
    background: var(--api-surface-raised);
    color: var(--api-text);
    font-size: 11px;
    padding: 4px 8px;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .apidbg-paused {
    justify-content: center;
    gap: 12px;
    background: rgba(201, 167, 77, 0.18);
    color: var(--api-warning);
    font-size: 12px;
    padding: 6px;
    text-align: center;
  }

  .apidbg-link-button {
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    text-decoration: underline;
  }

  .apidbg-list {
    position: relative;
    flex: 1;
    overflow-y: auto;
    transition: opacity 0.2s;
  }

  .apidbg-list.is-paused {
    opacity: 0.5;
  }

  .apidbg-sweep {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 2;
    height: 1px;
    background: rgba(238, 232, 245, 0.35);
    animation: apidbg-sweep 0.3s linear forwards;
  }

  .apidbg-row-wrap {
    border-bottom: 1px solid rgba(64, 58, 73, 0.7);
  }

  .apidbg-row {
    gap: 8px;
    height: 40px;
    padding: 0 12px;
    background: var(--api-bg);
    cursor: pointer;
    transition: background 0.1s;
  }

  .apidbg-row:hover {
    background: var(--api-surface);
  }

  .apidbg-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--api-text-muted);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .apidbg-chevron {
    color: var(--api-text-subtle);
    font-size: 14px;
    transition: transform 0.15s ease;
  }

  .apidbg-chevron.is-open {
    transform: rotate(180deg);
  }

  .apidbg-detail {
    border-top: 1px solid var(--api-border);
    background: var(--api-bg);
    padding: 12px;
  }

  .apidbg-detail-header {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .apidbg-tabs {
    gap: 12px;
  }

  .apidbg-tab {
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--api-text-subtle);
    cursor: pointer;
    font-size: 12px;
    padding: 4px 0;
    text-transform: capitalize;
  }

  .apidbg-tab.is-active {
    border-bottom-color: var(--api-color-primary-soft);
    color: var(--api-text);
  }

  .apidbg-row-tools {
    gap: 8px;
  }

  .apidbg-search {
    width: 120px;
    border: 1px solid var(--api-border);
    border-radius: 6px;
    background: var(--api-surface);
    color: var(--api-text);
    font-size: 11px;
    outline: none;
    padding: 3px 8px;
  }

  .apidbg-search:focus {
    border-color: var(--api-color-primary-soft);
  }

  .apidbg-plain-button {
    border: 0;
    background: none;
    color: var(--api-text-subtle);
    cursor: pointer;
    font-size: 11px;
    padding: 0;
  }

  .apidbg-plain-button:hover {
    color: var(--api-color-primary-soft);
  }

  .apidbg-json-box {
    max-height: 280px;
    overflow-y: auto;
    border: 1px solid var(--api-border);
    border-radius: 6px 6px 0 0;
    background: #18151d;
    padding: 8px;
  }

  .apidbg-json-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 28px;
    margin-top: -1px;
    border: 1px solid var(--api-border);
    border-top: 0;
    border-radius: 0 0 6px 6px;
    background: var(--api-surface);
    padding: 0 12px;
  }

  .apidbg-json-meta {
    color: var(--api-text-subtle);
    font-size: 11px;
  }

  .apidbg-detail-actions {
    gap: 8px;
    padding-top: 8px;
  }

  .apidbg-primary-button,
  .apidbg-secondary-button {
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    padding: 5px 12px;
  }

  .apidbg-primary-button {
    border: 0;
    background: var(--api-color-primary);
    color: var(--api-text);
  }

  .apidbg-secondary-button {
    border: 1px solid var(--api-border);
    background: var(--api-surface);
    color: var(--api-text-muted);
  }

  .apidbg-ai-card {
    margin-top: 8px;
    border-left: 3px solid var(--api-color-primary-soft);
    border-radius: 6px;
    background: var(--api-surface);
    padding: 12px;
    animation: apidbg-slide-in-up 0.2s ease-out;
  }

  .apidbg-ai-title {
    gap: 8px;
  }

  .apidbg-ai-text {
    color: var(--api-text-muted);
    font-size: 13px;
    line-height: 1.6;
    margin-top: 8px;
  }

  .apidbg-ai-pill {
    margin: 0 2px;
    border-radius: 4px;
    background: rgba(201, 167, 77, 0.18);
    color: var(--api-warning);
    font-size: 11px;
    font-weight: 650;
    padding: 1px 6px;
  }

  .apidbg-ai-footer {
    margin-top: 8px;
  }

  .apidbg-footer {
    display: flex;
    justify-content: flex-end;
    flex-shrink: 0;
    border-top: 1px solid var(--api-border);
    background: var(--api-bg);
    padding: 6px 12px;
  }

  .apidbg-minimised {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147483647;
    gap: 6px;
    border: 1px solid var(--api-border);
    border-radius: 99px;
    background: var(--api-surface);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.35);
    color: var(--api-text-muted);
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    padding: 6px 12px;
  }

  .apidbg-live-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 99px;
    background: var(--api-text-subtle);
  }

  .apidbg-live-dot.is-capturing {
    background: var(--api-success);
    box-shadow: 0 0 8px var(--api-success);
    animation: apidbg-pulse-glow 2s ease-in-out infinite;
  }

  .apidbg-method {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 52px;
    height: 20px;
    border-radius: 4px;
    background: var(--method-bg, var(--api-surface-raised));
    color: var(--method-color, var(--api-color-primary-soft));
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.4px;
  }

  .apidbg-status,
  .apidbg-duration {
    color: var(--badge-color, var(--api-text-muted));
    font-size: 11px;
    font-weight: 700;
  }

  .apidbg-duration {
    min-width: 52px;
    text-align: right;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .apidbg-badge {
    border: 1px solid var(--badge-border, var(--api-border));
    border-radius: 3px;
    background: var(--badge-bg, var(--api-surface));
    color: var(--badge-color, var(--api-text-muted));
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.4px;
    padding: 1px 6px;
    animation: apidbg-pulse-soft 1.6s ease-in-out infinite;
  }

  .apidbg-spinner {
    display: inline-block;
    animation: apidbg-spin 0.9s linear infinite;
  }

  .apidbg-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 40px 16px;
    text-align: center;
  }

  .apidbg-wave {
    color: var(--api-border-strong);
    animation: apidbg-wave-pulse 2s ease-in-out infinite;
  }

  .apidbg-scroll::-webkit-scrollbar {
    width: 4px;
    height: 4px;
  }

  .apidbg-scroll::-webkit-scrollbar-track {
    background: transparent;
  }

  .apidbg-scroll::-webkit-scrollbar-thumb {
    background: var(--api-border-strong);
    border-radius: 99px;
  }
`

function LiveDot({ isCapturing }: { isCapturing: boolean }) {
  return <span className={`apidbg-live-dot${isCapturing ? ' is-capturing' : ''}`} />
}

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    GET: { bg: 'rgba(203, 184, 255, 0.18)', color: 'var(--api-color-primary-soft)' },
    POST: { bg: 'rgba(143, 230, 188, 0.14)', color: 'var(--api-success)' },
    PUT: { bg: 'rgba(201, 167, 77, 0.2)', color: 'var(--api-warning)' },
    PATCH: { bg: 'rgba(128, 105, 191, 0.26)', color: 'var(--api-color-secondary-soft)' },
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
  const color = status >= 500
    ? 'var(--api-danger)'
    : status >= 400
      ? 'var(--api-warning)'
      : status >= 200 && status < 300
        ? 'var(--api-success)'
        : 'var(--api-text-muted)'

  return <span className="apidbg-status" style={{ '--badge-color': color } as React.CSSProperties}>{status || '-'}</span>
}

function Duration({ ms }: { ms: number }) {
  const color = ms >= 1500 ? 'var(--api-danger)' : ms >= 500 ? 'var(--api-warning)' : 'var(--api-success)'
  const display = ms > 999 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`

  return <span className="apidbg-duration" style={{ '--badge-color': color } as React.CSSProperties}>{display}</span>
}

function DupBadge() {
  return (
    <span
      className="apidbg-badge"
      style={{
        '--badge-bg': 'rgba(201, 167, 77, 0.18)',
        '--badge-border': 'rgba(201, 167, 77, 0.45)',
        '--badge-color': 'var(--api-warning)',
      } as React.CSSProperties}
    >
      DUP
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

function SpinnerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="apidbg-spinner">
      <circle cx="12" cy="12" r="9" stroke="var(--api-color-primary-soft)" strokeWidth="2.5" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="var(--api-color-primary-soft)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

function Chip({ label, color }: { label: string; color: string }) {
  return <span className="apidbg-chip" style={{ '--chip-color': color } as React.CSSProperties}>{label}</span>
}

function JsonNode({
  k,
  value,
  depth,
  search,
  forceExpand,
}: {
  k?: string
  value: unknown
  depth: number
  search: string
  forceExpand: JsonExpandMode
}) {
  const [open, setOpen] = useState(depth < 2)
  const isOpen = forceExpand === 'all' ? true : forceExpand === 'none' ? false : open

  const isObj = value && typeof value === 'object' && !Array.isArray(value)
  const isArr = Array.isArray(value)
  const matches = Boolean(search && k && k.toLowerCase().includes(search.toLowerCase()))
  const dim = search && !matches && k ? 0.3 : 1
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
          onClick={() => setOpen(o => !o)}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, paddingLeft: indent }}
        >
          <span style={{ display: 'inline-block', width: 10, color: 'var(--api-text-subtle)', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', fontSize: 10 }}>
            {'>'}
          </span>
          {k !== undefined && (
            <span style={{ color: matches ? 'var(--api-warning)' : 'var(--api-color-primary-soft)', background: matches ? 'rgba(201, 167, 77, 0.18)' : undefined, fontFamily: 'ui-monospace, monospace', fontSize: 12, padding: matches ? '0 2px' : 0, borderRadius: matches ? 2 : 0 }}>
              "{k}"
            </span>
          )}
          {k !== undefined && <span style={{ color: 'var(--api-text-subtle)' }}>:</span>}
          {!isOpen && (
            <span style={{ color: 'var(--api-text-subtle)', fontSize: 12 }}>
              {isArr ? `[...] ${count} items` : `{...} ${count} keys`}
            </span>
          )}
          {isOpen && <span style={{ color: 'var(--api-text-subtle)' }}>{isArr ? '[' : '{'}</span>}
        </div>
        {isOpen && (
          <div>
            {entries.map(([ck, cv]) => (
              <JsonNode key={ck} k={ck} value={cv} depth={depth + 1} search={search} forceExpand={forceExpand} />
            ))}
            <div style={{ paddingLeft: indent + 14, color: 'var(--api-text-subtle)', fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
              {isArr ? ']' : '}'}
            </div>
          </div>
        )}
      </div>
    )
  }

  let valStr = ''
  let valColor = 'var(--api-text)'
  let italic = false

  if (typeof value === 'string') {
    valStr = `"${value}"`
    valColor = 'var(--api-success)'
  } else if (typeof value === 'number') {
    valStr = String(value)
    valColor = 'var(--api-warning)'
  } else if (typeof value === 'boolean') {
    valStr = String(value)
    valColor = 'var(--api-color-primary-soft)'
  } else if (value === null) {
    valStr = 'null'
    valColor = 'var(--api-text-subtle)'
    italic = true
  }

  return (
    <div style={{ opacity: dim, paddingLeft: indent + 14, fontFamily: 'ui-monospace, monospace', fontSize: 12, display: 'flex', gap: 6 }}>
      {k !== undefined && (
        <>
          <span style={{ color: matches ? 'var(--api-warning)' : 'var(--api-color-primary-soft)', background: matches ? 'rgba(201, 167, 77, 0.18)' : undefined, padding: matches ? '0 2px' : 0, borderRadius: matches ? 2 : 0 }}>
            "{k}"
          </span>
          <span style={{ color: 'var(--api-text-subtle)' }}>:</span>
        </>
      )}
      <span style={{ color: valColor, fontStyle: italic ? 'italic' : 'normal' }}>{valStr}</span>
    </div>
  )
}

function countKeys(v: unknown): number {
  if (!v || typeof v !== 'object') return 0
  if (Array.isArray(v)) return v.reduce((a: number, x) => a + countKeys(x), 0)
  return Object.keys(v).length + Object.values(v).reduce((a: number, x) => a + countKeys(x), 0)
}

function parseBody(body: string | null): unknown {
  if (!body) return null

  try {
    return JSON.parse(body)
  } catch {
    return { body }
  }
}

function getPath(url: string) {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}

function Sparkline({ requests }: { requests: RequestEntry[] }) {
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
    if (requests.length < 2) return

    const styles = getComputedStyle(c)
    const lineColor = styles.getPropertyValue('--api-color-primary-soft').trim() || '#cbb8ff'
    const slowColor = styles.getPropertyValue('--api-danger').trim() || '#ff8f8f'
    const max = Math.max(...requests.map(r => r.duration), 100)
    const points = requests.map((r, i) => ({
      x: (i / (requests.length - 1)) * (w - 8) + 4,
      y: h - 6 - (r.duration / max) * (h - 12),
      r,
    }))

    ctx.strokeStyle = lineColor
    ctx.lineWidth = 1.2
    ctx.beginPath()
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.stroke()

    points.forEach(p => {
      ctx.beginPath()
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2)
      ctx.fillStyle = p.r.isSlow ? slowColor : lineColor
      ctx.fill()
    })
  }, [requests])

  return (
    <div className="apidbg-sparkline">
      <canvas
        ref={ref}
        onMouseMove={event => {
          const rect = event.currentTarget.getBoundingClientRect()
          const x = event.clientX - rect.left
          const idx = Math.round((x / rect.width) * (requests.length - 1))
          const r = requests[idx]
          if (r) setHover({ x: event.clientX, y: event.clientY, r })
        }}
        onMouseLeave={() => setHover(null)}
      />
      {hover && (
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
  url,
  onDismiss,
}: {
  state: AISuggestionState
  text?: string
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

  const patterns = ['N+1', 'over-fetching', 'waterfall', 'pagination']
  let parts: React.ReactNode[] = [text ?? 'This endpoint may benefit from checking repeated calls, payload size, and response latency.']

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

function RequestRow({ req }: { req: RequestEntry }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<JsonTab>('response')
  const [search, setSearch] = useState('')
  const [forceExpand, setForceExpand] = useState<JsonExpandMode>(null)
  const [aiState, setAiState] = useState<AISuggestionState>('idle')
  const [copied, setCopied] = useState(false)

  const path = useMemo(() => getPath(req.url), [req.url])
  const parsedBody = useMemo(() => parseBody(req.responseBody), [req.responseBody])
  const requestObj = useMemo(() => ({
    method: req.method,
    url: req.url,
    headers: req.requestHeaders,
    requestSize: req.requestSize,
    fingerprint: req.fingerprint,
  }), [req])

  const jsonValue = tab === 'response' ? parsedBody ?? { body: null } : requestObj

  const triggerAI = () => {
    setAiState('loading')
    window.setTimeout(() => setAiState('result'), 800)
  }

  return (
    <div className="apidbg-row-wrap">
      <div className="apidbg-row" onClick={() => setOpen(o => !o)}>
        <MethodBadge method={req.method} />
        <span className="apidbg-path" title={req.url}>{path}</span>
        <StatusBadge status={req.status} />
        <Duration ms={req.duration} />
        {req.isDuplicate && <DupBadge />}
        {req.isSlow && <SlowBadge />}
        <span className={`apidbg-chevron${open ? ' is-open' : ''}`}>v</span>
      </div>

      {open && (
        <div className="apidbg-detail">
          <div className="apidbg-detail-header">
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
              <input
                className="apidbg-search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search keys..."
              />
              <button
                className="apidbg-plain-button"
                onClick={() => setForceExpand(forceExpand === 'all' ? 'none' : 'all')}
              >
                {forceExpand === 'all' ? 'Collapse all' : 'Expand all'}
              </button>
            </div>
          </div>

          <div className="apidbg-json-box apidbg-scroll">
            <JsonNode value={jsonValue} depth={0} search={search} forceExpand={forceExpand} />
          </div>

          <div className="apidbg-json-footer">
            <span className="apidbg-json-meta">
              {(req.responseSize / 1024).toFixed(1)} KB response - {countKeys(jsonValue)} keys
            </span>
            <button
              className="apidbg-plain-button"
              onClick={() => {
                navigator.clipboard?.writeText(req.responseBody ?? JSON.stringify(jsonValue, null, 2))
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              }}
              style={{ color: copied ? 'var(--api-success)' : 'var(--api-color-primary-soft)' }}
            >
              {copied ? 'Copied' : 'Copy JSON'}
            </button>
          </div>

          <div className="apidbg-detail-actions">
            {(req.isSlow || req.status >= 400) && (
              <button className="apidbg-primary-button" onClick={triggerAI}>Ask AI</button>
            )}
            <button className="apidbg-secondary-button">Replay</button>
          </div>

          <AICard
            state={aiState}
            url={path}
            text={req.aiSuggestion ?? 'This endpoint shows signs worth checking: possible N+1 calls, over-fetching, waterfall latency, or missing pagination.'}
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

export function Overlay() {
  const [requests, setRequests] = useState<RequestEntry[]>([])
  const [state, setState] = useState<OverlayState>('feed')
  const [sweep, setSweep] = useState(false)

  useEffect(() => {
    const handler = (msg: unknown) => {
      if (isRequestCompleteMessage(msg)) {
        setRequests(prev => [msg.payload, ...prev].slice(0, 100))
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  const total = requests.length
  const avg = total ? Math.round(requests.reduce((sum, r) => sum + r.duration, 0) / total) : 0
  const errors = requests.filter(r => r.status >= 400).length
  const errorRate = total ? Math.round((errors / total) * 1000) / 10 : 0
  const dupes = requests.filter(r => r.isDuplicate).length
  const isCapturing = state !== 'paused'
  const showSparkline = requests.length >= 3
  const avgColor = avg < 500 ? 'var(--api-success)' : avg < 1500 ? 'var(--api-warning)' : 'var(--api-danger)'
  const errColor = errorRate === 0 ? 'var(--api-success)' : errorRate <= 5 ? 'var(--api-warning)' : 'var(--api-danger)'

  if (state === 'minimised') {
    return (
      <>
        <style>{overlayThemeCss}</style>
        <button className="apidbg-minimised" onClick={() => setState('feed')}>
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
      <div className="apidbg-overlay">
        <div className="apidbg-header">
          <div className="apidbg-title-row">
            <div className="apidbg-title">
              <LiveDot isCapturing={isCapturing} />
              <span>API Debugger</span>
            </div>
            <div className="apidbg-actions">
              <button
                className="apidbg-icon-button"
                onClick={() => setState(isCapturing ? 'paused' : 'feed')}
                title={isCapturing ? 'Pause' : 'Resume'}
              >
                {isCapturing ? '||' : '>'}
              </button>
              <button className="apidbg-icon-button" title="Open side panel">[]</button>
              <button className="apidbg-icon-button" onClick={() => setState('minimised')} title="Minimise">-</button>
            </div>
          </div>

          {requests.length > 0 && (
            <div className="apidbg-chip-row">
              <Chip label={`${total} calls`} color="var(--api-text-muted)" />
              <Chip label={`avg ${avg}ms`} color={avgColor} />
              <Chip label={`${errorRate}% errors`} color={errColor} />
              <Chip label={`${dupes} dupes`} color={dupes > 0 ? 'var(--api-warning)' : 'var(--api-text-muted)'} />
            </div>
          )}
        </div>

        {showSparkline && <Sparkline requests={requests} />}

        {state === 'paused' && (
          <div className="apidbg-paused">
            <span>Capture paused - {requests.length} requests buffered</span>
            <button className="apidbg-link-button" onClick={() => setState('feed')}>Resume</button>
          </div>
        )}

        <div className={`apidbg-list apidbg-scroll${state === 'paused' ? ' is-paused' : ''}`}>
          {sweep && <div className="apidbg-sweep" />}
          {requests.length === 0 ? <EmptyFeed /> : requests.map(r => <RequestRow key={r.id} req={r} />)}
        </div>

        {requests.length > 0 && (
          <div className="apidbg-footer">
            <button
              className="apidbg-plain-button"
              onClick={() => {
                setSweep(true)
                window.setTimeout(() => {
                  setRequests([])
                  setSweep(false)
                }, 300)
              }}
            >
              Clear
            </button>
          </div>
        )}
      </div>
    </>
  )
}

import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../shared/settings'
import '../index.css'

type TestState = 'idle' | 'loading' | 'ok' | 'err'

declare global {
  interface Window {
    __apiDebuggerPopupRoot?: Root
  }
}

export function Popup() {
  const [capturing, setCapturing] = useState(true)
  const [captureFetch, setCaptureFetch] = useState(true)
  const [captureXHR, setCaptureXHR] = useState(true)
  const [slowMs, setSlowMs] = useState(1500)
  const [largeKb, setLargeKb] = useState(500)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [testState, setTestState] = useState<TestState>('idle')
  const [position, setPosition] = useState('Bottom Right')
  const [showOnLoad, setShowOnLoad] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const debouncedApiKey = useDebounce(apiKey, 500)

  useEffect(() => {
    getSettings().then(settings => {
      setCapturing(settings.captureEnabled)
      setCaptureFetch(settings.captureFetch)
      setCaptureXHR(settings.captureXHR)
      setSlowMs(settings.slowRequestThresholdMs)
      setLargeKb(settings.largePayloadThresholdKb)
      setApiKey(settings.apiKey)
      setPosition(settings.overlayPosition)
      setShowOnLoad(settings.showOverlayOnLoad)
      setLoaded(true)
    })
  }, [])

  useEffect(() => {
    if (!loaded) return

    saveSettings({
      captureEnabled: capturing,
      captureFetch,
      captureXHR,
      slowRequestThresholdMs: slowMs,
      largePayloadThresholdKb: largeKb,
      apiKey: debouncedApiKey,
      overlayPosition: position as typeof DEFAULT_SETTINGS.overlayPosition,
      showOverlayOnLoad: showOnLoad,
    })
  }, [captureFetch, captureXHR, capturing, debouncedApiKey, largeKb, loaded, position, showOnLoad, slowMs])

  const testConnection = async () => {
    if (!apiKey.trim()) {
      setTestState('err')
      return
    }

    setTestState('loading')

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey.trim(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      setTestState(res.ok ? 'ok' : 'err')
    } catch {
      setTestState('err')
    }
  }

  const resetDefaults = () => {
    setCapturing(DEFAULT_SETTINGS.captureEnabled)
    setCaptureFetch(DEFAULT_SETTINGS.captureFetch)
    setCaptureXHR(DEFAULT_SETTINGS.captureXHR)
    setSlowMs(DEFAULT_SETTINGS.slowRequestThresholdMs)
    setLargeKb(DEFAULT_SETTINGS.largePayloadThresholdKb)
    setApiKey(DEFAULT_SETTINGS.apiKey)
    setShowKey(false)
    setTestState('idle')
    setPosition(DEFAULT_SETTINGS.overlayPosition)
    setShowOnLoad(DEFAULT_SETTINGS.showOverlayOnLoad)
  }

  return (
    <div className="api-theme-shell api-popup">
      <header className="api-popup-header">
        <div className="api-popup-brand">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M2 12 Q 7 4 12 12 T 22 12" />
            <circle cx="6" cy="12" r="1.5" fill="currentColor" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <circle cx="18" cy="12" r="1.5" fill="currentColor" />
          </svg>
          <span>API Debugger</span>
        </div>
        <span className={`api-popup-status${capturing ? ' is-capturing' : ''}`}>
          <span className="api-popup-dot" />
          {capturing ? 'Capturing' : 'Paused'}
        </span>
      </header>

      <main className="api-popup-content">
        <Section title="Capture">
          <ToggleRow label="Enable capture on this tab" value={capturing} onChange={setCapturing} />
          <ToggleRow label="Capture fetch requests" value={captureFetch} onChange={setCaptureFetch} />
          <ToggleRow label="Capture XHR requests" value={captureXHR} onChange={setCaptureXHR} />
        </Section>

        <Section title="Thresholds">
          <SliderRow
            label="Slow request threshold"
            value={slowMs}
            min={500}
            max={5000}
            step={100}
            onChange={setSlowMs}
            unit="ms"
          />
          <SliderRow
            label="Large payload threshold"
            value={largeKb}
            min={100}
            max={2000}
            step={50}
            onChange={setLargeKb}
            unit=" KB"
          />
        </Section>

        <Section title="AI Integration">
          <div>
            <div className="api-popup-field-label">Anthropic API Key</div>
            <div className="api-popup-input-wrap">
              <input
                className="api-popup-key-input"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={event => setApiKey(event.target.value)}
                placeholder="sk-ant-..."
              />
              <button className="api-popup-eye" onClick={() => setShowKey(value => !value)} title={showKey ? 'Hide key' : 'Show key'}>
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <div className="api-popup-help">Stored locally. Only sent to api.anthropic.com.</div>
            <button
              className={`api-popup-test${testState === 'ok' ? ' is-ok' : ''}${testState === 'err' ? ' is-err' : ''}`}
              onClick={testConnection}
            >
              {testState === 'loading' && <span className="api-spinner" />}
              {testState === 'idle' && 'Test connection'}
              {testState === 'loading' && 'Testing...'}
              {testState === 'ok' && 'Connected'}
              {testState === 'err' && 'Invalid key'}
            </button>
          </div>
        </Section>

        <Section title="Overlay">
          <div className="api-popup-row">
            <span className="api-popup-label">Default position</span>
            <select className="api-select" value={position} onChange={event => setPosition(event.target.value)}>
              <option>Bottom Right</option>
              <option>Bottom Left</option>
              <option>Top Right</option>
              <option>Top Left</option>
            </select>
          </div>
          <ToggleRow label="Show on page load" value={showOnLoad} onChange={setShowOnLoad} />
        </Section>
      </main>

      <footer className="api-popup-footer">
        <span className="api-popup-version">
          v{chrome.runtime.getManifest().version}
        </span>
        <button className="api-reset-button" onClick={resetDefaults}>Reset to defaults</button>
      </footer>
    </div>
  )
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value)

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return debounced
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="api-popup-section">
      <div className="api-popup-section-title">{title}</div>
      <div className="api-popup-stack">{children}</div>
    </section>
  )
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="api-popup-row">
      <span className="api-popup-label">{label}</span>
      <button
        className={`api-toggle${value ? ' is-on' : ''}`}
        onClick={() => onChange(!value)}
        aria-pressed={value}
        aria-label={label}
      >
        <span className="api-toggle-thumb" />
      </button>
    </div>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  unit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  unit: string
}) {
  const pct = ((value - min) / (max - min)) * 100

  return (
    <div className="api-popup-slider">
      <div className="api-popup-slider-meta">
        <span className="api-popup-label">{label}</span>
        <span className="api-popup-value">{value}{unit}</span>
      </div>
      <input
        className="api-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        style={{
          background: `linear-gradient(to right, var(--api-color-primary) ${pct}%, var(--api-border-strong) ${pct}%)`,
        }}
      />
    </div>
  )
}

const rootElement = document.getElementById('root')!
const root = window.__apiDebuggerPopupRoot ?? createRoot(rootElement)
window.__apiDebuggerPopupRoot = root
root.render(<Popup />)

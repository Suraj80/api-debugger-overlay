import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../shared/settings'
import type { AISuggestionResponse } from '../shared/types'
import '../index.css'
import brandIcon from '../../icons/favicon-32x32.png'

type TestState = 'idle' | 'loading' | 'ok' | 'err'

declare global {
  interface Window {
    __apiDebuggerPopupRoot?: Root
  }
}

export function Popup() {
  const [capturing, setCapturing] = useState(DEFAULT_SETTINGS.captureEnabled)
  const [captureFetch, setCaptureFetch] = useState(DEFAULT_SETTINGS.captureFetch)
  const [captureXHR, setCaptureXHR] = useState(DEFAULT_SETTINGS.captureXHR)
  const [preciseMode, setPreciseMode] = useState(DEFAULT_SETTINGS.preciseModeEnabled)
  const [slowMs, setSlowMs] = useState(DEFAULT_SETTINGS.slowRequestThresholdMs)
  const [largeKb, setLargeKb] = useState(DEFAULT_SETTINGS.largePayloadThresholdKb)
  const [apiKey, setApiKey] = useState(DEFAULT_SETTINGS.apiKey)
  const [showKey, setShowKey] = useState(false)
  const [testState, setTestState] = useState<TestState>('idle')
  const [testMessage, setTestMessage] = useState('')
  const [position, setPosition] = useState(DEFAULT_SETTINGS.overlayPosition)
  const [showOnLoad, setShowOnLoad] = useState(DEFAULT_SETTINGS.showOverlayOnLoad)
  const [loaded, setLoaded] = useState(false)
  const debouncedApiKey = useDebounce(apiKey, 500)

  useEffect(() => {
    getSettings().then(settings => {
      setCapturing(settings.captureEnabled)
      setCaptureFetch(settings.captureFetch)
      setCaptureXHR(settings.captureXHR)
      setPreciseMode(settings.preciseModeEnabled)
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
      preciseModeEnabled: preciseMode,
      slowRequestThresholdMs: slowMs,
      largePayloadThresholdKb: largeKb,
      apiKey: debouncedApiKey,
      overlayPosition: position as typeof DEFAULT_SETTINGS.overlayPosition,
      showOverlayOnLoad: showOnLoad,
    })
  }, [captureFetch, captureXHR, capturing, debouncedApiKey, largeKb, loaded, position, preciseMode, showOnLoad, slowMs])

  useEffect(() => {
    if (!loaded) return

    chrome.runtime.sendMessage({
      type: 'SET_PRECISE_MODE',
      payload: { enabled: preciseMode },
    }).catch(() => {
      // Ignore transient popup/runtime disconnects during dev reloads.
    })
  }, [loaded, preciseMode])

  const onApiKeyChange = (value: string) => {
    setApiKey(value)
    setTestState('idle')
    setTestMessage('')
  }

  const testConnection = async () => {
    if (!apiKey.trim()) {
      setTestState('err')
      setTestMessage('Enter an Anthropic API key before testing the connection.')
      return
    }

    setTestState('loading')
    setTestMessage('')

    try {
      await saveSettings({
        captureEnabled: capturing,
        captureFetch,
        captureXHR,
        preciseModeEnabled: preciseMode,
        slowRequestThresholdMs: slowMs,
        largePayloadThresholdKb: largeKb,
        apiKey: apiKey.trim(),
        overlayPosition: position as typeof DEFAULT_SETTINGS.overlayPosition,
        showOverlayOnLoad: showOnLoad,
      })
      const response = await chrome.runtime.sendMessage({ type: 'TEST_AI_CONNECTION' }) as AISuggestionResponse | undefined

      if (response?.ok) {
        setTestState('ok')
        setTestMessage('Connection successful.')
        return
      }

      setTestState('err')
      setTestMessage(response?.error ?? 'Unable to connect to Anthropic.')
    } catch (error) {
      setTestState('err')
      setTestMessage(error instanceof Error ? error.message : 'Unable to connect to Anthropic.')
    }
  }

  const resetDefaults = () => {
    setCapturing(DEFAULT_SETTINGS.captureEnabled)
    setCaptureFetch(DEFAULT_SETTINGS.captureFetch)
    setCaptureXHR(DEFAULT_SETTINGS.captureXHR)
    setPreciseMode(DEFAULT_SETTINGS.preciseModeEnabled)
    setSlowMs(DEFAULT_SETTINGS.slowRequestThresholdMs)
    setLargeKb(DEFAULT_SETTINGS.largePayloadThresholdKb)
    setApiKey(DEFAULT_SETTINGS.apiKey)
    setShowKey(false)
    setTestState('idle')
    setTestMessage('')
    setPosition(DEFAULT_SETTINGS.overlayPosition)
    setShowOnLoad(DEFAULT_SETTINGS.showOverlayOnLoad)
  }

  return (
    <div className="api-theme-shell api-popup">
      <header className="api-popup-header">
        <div className="api-popup-brand">
          <img src={brandIcon} alt="" className="api-popup-brand-icon" />
          <span>API Debugger</span>
        </div>
        <span className={`api-popup-status${loaded && capturing ? ' is-capturing' : ''}`}>
          <span className="api-popup-dot" />
          {loaded ? (capturing ? 'Capturing' : 'Paused') : 'Loading'}
        </span>
      </header>

      <main className="api-popup-content">
        {!loaded && (
          <section className="api-popup-section" aria-live="polite">
            <div className="api-popup-section-title">Loading</div>
            <div className="api-popup-help">Reading saved settings...</div>
          </section>
        )}

        {loaded && (
          <>
        <Section title="Capture">
          <ToggleRow label="Enable capture on this tab" value={capturing} onChange={setCapturing} />
          <ToggleRow label="Capture fetch requests" value={captureFetch} onChange={setCaptureFetch} />
          <ToggleRow label="Capture XHR requests" value={captureXHR} onChange={setCaptureXHR} />
          <ToggleRow label="Precise mode" value={preciseMode} onChange={setPreciseMode} hint="Uses Chrome debugger for DevTools-level timing. Chrome will show a debugging banner on the page." />
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
                onChange={event => onApiKeyChange(event.target.value)}
                placeholder="sk-ant-..."
              />
              <button className="api-popup-eye" onClick={() => setShowKey(value => !value)} title={showKey ? 'Hide key' : 'Show key'}>
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <div className="api-popup-help">Encrypted locally. Only the service worker sends it to api.anthropic.com.</div>
            <button
              className={`api-popup-test${testState === 'ok' ? ' is-ok' : ''}${testState === 'err' ? ' is-err' : ''}`}
              onClick={testConnection}
              disabled={testState === 'loading'}
            >
              {testState === 'loading' && <span className="api-spinner" />}
              {testState === 'idle' && 'Test connection'}
              {testState === 'loading' && 'Testing...'}
              {testState === 'ok' && 'Connected'}
              {testState === 'err' && 'Try again'}
            </button>
            {testMessage && (
              <div
                className="api-popup-help"
                style={{
                  marginTop: 8,
                  color: testState === 'err' ? 'var(--api-danger)' : testState === 'ok' ? 'var(--api-success)' : undefined,
                }}
              >
                {testMessage}
              </div>
            )}
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
          </>
        )}
      </main>

      <footer className="api-popup-footer">
        <span className="api-popup-version">
          v{chrome.runtime.getManifest().version}
        </span>
        <button className="api-reset-button" onClick={resetDefaults} disabled={!loaded}>Reset to defaults</button>
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

function ToggleRow({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
  hint?: string
}) {
  return (
    <div className="api-popup-row">
      <div>
        <span className="api-popup-label">{label}</span>
        {hint && <div className="api-popup-help" style={{ marginTop: 4 }}>{hint}</div>}
      </div>
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

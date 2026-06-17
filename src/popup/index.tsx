import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../shared/settings'
import type { AISuggestionResponse } from '../shared/types'
import '../index.css'
import brandIcon from '../../icons/android-chrome-192x192.png'

type TestState = 'idle' | 'loading' | 'ok' | 'err'
type PopupTab = 'capture' | 'ai' | 'overlay'

declare global {
  interface Window {
    __apiDebuggerPopupRoot?: Root
  }
}

const DEFAULT_AI_MODEL = 'gpt-5.4-mini'

export function Popup() {
  const [capturing, setCapturing] = useState(DEFAULT_SETTINGS.captureEnabled)
  const [captureFetch, setCaptureFetch] = useState(DEFAULT_SETTINGS.captureFetch)
  const [captureXHR, setCaptureXHR] = useState(DEFAULT_SETTINGS.captureXHR)
  const [preciseMode, setPreciseMode] = useState(DEFAULT_SETTINGS.preciseModeEnabled)
  const [slowMs, setSlowMs] = useState(DEFAULT_SETTINGS.slowRequestThresholdMs)
  const [largeKb, setLargeKb] = useState(DEFAULT_SETTINGS.largePayloadThresholdKb)
  const [savedApiKey, setSavedApiKey] = useState(DEFAULT_SETTINGS.apiKey)
  const [apiKeyDraft, setApiKeyDraft] = useState(DEFAULT_SETTINGS.apiKey)
  const [editingApiKey, setEditingApiKey] = useState(true)
  const [showKey, setShowKey] = useState(false)
  const [testState, setTestState] = useState<TestState>('idle')
  const [testMessage, setTestMessage] = useState('')
  const [position, setPosition] = useState(DEFAULT_SETTINGS.overlayPosition)
  const [overlaySize, setOverlaySize] = useState(DEFAULT_SETTINGS.overlaySize)
  const [showOnLoad, setShowOnLoad] = useState(DEFAULT_SETTINGS.showOverlayOnLoad)
  const [showOverlayGraph, setShowOverlayGraph] = useState(DEFAULT_SETTINGS.showOverlayGraph)
  const [loaded, setLoaded] = useState(false)
  const [lastTestedKey, setLastTestedKey] = useState('')
  const [activeTab, setActiveTab] = useState<PopupTab>('capture')

  useEffect(() => {
    getSettings().then(settings => {
      setCapturing(settings.captureEnabled)
      setCaptureFetch(settings.captureFetch)
      setCaptureXHR(settings.captureXHR)
      setPreciseMode(settings.preciseModeEnabled)
      setSlowMs(settings.slowRequestThresholdMs)
      setLargeKb(settings.largePayloadThresholdKb)
      setSavedApiKey(settings.apiKey)
      setApiKeyDraft(settings.apiKey)
      setEditingApiKey(!settings.apiKey.trim())
      setPosition(settings.overlayPosition)
      setOverlaySize(settings.overlaySize)
      setShowOnLoad(settings.showOverlayOnLoad)
      setShowOverlayGraph(settings.showOverlayGraph)
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
      apiKey: savedApiKey,
      overlayPosition: position as typeof DEFAULT_SETTINGS.overlayPosition,
      overlaySize,
      showOverlayOnLoad: showOnLoad,
      showOverlayGraph,
    })
  }, [captureFetch, captureXHR, capturing, largeKb, loaded, overlaySize, position, preciseMode, savedApiKey, showOnLoad, showOverlayGraph, slowMs])

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
    setApiKeyDraft(value)
    setTestState('idle')
    setTestMessage('')
    setLastTestedKey('')
  }

  const testConnection = async () => {
    const keyToTest = editingApiKey ? apiKeyDraft.trim() : savedApiKey.trim()

    if (!keyToTest) {
      setTestState('err')
      setTestMessage('Enter an OpenAI API key before testing the connection.')
      return
    }

    setTestState('loading')
    setTestMessage('')

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TEST_AI_CONNECTION',
        payload: { apiKey: keyToTest },
      }) as AISuggestionResponse | undefined

      if (response?.ok) {
        setTestState('ok')
        setLastTestedKey(keyToTest)
        setTestMessage(editingApiKey ? 'Connection successful. Save this key to use Ask AI.' : 'Saved key verified successfully.')
        return
      }

      setTestState('err')
      setTestMessage(response?.error ?? 'Unable to connect to OpenAI.')
    } catch (error) {
      setTestState('err')
      setTestMessage(error instanceof Error ? error.message : 'Unable to connect to OpenAI.')
    }
  }

  const saveApiKey = async () => {
    const trimmedApiKey = apiKeyDraft.trim()
    if (!trimmedApiKey) {
      setTestState('err')
      setTestMessage('Enter an OpenAI API key before saving.')
      return
    }

    if (testState !== 'ok' || lastTestedKey !== trimmedApiKey) {
      setTestState('err')
      setTestMessage('Test this key successfully before saving it.')
      return
    }

    await saveSettings({
      captureEnabled: capturing,
      captureFetch,
      captureXHR,
      preciseModeEnabled: preciseMode,
      slowRequestThresholdMs: slowMs,
      largePayloadThresholdKb: largeKb,
      apiKey: trimmedApiKey,
      overlayPosition: position as typeof DEFAULT_SETTINGS.overlayPosition,
      overlaySize,
      showOverlayOnLoad: showOnLoad,
      showOverlayGraph,
    })

    setSavedApiKey(trimmedApiKey)
    setApiKeyDraft(trimmedApiKey)
    setEditingApiKey(false)
    setShowKey(false)
    setTestState('idle')
    setTestMessage('OpenAI key saved.')
  }

  const startEditingApiKey = () => {
    setEditingApiKey(true)
    setApiKeyDraft(savedApiKey)
    setShowKey(false)
    setTestState('idle')
    setTestMessage('')
    setLastTestedKey('')
  }

  const cancelEditingApiKey = () => {
    setEditingApiKey(false)
    setApiKeyDraft(savedApiKey)
    setShowKey(false)
    setTestState('idle')
    setTestMessage('')
    setLastTestedKey('')
  }

  const removeApiKey = async () => {
    await saveSettings({
      captureEnabled: capturing,
      captureFetch,
      captureXHR,
      preciseModeEnabled: preciseMode,
      slowRequestThresholdMs: slowMs,
      largePayloadThresholdKb: largeKb,
      apiKey: '',
      overlayPosition: position as typeof DEFAULT_SETTINGS.overlayPosition,
      overlaySize,
      showOverlayOnLoad: showOnLoad,
      showOverlayGraph,
    })

    setSavedApiKey('')
    setApiKeyDraft('')
    setEditingApiKey(true)
    setShowKey(false)
    setTestState('idle')
    setTestMessage('OpenAI key removed.')
    setLastTestedKey('')
  }

  const resetDefaults = () => {
    setCapturing(DEFAULT_SETTINGS.captureEnabled)
    setCaptureFetch(DEFAULT_SETTINGS.captureFetch)
    setCaptureXHR(DEFAULT_SETTINGS.captureXHR)
    setPreciseMode(DEFAULT_SETTINGS.preciseModeEnabled)
    setSlowMs(DEFAULT_SETTINGS.slowRequestThresholdMs)
    setLargeKb(DEFAULT_SETTINGS.largePayloadThresholdKb)
    setSavedApiKey(DEFAULT_SETTINGS.apiKey)
    setApiKeyDraft(DEFAULT_SETTINGS.apiKey)
    setEditingApiKey(true)
    setShowKey(false)
    setTestState('idle')
    setTestMessage('')
    setLastTestedKey('')
    setPosition(DEFAULT_SETTINGS.overlayPosition)
    setOverlaySize(DEFAULT_SETTINGS.overlaySize)
    setShowOnLoad(DEFAULT_SETTINGS.showOverlayOnLoad)
    setShowOverlayGraph(DEFAULT_SETTINGS.showOverlayGraph)
  }

  const hasSavedApiKey = Boolean(savedApiKey.trim())
  const canSaveApiKey = editingApiKey && testState === 'ok' && apiKeyDraft.trim() !== '' && lastTestedKey === apiKeyDraft.trim()
  const maskedApiKey = maskApiKey(savedApiKey)

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
            {activeTab === 'capture' && (
              <div className="api-popup-panel">
                <Section title="Capture Controls">
                  <ToggleRow label="Enable capture" value={capturing} onChange={setCapturing} />
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
              </div>
            )}

            {activeTab === 'ai' && (
              <div className="api-popup-panel">
                <Section title="AI Integration">
                  <div>
                    <div className="api-popup-field-label">OpenAI API Key</div>
                    {editingApiKey ? (
                      <>
                        <div className="api-popup-input-wrap">
                          <input
                            className="api-popup-key-input"
                            type={showKey ? 'text' : 'password'}
                            value={apiKeyDraft}
                            onChange={event => onApiKeyChange(event.target.value)}
                            placeholder="sk-..."
                          />
                          <button className="api-popup-eye" onClick={() => setShowKey(value => !value)} title={showKey ? 'Hide key' : 'Show key'}>
                            {showKey ? 'Hide' : 'Show'}
                          </button>
                        </div>
                        <div className="api-popup-help">Encrypted locally. Only the service worker sends it to api.openai.com.</div>
                        <div className="api-popup-help">Default model: {DEFAULT_AI_MODEL}</div>
                        <div className="api-popup-actions">
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
                          <button className="api-popup-action" onClick={saveApiKey} disabled={!canSaveApiKey}>
                            Save key
                          </button>
                          {hasSavedApiKey && (
                            <button className="api-popup-action" onClick={cancelEditingApiKey}>
                              Cancel
                            </button>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="api-popup-key-card">
                        <div className="api-popup-key-card-status">OpenAI key saved</div>
                        <div className="api-popup-key-card-value">{maskedApiKey}</div>
                        <div className="api-popup-help">Encrypted locally. Only the service worker sends it to api.openai.com.</div>
                        <div className="api-popup-help">Default model: {DEFAULT_AI_MODEL}</div>
                        <div className="api-popup-actions">
                          <button className="api-popup-action api-popup-action-small" onClick={startEditingApiKey}>
                            Change key
                          </button>
                          <button
                            className={`api-popup-test${testState === 'ok' ? ' is-ok' : ''}${testState === 'err' ? ' is-err' : ''}`}
                            onClick={testConnection}
                            disabled={testState === 'loading'}
                          >
                            {testState === 'loading' && <span className="api-spinner" />}
                            {testState === 'loading' ? 'Testing...' : 'Test again'}
                          </button>
                          <button className="api-popup-action api-popup-action-remove is-danger" onClick={removeApiKey}>
                            Remove key
                          </button>
                        </div>
                      </div>
                    )}
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
              </div>
            )}

            {activeTab === 'overlay' && (
              <div className="api-popup-panel">
                <Section title="Overlay Preferences">
                  <div>
                    <div className="api-popup-field-label">Overlay size</div>
                    <div className="api-size-options" role="radiogroup" aria-label="Overlay size">
                      {(['Large', 'Medium', 'Small'] as const).map(size => (
                        <button
                          key={size}
                          type="button"
                          role="radio"
                          aria-checked={overlaySize === size}
                          className={`api-size-option${overlaySize === size ? ' is-active' : ''}`}
                          onClick={() => setOverlaySize(size)}
                        >
                          <span className={`api-size-preview is-${size.toLowerCase()}`} aria-hidden="true" />
                          <span>{size}</span>
                        </button>
                      ))}
                    </div>
                    <div className="api-popup-help">Changes the complete overlay layout and density.</div>
                  </div>
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
                  <ToggleRow
                    label="Show response graph"
                    value={showOverlayGraph}
                    onChange={setShowOverlayGraph}
                    hint="Turns the overlay timeline chart on or off across pages."
                  />
                </Section>
              </div>
            )}
          </>
        )}
      </main>

      <footer className="api-popup-footer">
        <div className="api-popup-tabs api-popup-tabs-footer" role="tablist" aria-label="Popup sections">
          <TabButton
            label="Capture"
            value="capture"
            activeTab={activeTab}
            onSelect={setActiveTab}
          />
          <TabButton
            label="AI"
            value="ai"
            activeTab={activeTab}
            onSelect={setActiveTab}
          />
          <TabButton
            label="Overlay"
            value="overlay"
            activeTab={activeTab}
            onSelect={setActiveTab}
          />
        </div>
        <button
          className="api-reset-button"
          onClick={resetDefaults}
          disabled={!loaded}
          title="Reset to defaults"
          aria-label="Reset to defaults"
        >
          <span>Reset</span>
        </button>
      </footer>
    </div>
  )
}

function maskApiKey(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 7) return trimmed
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`
}

function TabButton({
  label,
  value,
  activeTab,
  onSelect,
}: {
  label: string
  value: PopupTab
  activeTab: PopupTab
  onSelect: (value: PopupTab) => void
}) {
  return (
    <button
      className={`api-popup-tab api-popup-tab-${value}${activeTab === value ? ' is-active' : ''}`}
      onClick={() => onSelect(value)}
      role="tab"
      type="button"
      aria-selected={activeTab === value}
    >
      <span>{label}</span>
    </button>
  )
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

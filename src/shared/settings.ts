export type OverlayPosition = 'Bottom Right' | 'Bottom Left' | 'Top Right' | 'Top Left'

export interface ApiDebuggerSettings {
  captureEnabled: boolean
  captureFetch: boolean
  captureXHR: boolean
  slowRequestThresholdMs: number
  largePayloadThresholdKb: number
  apiKey: string
  overlayPosition: OverlayPosition
  showOverlayOnLoad: boolean
}

export const API_DEBUGGER_SETTINGS_KEY = 'apiDebuggerSettings'
export const API_DEBUGGER_SECRET_SETTINGS_KEY = 'apiDebuggerSecretSettings'

export const DEFAULT_SETTINGS: ApiDebuggerSettings = {
  captureEnabled: true,
  captureFetch: true,
  captureXHR: true,
  slowRequestThresholdMs: 1500,
  largePayloadThresholdKb: 500,
  apiKey: '',
  overlayPosition: 'Bottom Right',
  showOverlayOnLoad: true,
}

export function normalizeSettings(value: Partial<ApiDebuggerSettings> | undefined): ApiDebuggerSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(value ?? {}),
  }
}

export async function getSettings(): Promise<ApiDebuggerSettings> {
  const [syncResult, localResult] = await Promise.all([
    chrome.storage.sync.get(API_DEBUGGER_SETTINGS_KEY),
    chrome.storage.local.get([API_DEBUGGER_SETTINGS_KEY, API_DEBUGGER_SECRET_SETTINGS_KEY]),
  ])

  const syncedSettings = syncResult[API_DEBUGGER_SETTINGS_KEY] as Partial<ApiDebuggerSettings> | undefined
  const legacyLocalSettings = localResult[API_DEBUGGER_SETTINGS_KEY] as Partial<ApiDebuggerSettings> | undefined
  const secretSettings = localResult[API_DEBUGGER_SECRET_SETTINGS_KEY] as Pick<ApiDebuggerSettings, 'apiKey'> | undefined
  const settings = normalizeSettings({
    ...legacyLocalSettings,
    ...syncedSettings,
    apiKey: secretSettings?.apiKey ?? legacyLocalSettings?.apiKey ?? syncedSettings?.apiKey ?? DEFAULT_SETTINGS.apiKey,
  })

  if (!syncedSettings && legacyLocalSettings) {
    await saveSettings(settings)
  }

  return settings
}

export function saveSettings(settings: ApiDebuggerSettings) {
  const { apiKey, ...syncSettings } = settings

  return Promise.all([
    chrome.storage.sync.set({ [API_DEBUGGER_SETTINGS_KEY]: syncSettings }),
    chrome.storage.local.set({ [API_DEBUGGER_SECRET_SETTINGS_KEY]: { apiKey } }),
  ])
}

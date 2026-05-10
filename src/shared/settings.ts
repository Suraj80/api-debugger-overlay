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
  const result = await chrome.storage.local.get(API_DEBUGGER_SETTINGS_KEY)
  return normalizeSettings(result[API_DEBUGGER_SETTINGS_KEY] as Partial<ApiDebuggerSettings> | undefined)
}

export function saveSettings(settings: ApiDebuggerSettings) {
  return chrome.storage.local.set({ [API_DEBUGGER_SETTINGS_KEY]: settings })
}

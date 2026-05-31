export type OverlayPosition = 'Bottom Right' | 'Bottom Left' | 'Top Right' | 'Top Left'

export interface ApiDebuggerSettings {
  captureEnabled: boolean
  captureFetch: boolean
  captureXHR: boolean
  preciseModeEnabled: boolean
  slowRequestThresholdMs: number
  largePayloadThresholdKb: number
  apiKey: string
  overlayPosition: OverlayPosition
  showOverlayOnLoad: boolean
}

export const API_DEBUGGER_SETTINGS_KEY = 'apiDebuggerSettings'
export const API_DEBUGGER_SECRET_SETTINGS_KEY = 'apiDebuggerSecretSettings'
const API_KEY_ENCRYPTION_VERSION = 2

interface EncryptedApiKey {
  version: number
  iv: string
  ciphertext: string
}

interface SecretSettings {
  apiKey?: string
  apiKeyEncrypted?: EncryptedApiKey
}

export const DEFAULT_SETTINGS: ApiDebuggerSettings = {
  captureEnabled: true,
  captureFetch: true,
  captureXHR: true,
  preciseModeEnabled: false,
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

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte)
  })

  return btoa(binary)
}

function base64ToBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

async function getApiKeyEncryptionKey() {
  const encoder = new TextEncoder()
  const extensionId = chrome.runtime?.id ?? 'api-debugger'
  const keyMaterial = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${extensionId}:api-debugger-overlay`),
  )

  return crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptApiKey(apiKey: string): Promise<EncryptedApiKey> {
  const encoder = new TextEncoder()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await getApiKeyEncryptionKey()
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(apiKey),
  )

  return {
    version: API_KEY_ENCRYPTION_VERSION,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  }
}

export async function decryptApiKey(encrypted: EncryptedApiKey | undefined): Promise<string> {
  if (!encrypted) return ''
  if (encrypted.version !== API_KEY_ENCRYPTION_VERSION) {
    return ''
  }

  try {
    const key = await getApiKeyEncryptionKey()
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(encrypted.iv) },
      key,
      base64ToBytes(encrypted.ciphertext),
    )

    return new TextDecoder().decode(plaintext)
  } catch {
    return ''
  }
}

export async function getSettings(): Promise<ApiDebuggerSettings> {
  const [syncResult, localResult] = await Promise.all([
    chrome.storage.sync.get(API_DEBUGGER_SETTINGS_KEY),
    chrome.storage.local.get([API_DEBUGGER_SETTINGS_KEY, API_DEBUGGER_SECRET_SETTINGS_KEY]),
  ])

  const syncedSettings = syncResult[API_DEBUGGER_SETTINGS_KEY] as Partial<ApiDebuggerSettings> | undefined
  const legacyLocalSettings = localResult[API_DEBUGGER_SETTINGS_KEY] as Partial<ApiDebuggerSettings> | undefined
  const secretSettings = localResult[API_DEBUGGER_SECRET_SETTINGS_KEY] as SecretSettings | undefined
  const decryptedApiKey = await decryptApiKey(secretSettings?.apiKeyEncrypted)
  const legacyApiKey = secretSettings?.apiKey ?? legacyLocalSettings?.apiKey ?? syncedSettings?.apiKey
  const settings = normalizeSettings({
    ...legacyLocalSettings,
    ...syncedSettings,
    apiKey: decryptedApiKey || legacyApiKey || DEFAULT_SETTINGS.apiKey,
  })
  const needsMigration = Boolean(
    legacyLocalSettings ||
    secretSettings?.apiKey ||
    syncedSettings?.apiKey ||
    (secretSettings && !secretSettings.apiKeyEncrypted)
  )

  if (needsMigration) {
    await saveSettings(settings)
  }

  return settings
}

export async function saveSettings(settings: ApiDebuggerSettings) {
  const { apiKey, ...syncSettings } = settings
  const apiKeyEncrypted = await encryptApiKey(apiKey)

  await Promise.all([
    chrome.storage.sync.set({ [API_DEBUGGER_SETTINGS_KEY]: syncSettings }),
    chrome.storage.local.set({ [API_DEBUGGER_SECRET_SETTINGS_KEY]: { apiKeyEncrypted } }),
    chrome.storage.local.remove(API_DEBUGGER_SETTINGS_KEY),
  ])
}

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Store = Record<string, unknown>

const makeArea = (store: Store) => ({
  get: vi.fn(async (keys?: string | string[]) => {
    if (!keys) return { ...store }
    if (typeof keys === 'string') return { [keys]: store[keys] }

    return keys.reduce<Store>((result, key) => {
      result[key] = store[key]
      return result
    }, {})
  }),
  set: vi.fn(async (items: Store) => {
    Object.assign(store, items)
  }),
  remove: vi.fn(async (key: string) => {
    delete store[key]
  }),
})

function installChromeMock(syncStore: Store, localStore: Store) {
  Object.defineProperty(globalThis, 'chrome', {
    value: {
      runtime: { id: 'test-extension-id' },
      storage: {
        sync: makeArea(syncStore),
        local: makeArea(localStore),
      },
    },
    configurable: true,
  })
}

describe('settings secret storage', () => {
  let syncStore: Store
  let localStore: Store

  beforeEach(() => {
    vi.resetModules()
    syncStore = {}
    localStore = {}
    installChromeMock(syncStore, localStore)
  })

  it('encrypts the API key in local storage and restores it on read', async () => {
    const {
      API_DEBUGGER_SECRET_SETTINGS_KEY,
      API_DEBUGGER_SETTINGS_KEY,
      DEFAULT_SETTINGS,
      getSettings,
      saveSettings,
    } = await import('../../src/shared/settings')

    await saveSettings({
      ...DEFAULT_SETTINGS,
      apiKey: 'sk-ant-test-secret',
      slowRequestThresholdMs: 2200,
    })

    const secretSettings = localStore[API_DEBUGGER_SECRET_SETTINGS_KEY] as {
      apiKey?: string
      apiKeyEncrypted?: { ciphertext: string }
    }

    expect(secretSettings.apiKey).toBeUndefined()
    expect(secretSettings.apiKeyEncrypted?.ciphertext).toBeTypeOf('string')
    expect(secretSettings.apiKeyEncrypted?.ciphertext).not.toContain('sk-ant-test-secret')
    expect((syncStore[API_DEBUGGER_SETTINGS_KEY] as { apiKey?: string }).apiKey).toBeUndefined()

    const settings = await getSettings()
    expect(settings.apiKey).toBe('sk-ant-test-secret')
    expect(settings.slowRequestThresholdMs).toBe(2200)
  })

  it('migrates a legacy plaintext API key to encrypted storage', async () => {
    const {
      API_DEBUGGER_SECRET_SETTINGS_KEY,
      DEFAULT_SETTINGS,
      getSettings,
    } = await import('../../src/shared/settings')

    localStore[API_DEBUGGER_SECRET_SETTINGS_KEY] = { apiKey: 'sk-ant-legacy-secret' }

    const settings = await getSettings()
    const migratedSecretSettings = localStore[API_DEBUGGER_SECRET_SETTINGS_KEY] as {
      apiKey?: string
      apiKeyEncrypted?: { ciphertext: string }
    }

    expect(settings.apiKey).toBe('sk-ant-legacy-secret')
    expect(migratedSecretSettings.apiKey).toBeUndefined()
    expect(migratedSecretSettings.apiKeyEncrypted?.ciphertext).toBeTypeOf('string')
    expect(settings.captureEnabled).toBe(DEFAULT_SETTINGS.captureEnabled)
  })
})

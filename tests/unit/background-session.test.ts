import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestEntry, ReplayRequest, ReplayResult } from '../../src/shared/types'

type RuntimeMessageListener = (
  message: any,
  sender: any,
  sendResponse: (value: unknown) => void,
) => boolean

function createRequest(overrides: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id: overrides.id ?? 'request-1',
    url: overrides.url ?? 'https://api.example.com/users/42',
    method: overrides.method ?? 'GET',
    status: overrides.status ?? 200,
    duration: overrides.duration ?? 120,
    startTime: overrides.startTime ?? 1_000,
    requestSize: overrides.requestSize ?? 0,
    responseSize: overrides.responseSize ?? 256,
    decodedBodySize: overrides.decodedBodySize ?? 256,
    transferSize: overrides.transferSize ?? 256,
    requestHeaders: overrides.requestHeaders ?? {},
    requestBody: overrides.requestBody ?? null,
    responseBody: overrides.responseBody ?? null,
    isDuplicate: overrides.isDuplicate ?? false,
    duplicateOf: overrides.duplicateOf ?? null,
    duplicateCount: overrides.duplicateCount ?? 1,
    isSlow: overrides.isSlow ?? false,
    aiSuggestion: overrides.aiSuggestion ?? null,
    dependsOn: overrides.dependsOn ?? [],
    fingerprint: overrides.fingerprint ?? 'fp-1',
    ttfb: overrides.ttfb ?? 0,
    dnsTime: overrides.dnsTime ?? 0,
    connectTime: overrides.connectTime ?? 0,
    sslTime: overrides.sslTime ?? 0,
    requestTime: overrides.requestTime ?? 0,
    responseTime: overrides.responseTime ?? 0,
    timingSource: overrides.timingSource ?? 'proxy',
  }
}

function installChromeMock() {
  let runtimeMessageListener: RuntimeMessageListener | null = null

  const runtime = {
    id: 'test-extension-id',
    onInstalled: { addListener: vi.fn() },
    onMessage: {
      addListener: vi.fn((listener: RuntimeMessageListener) => {
        runtimeMessageListener = listener
      }),
    },
    sendMessage: vi.fn(() => Promise.resolve()),
  }

  const tabs = {
    query: vi.fn(() => Promise.resolve([{ id: 7 }])),
    sendMessage: vi.fn(() => Promise.resolve()),
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  }

  Object.defineProperty(globalThis, 'chrome', {
    value: {
      runtime,
      debugger: {
        attach: vi.fn(() => Promise.resolve()),
        detach: vi.fn(() => Promise.resolve()),
        sendCommand: vi.fn(() => Promise.resolve()),
        onDetach: { addListener: vi.fn() },
        onEvent: { addListener: vi.fn() },
      },
      tabs,
      webRequest: {
        onCompleted: { addListener: vi.fn() },
      },
      sidePanel: {
        open: vi.fn(() => Promise.resolve()),
      },
      storage: {
        sync: {
          get: vi.fn(() => Promise.resolve({})),
          set: vi.fn(() => Promise.resolve()),
        },
        local: {
          get: vi.fn(() => Promise.resolve({})),
          set: vi.fn(() => Promise.resolve()),
          remove: vi.fn(() => Promise.resolve()),
        },
      },
    },
    configurable: true,
  })

  return {
    runtime,
    tabs,
    getRuntimeMessageListener: () => runtimeMessageListener,
  }
}

describe('background session helpers', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('sanitizes sensitive URL pieces before sending context to AI', async () => {
    installChromeMock()
    const { sanitizeUrlForAi } = await import('../../src/background/index')

    const sanitized = sanitizeUrlForAi('https://api.example.com/users/123/orders/550e8400-e29b-41d4-a716-446655440000?token=secret&page=2&search=' + 'x'.repeat(120))

    expect(sanitized).toContain('/users/:id/orders/:uuid')
    expect(sanitized).toContain('page=%3Aid')
    expect(sanitized).toContain('search=%3Avalue')
    expect(sanitized).not.toContain('token=secret')
  })

  it('infers downstream dependencies from timing and shared response values', async () => {
    installChromeMock()
    const { inferDependencies } = await import('../../src/background/index')

    const upstream = createRequest({
      id: 'upstream',
      url: 'https://api.example.com/users/42',
      startTime: 1_000,
      duration: 200,
      responseBody: JSON.stringify({ data: { userId: 'abc123', projectId: 42 } }),
    })

    const downstream = createRequest({
      id: 'downstream',
      url: 'https://api.example.com/projects/abc123/details',
      startTime: 1_450,
      requestBody: JSON.stringify({ ownerId: 42 }),
    })

    const unrelated = createRequest({
      id: 'unrelated',
      url: 'https://api.example.com/health',
      startTime: 1_100,
      duration: 50,
      responseBody: '{"ok":true}',
    })

    expect(inferDependencies(downstream, [upstream, unrelated])).toEqual(['upstream'])
  })

  it('does not infer dependencies when timing or payload correlation is missing', async () => {
    installChromeMock()
    const { inferDependencies } = await import('../../src/background/index')

    const upstream = createRequest({
      id: 'upstream',
      startTime: 1_000,
      duration: 150,
      responseBody: JSON.stringify({ data: { userId: 'abc123' } }),
    })

    const tooLate = createRequest({
      id: 'late',
      url: 'https://api.example.com/projects/abc123',
      startTime: 3_000,
    })

    const noSharedValue = createRequest({
      id: 'no-shared',
      url: 'https://api.example.com/projects/other',
      startTime: 1_500,
      requestBody: JSON.stringify({ ownerId: 'zzz999' }),
    })

    expect(inferDependencies(tooLate, [upstream])).toEqual([])
    expect(inferDependencies(noSharedValue, [upstream])).toEqual([])
  })

  it('routes replay requests back into the tab and returns fallback errors on failure', async () => {
    const chromeMock = installChromeMock()
    await import('../../src/background/index')
    const listener = chromeMock.getRuntimeMessageListener()

    expect(listener).toBeTypeOf('function')

    const replay: ReplayRequest = {
      id: 'replay-1',
      method: 'POST',
      url: 'https://api.example.com/replay',
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
      originalResponseBody: '{"ok":false}',
    }

    chromeMock.tabs.sendMessage.mockResolvedValueOnce({
      status: 201,
      duration: 88,
      responseBody: '{"ok":true}',
      responseHeaders: { 'content-type': 'application/json' },
    } satisfies ReplayResult)

    const successful = await new Promise<ReplayResult>(resolve => {
      const keepAlive = listener?.({ type: 'RUN_REPLAY', tabId: 9, payload: replay }, {}, result => resolve(result as ReplayResult))
      expect(keepAlive).toBe(true)
    })

    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(9, {
      type: 'EXECUTE_REPLAY',
      payload: replay,
    })
    expect(successful.status).toBe(201)

    chromeMock.tabs.sendMessage.mockRejectedValueOnce(new Error('tab missing'))

    const failed = await new Promise<ReplayResult>(resolve => {
      listener?.({ type: 'RUN_REPLAY', tabId: 9, payload: replay }, {}, result => resolve(result as ReplayResult))
    })

    expect(failed.status).toBe(0)
    expect(failed.responseBody).toContain('tab missing')
  })
})

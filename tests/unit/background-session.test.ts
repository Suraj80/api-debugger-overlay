import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplayAck, ReplayRequest, RequestEntry, TimingUpdatePayload } from '../../src/shared/types'

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
  const localStore: Record<string, unknown> = {}

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
    onActivated: { addListener: vi.fn() },
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
          get: vi.fn((keys?: string | string[]) => {
            if (!keys) return Promise.resolve({ ...localStore })
            if (typeof keys === 'string') {
              return Promise.resolve({ [keys]: localStore[keys] })
            }

            return Promise.resolve(keys.reduce<Record<string, unknown>>((result, key) => {
              result[key] = localStore[key]
              return result
            }, {}))
          }),
          set: vi.fn((items: Record<string, unknown>) => {
            Object.assign(localStore, items)
            return Promise.resolve()
          }),
          remove: vi.fn((key: string) => {
            delete localStore[key]
            return Promise.resolve()
          }),
        },
      },
    },
    configurable: true,
  })

  return {
    runtime,
    tabs,
    localStore,
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

  it('prefers the closest high-signal dependency when several requests share values', async () => {
    installChromeMock()
    const { inferDependencies } = await import('../../src/background/index')

    const earlier = createRequest({
      id: 'earlier',
      url: 'https://api.example.com/users/42',
      startTime: 1_000,
      duration: 200,
      responseBody: JSON.stringify({ data: { projectId: 'proj_abc123' } }),
    })

    const closer = createRequest({
      id: 'closer',
      url: 'https://api.example.com/projects/proj_abc123',
      startTime: 1_220,
      duration: 80,
      responseBody: JSON.stringify({ data: { projectId: 'proj_abc123', ownerId: 'user_777777' } }),
    })

    const downstream = createRequest({
      id: 'downstream',
      url: 'https://api.example.com/projects/proj_abc123/details',
      startTime: 1_330,
      requestBody: JSON.stringify({ ownerId: 'user_777777' }),
    })

    expect(inferDependencies(downstream, [earlier, closer])).toEqual(['closer', 'earlier'])
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

  it('can infer dependencies from prior request signals even when response parsing is unavailable', async () => {
    installChromeMock()
    const { inferDependencies } = await import('../../src/background/index')

    const upstream = createRequest({
      id: 'upstream',
      url: 'https://api.example.com/search?cursor=cursor_abcdef123456',
      startTime: 1_000,
      duration: 120,
      requestBody: 'cursor=cursor_abcdef123456',
      responseBody: null,
    })

    const downstream = createRequest({
      id: 'downstream',
      url: 'https://api.example.com/results/cursor_abcdef123456',
      startTime: 1_150,
    })

    expect(inferDependencies(downstream, [upstream])).toEqual(['upstream'])
  })

  it('clamps browser duration to proxy timing for oversized localhost measurements', async () => {
    installChromeMock()
    const { mergeRequestTiming } = await import('../../src/background/index')

    const proxyRequest = createRequest({
      url: 'http://localhost:3000/api/v1/dashboard',
      duration: 620,
      timingSource: 'proxy',
    })
    const browserTiming: TimingUpdatePayload = {
      id: proxyRequest.id,
      url: proxyRequest.url,
      duration: 1080,
      startTime: proxyRequest.startTime,
      ttfb: 410,
      dnsTime: 0,
      connectTime: 0,
      sslTime: 0,
      requestTime: 410,
      responseTime: 670,
      responseSize: proxyRequest.responseSize,
      decodedBodySize: proxyRequest.decodedBodySize,
      transferSize: proxyRequest.transferSize,
      timingSource: 'performance',
    }

    const merged = mergeRequestTiming(proxyRequest, browserTiming)

    expect(merged.duration).toBe(620)
    expect(merged.timingSource).toBe('performance')
    expect(merged.ttfb).toBe(410)
  })

  it('keeps browser duration for non-local requests', async () => {
    installChromeMock()
    const { mergeRequestTiming } = await import('../../src/background/index')

    const proxyRequest = createRequest({
      url: 'https://api.example.com/users/42',
      duration: 620,
      timingSource: 'proxy',
    })
    const browserTiming: TimingUpdatePayload = {
      id: proxyRequest.id,
      url: proxyRequest.url,
      duration: 1080,
      startTime: proxyRequest.startTime,
      ttfb: 410,
      dnsTime: 12,
      connectTime: 40,
      sslTime: 20,
      requestTime: 410,
      responseTime: 670,
      responseSize: proxyRequest.responseSize,
      decodedBodySize: proxyRequest.decodedBodySize,
      transferSize: proxyRequest.transferSize,
      timingSource: 'performance',
    }

    const merged = mergeRequestTiming(proxyRequest, browserTiming)

    expect(merged.duration).toBe(1080)
    expect(merged.timingSource).toBe('performance')
  })

  it('runs replay requests from the background and publishes progress', async () => {
    const chromeMock = installChromeMock()
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
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

    const successful = await new Promise<ReplayAck>(resolve => {
      const keepAlive = listener?.({ type: 'RUN_REPLAY', tabId: 9, payload: replay }, {}, result => resolve(result as ReplayAck))
      expect(keepAlive).toBe(false)
    })

    expect(successful.ok).toBe(true)
    expect(successful.jobId).toBeTypeOf('string')
    await Promise.resolve()
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/replay', expect.objectContaining({
      method: 'POST',
      body: '{"ok":true}',
      credentials: 'include',
    }))
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'REPLAY_PROGRESS',
      tabId: 9,
      payload: {
        jobId: successful.jobId,
        phase: 'started',
      },
    })
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'REPLAY_PROGRESS',
      tabId: 9,
      payload: expect.objectContaining({
        jobId: successful.jobId,
        phase: 'headers',
        result: expect.objectContaining({
          status: 201,
          responseBody: null,
        }),
      }),
    })
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'REPLAY_PROGRESS',
      tabId: 9,
      payload: expect.objectContaining({
        jobId: successful.jobId,
        phase: 'complete',
        result: expect.objectContaining({
          status: 201,
          responseBody: '{"ok":true}',
        }),
      }),
    })

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    const failed = await new Promise<ReplayAck>(resolve => {
      listener?.({ type: 'RUN_REPLAY', tabId: 9, payload: replay }, {}, result => resolve(result as ReplayAck))
    })

    expect(failed.ok).toBe(true)
    await Promise.resolve()
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'REPLAY_PROGRESS',
      tabId: 9,
      payload: expect.objectContaining({
        jobId: failed.jobId,
        phase: 'error',
        result: expect.objectContaining({
          status: 0,
          responseBody: expect.stringContaining('Failed to fetch'),
        }),
      }),
    })
    vi.unstubAllGlobals()
  })

  it('returns a recovered snapshot when the live session is unavailable', async () => {
    const chromeMock = installChromeMock()
    const listenerReady = import('../../src/background/index')
    const storedSnapshot = {
      tabId: 7,
      tabLabel: 'Example App',
      requests: [
        createRequest({
          id: 'snapshot-request',
          url: 'https://api.example.com/snapshot',
          duration: 340,
        }),
      ],
      lifecycle: 'ended',
      updatedAt: 123_456,
    }

    chromeMock.localStore.apiDebuggerSidePanelSnapshots = {
      7: storedSnapshot,
    }

    await listenerReady
    const listener = chromeMock.getRuntimeMessageListener()

    expect(listener).toBeTypeOf('function')

    const snapshot = await new Promise<any>(resolve => {
      const keepAlive = listener?.({ type: 'GET_SESSION', tabId: 7 }, {}, result => resolve(result))
      expect(keepAlive).toBe(true)
    })

    expect(snapshot).toMatchObject({
      tabId: 7,
      tabLabel: 'Example App',
      requests: storedSnapshot.requests,
      source: 'snapshot',
      lifecycle: 'ended',
      updatedAt: 123_456,
    })
  })

  it('reuses the stored bound tab snapshot when the side panel is reopened', async () => {
    const chromeMock = installChromeMock()
    chromeMock.tabs.query.mockResolvedValue([{ id: 99 }])

    chromeMock.localStore.apiDebuggerSidePanelBoundTabId = 7
    chromeMock.localStore.apiDebuggerSidePanelSnapshots = {
      7: {
        tabId: 7,
        tabLabel: '(354) YouTube',
        requests: [
          createRequest({
            id: 'reopened-snapshot-request',
            url: 'https://api.example.com/youtube/stats',
            duration: 121,
          }),
        ],
        lifecycle: 'ended',
        updatedAt: 456_789,
      },
    }

    await import('../../src/background/index')
    const listener = chromeMock.getRuntimeMessageListener()

    expect(listener).toBeTypeOf('function')

    const snapshot = await new Promise<any>(resolve => {
      const keepAlive = listener?.({ type: 'GET_SESSION' }, {}, result => resolve(result))
      expect(keepAlive).toBe(true)
    })

    expect(snapshot).toMatchObject({
      tabId: 7,
      tabLabel: '(354) YouTube',
      source: 'snapshot',
      lifecycle: 'ended',
      updatedAt: 456_789,
    })
    expect(snapshot.requests).toHaveLength(1)
    expect(snapshot.requests[0].id).toBe('reopened-snapshot-request')
  })

  it('keeps serving the frozen recovered snapshot even after new live requests arrive', async () => {
    const chromeMock = installChromeMock()
    chromeMock.tabs.query.mockResolvedValue([{ id: 7 }])

    chromeMock.localStore.apiDebuggerSidePanelBoundTabId = 7
    chromeMock.localStore.apiDebuggerSidePanelFrozenSnapshotTabId = 7
    chromeMock.localStore.apiDebuggerSidePanelSnapshots = {
      7: {
        tabId: 7,
        tabLabel: 'Recovered Session',
        requests: [
          createRequest({
            id: 'frozen-snapshot-request',
            url: 'https://api.example.com/recovered/session',
            duration: 480,
          }),
        ],
        lifecycle: 'ended',
        updatedAt: 987_654,
      },
    }

    await import('../../src/background/index')
    const listener = chromeMock.getRuntimeMessageListener()

    expect(listener).toBeTypeOf('function')

    listener?.({
      type: 'REQUEST_COMPLETE',
      payload: createRequest({
        id: 'new-live-request',
        url: 'https://api.example.com/new/live',
        duration: 90,
      }),
    }, { tab: { id: 7 } }, () => undefined)

    const snapshot = await new Promise<any>(resolve => {
      const keepAlive = listener?.({ type: 'GET_SESSION' }, {}, result => resolve(result))
      expect(keepAlive).toBe(true)
    })

    expect(snapshot).toMatchObject({
      tabId: 7,
      source: 'snapshot',
      lifecycle: 'ended',
      updatedAt: 987_654,
    })
    expect(snapshot.requests).toHaveLength(1)
    expect(snapshot.requests[0].id).toBe('frozen-snapshot-request')
  })
})

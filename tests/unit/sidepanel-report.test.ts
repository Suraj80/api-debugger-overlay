import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestEntry } from '../../src/shared/types'

function createRequest(overrides: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id: overrides.id ?? 'request-1',
    url: overrides.url ?? 'https://api.example.com/users',
    method: overrides.method ?? 'GET',
    status: overrides.status ?? 200,
    duration: overrides.duration ?? 120,
    startTime: overrides.startTime ?? Date.UTC(2026, 4, 17, 8, 30, 0),
    requestSize: overrides.requestSize ?? 64,
    responseSize: overrides.responseSize ?? 512,
    decodedBodySize: overrides.decodedBodySize ?? 512,
    transferSize: overrides.transferSize ?? 512,
    requestHeaders: overrides.requestHeaders ?? { accept: 'application/json' },
    requestBody: overrides.requestBody ?? null,
    responseBody: overrides.responseBody ?? '{"ok":true}',
    isDuplicate: overrides.isDuplicate ?? false,
    duplicateOf: overrides.duplicateOf ?? null,
    duplicateCount: overrides.duplicateCount ?? 1,
    isSlow: overrides.isSlow ?? false,
    aiSuggestion: overrides.aiSuggestion ?? null,
    dependsOn: overrides.dependsOn ?? [],
    fingerprint: overrides.fingerprint ?? `fp-${overrides.id ?? '1'}`,
    ttfb: overrides.ttfb ?? 42,
    dnsTime: overrides.dnsTime ?? 5,
    connectTime: overrides.connectTime ?? 9,
    sslTime: overrides.sslTime ?? 7,
    requestTime: overrides.requestTime ?? 42,
    responseTime: overrides.responseTime ?? 70,
    timingSource: overrides.timingSource ?? 'performance',
  }
}

describe('sidepanel reporting helpers', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('builds a session export HTML report with escaped content, flags, and suggestions', async () => {
    const { buildSessionReportHtml } = await import('../../src/sidepanel/index')

    const html = buildSessionReportHtml([
      createRequest({
        id: 'a',
        method: 'POST',
        url: 'https://api.example.com/users/42?debug=true',
        status: 503,
        duration: 2200,
        responseSize: 700 * 1024,
        isSlow: true,
        duplicateCount: 2,
        requestBody: '{"name":"Ada"}',
        responseBody: '{"error":"<server-down>"}',
        aiSuggestion: 'Batch the user lookup and trim payload size.',
      }),
    ], 500)

    expect(html).toContain('API Debugger Session Report')
    expect(html).toContain('DUP x2')
    expect(html).toContain('LARGE 700.0 KB')
    expect(html).toContain('SLOW')
    expect(html).toContain('Batch the user lookup and trim payload size.')
    expect(html).toContain('&lt;server-down&gt;')
    expect(html).toContain('Dependency Map')
    expect(html).toContain('Capture Fidelity')
    expect(html).toContain('Failed / Aborted')
  })

  it('renders explicit placeholders for unavailable payloads in the exported report', async () => {
    const { buildSessionReportHtml } = await import('../../src/sidepanel/index')

    const html = buildSessionReportHtml([
      createRequest({
        id: 'failed',
        status: 0,
        requestSize: 128,
        requestBody: null,
        responseSize: 0,
        responseBody: '[Request aborted: abort]',
      }),
      createRequest({
        id: 'binary',
        responseSize: 2048,
        responseBody: '[Binary response omitted: application/octet-stream, 2.0 KB]',
      }),
    ], 500)

    expect(html).toContain('[request body unavailable in capture, 128 B transferred]')
    expect(html).toContain('[Request aborted: abort]')
    expect(html).toContain('[Binary response omitted: application/octet-stream, 2.0 KB]')
  })

  it('renders dependency SVG edges for inferred request chains', async () => {
    const { buildDependencySvg } = await import('../../src/sidepanel/index')

    const html = buildDependencySvg([
      createRequest({
        id: 'upstream',
        url: 'https://api.example.com/users/42',
        duration: 200,
      }),
      createRequest({
        id: 'downstream',
        url: 'https://api.example.com/projects/42/details',
        duration: 840,
        dependsOn: ['upstream'],
      }),
    ])

    expect(html).toContain('<svg')
    expect(html).toContain('/users/42')
    expect(html).toContain('/42/details')
    expect(html).toContain('840ms')
  })

  it('groups duplicate request instances by endpoint path in the dependency SVG', async () => {
    const { buildDependencySvg } = await import('../../src/sidepanel/index')

    const html = buildDependencySvg([
      createRequest({
        id: 'upstream-a',
        url: 'https://api.example.com/backend-api/system_hints?request=1',
      }),
      createRequest({
        id: 'upstream-b',
        url: 'https://api.example.com/backend-api/system_hints?request=2',
      }),
      createRequest({
        id: 'downstream',
        url: 'https://api.example.com/backend-api/messages',
        duration: 620,
        dependsOn: ['upstream-a', 'upstream-b'],
      }),
      createRequest({
        id: 'independent',
        url: 'https://api.example.com/health',
      }),
    ])

    expect(html).toContain('/backend-api/system_hints - 2 captured call(s)')
    expect(html).not.toContain('/health')
    expect(html).toContain('2 call chain(s)')
  })

  it('limits the dependency graph to the first 50 requests in the session', async () => {
    const { buildDependencySvg } = await import('../../src/sidepanel/index')

    const requests = Array.from({ length: 51 }, (_, index) => createRequest({
      id: `request-${index}`,
      url: `https://api.example.com/chain/${index}`,
      dependsOn: index === 0 ? [] : [`request-${index - 1}`],
      duration: 150 + index,
    }))

    const html = buildDependencySvg(requests)

    expect(html).toContain('/chain/0')
    expect(html).toContain('/chain/49')
    expect(html).not.toContain('/chain/50')
  })

  it('marks additions and deletions in replay diffs', async () => {
    const { computeDiff } = await import('../../src/sidepanel/index')

    const diff = computeDiff('line-a\nline-b', 'line-a\nline-c')

    expect(diff.left).toEqual([
      { text: 'line-a', kind: 'same' },
      { text: 'line-b', kind: 'del' },
    ])
    expect(diff.right).toEqual([
      { text: 'line-a', kind: 'same' },
      { text: 'line-c', kind: 'add' },
    ])
  })
})

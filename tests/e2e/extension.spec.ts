import { expect, test, chromium, type BrowserContext, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'

const extensionPath = resolve('dist')

async function startTestServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
        <html>
          <head><title>API Debugger E2E</title></head>
          <body>
            <button id="fetch-users">Fetch users twice</button>
            <button id="xhr-profile">XHR profile</button>
            <button id="large-payload">Large payload</button>
            <button id="dependency-chain">Dependency chain</button>
            <button id="slow-request">Slow request</button>
            <button id="abort-request">Abort request</button>
            <button id="binary-request">Binary request</button>
            <button id="form-request">Form request</button>
            <script>
              document.querySelector('#fetch-users').addEventListener('click', async () => {
                await fetch('/api/users?b=2&a=1')
                await fetch('/api/users?a=1&b=2')
              })
              document.querySelector('#xhr-profile').addEventListener('click', () => {
                const xhr = new XMLHttpRequest()
                xhr.open('POST', '/api/profile')
                xhr.setRequestHeader('content-type', 'application/json')
                xhr.send(JSON.stringify({ id: 42 }))
              })
              document.querySelector('#large-payload').addEventListener('click', () => {
                fetch('/api/large')
              })
              document.querySelector('#dependency-chain').addEventListener('click', async () => {
                const seed = await fetch('/api/seed').then(res => res.json())
                await fetch('/api/projects/' + seed.projectId + '/details', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ projectId: seed.projectId }),
                })
              })
              document.querySelector('#slow-request').addEventListener('click', () => {
                fetch('/api/slow')
              })
              document.querySelector('#abort-request').addEventListener('click', async () => {
                const controller = new AbortController()
                const pending = fetch('/api/abortable', { signal: controller.signal }).catch(() => null)
                setTimeout(() => controller.abort(), 30)
                await pending
              })
              document.querySelector('#binary-request').addEventListener('click', async () => {
                await fetch('/api/binary')
              })
              document.querySelector('#form-request').addEventListener('click', async () => {
                const form = new FormData()
                form.append('name', 'Ada')
                form.append('role', 'engineer')
                await fetch('/api/form', { method: 'POST', body: form })
              })
            </script>
          </body>
        </html>`)
      return
    }

    if (url.pathname === '/api/users') {
      const body = JSON.stringify({ data: { users: [{ id: 42, name: 'Ada' }] } })
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }

    if (url.pathname === '/api/profile') {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const payload = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      const body = JSON.stringify({ ok: true, profileId: payload.id ?? 42 })
      res.writeHead(201, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }

    if (url.pathname === '/api/seed') {
      const body = JSON.stringify({ projectId: 'proj_abc123' })
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }

    if (url.pathname === '/api/projects/proj_abc123/details') {
      const body = JSON.stringify({ ok: true, detailsFor: 'proj_abc123' })
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }

    if (url.pathname === '/api/slow') {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 1700))
      const body = JSON.stringify({ ok: true, slow: true })
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }

    if (url.pathname === '/api/large') {
      const body = JSON.stringify({ data: 'x'.repeat(620 * 1024) })
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }

    if (url.pathname === '/api/binary') {
      const body = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': body.length,
      })
      res.end(body)
      return
    }

    if (url.pathname === '/api/form') {
      const body = JSON.stringify({ ok: true })
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }

    if (url.pathname === '/api/abortable') {
      req.on('aborted', () => {
        res.destroy()
      })
      await new Promise(resolveDelay => setTimeout(resolveDelay, 1000))
      if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      }
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  await new Promise<void>(resolveServer => {
    server.listen(0, '127.0.0.1', resolveServer)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unable to start E2E test server.')
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
  }
}

async function launchExtension() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'api-debugger-e2e-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  })

  return { context, userDataDir }
}

function overlay(page: Page) {
  return page.locator('#api-debugger-root').locator('.apidbg-overlay')
}

test.describe('API Debugger extension', () => {
  let server: Server
  let serverUrl: string
  let context: BrowserContext
  let userDataDir: string
  let page: Page

  test.beforeAll(async () => {
    const testServer = await startTestServer()
    server = testServer.server
    serverUrl = testServer.url

    const extension = await launchExtension()
    context = extension.context
    userDataDir = extension.userDataDir
    page = await context.newPage()
  })

  test.afterAll(async () => {
    await context?.close()
    await new Promise<void>(resolveServer => server?.close(() => resolveServer()))
    if (userDataDir) {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  test('captures fetch, XHR, duplicates, and large payload warnings', async () => {
    await page.goto(serverUrl)
    await expect(overlay(page)).toContainText('API Debugger')

    await page.locator('#fetch-users').click()
    await page.locator('#xhr-profile').click()
    await page.locator('#large-payload').click()

    await expect(overlay(page)).toContainText('/api/users')
    await expect(overlay(page)).toContainText('/api/profile')
    await expect(overlay(page)).toContainText('/api/large')
    await expect(overlay(page)).toContainText('DUP x2')
    await expect(overlay(page)).toContainText('LARGE')
  })

  test('opens request details and exposes JSON path copy controls', async () => {
    await page.goto(serverUrl)
    await expect(overlay(page)).toContainText('API Debugger')

    await page.locator('#fetch-users').click()

    const usersRow = overlay(page).locator('.apidbg-row', { hasText: '/api/users' }).first()
    await usersRow.press('Enter')

    await expect(overlay(page).locator('[role="tree"]')).toBeVisible()
    await expect(overlay(page).locator('.apidbg-json-copy', { hasText: 'Path' }).first()).toBeVisible()
  })

  test('shows replay controls and captured request payloads for mutation requests', async () => {
    await page.goto(serverUrl)
    await expect(overlay(page)).toContainText('API Debugger')

    await page.locator('#xhr-profile').click()

    const profileRow = overlay(page).locator('.apidbg-row', { hasText: '/api/profile' }).first()
    await profileRow.press('Enter')
    await overlay(page).getByRole('button', { name: 'request' }).click()

    await expect(overlay(page).getByRole('tree', { name: 'Request JSON tree' })).toBeVisible()
    await expect(overlay(page)).toContainText('content-type')
    await expect(overlay(page)).toContainText('application/json')
    await expect(overlay(page)).toContainText('42')
    await expect(overlay(page).getByRole('button', { name: 'Replay' })).toBeVisible()
  })

  test('captures chained requests and exposes slow-request actions in the overlay', async () => {
    await page.goto(serverUrl)
    await expect(overlay(page)).toContainText('API Debugger')

    await page.locator('#dependency-chain').click()
    await page.locator('#slow-request').click()

    await expect(overlay(page)).toContainText('/api/seed')
    await expect(overlay(page)).toContainText('/api/projects/proj_abc123/details')
    await expect(overlay(page)).toContainText('/api/slow')
    await expect(overlay(page)).toContainText('SLOW')

    const slowRow = overlay(page).locator('.apidbg-row', { hasText: '/api/slow' }).first()
    await slowRow.press('Enter')
    await expect(overlay(page).getByRole('button', { name: 'Ask AI' })).toBeVisible()
  })

  test('captures aborted requests and binary responses with explicit placeholders', async () => {
    await page.goto(serverUrl)
    await expect(overlay(page)).toContainText('API Debugger')

    await page.locator('#abort-request').click()
    await page.locator('#binary-request').click()

    await expect(overlay(page)).toContainText('/api/abortable')
    await expect(overlay(page)).toContainText('/api/binary')

    const abortedRow = overlay(page).locator('.apidbg-row', { hasText: '/api/abortable' }).first()
    await abortedRow.press('Enter')
    await expect(overlay(page)).toContainText('Request aborted')

    const binaryRow = overlay(page).locator('.apidbg-row', { hasText: '/api/binary' }).first()
    await binaryRow.press('Enter')
    await expect(overlay(page)).toContainText('Binary response omitted')
  })

  test('captures form submissions and preserves request payload details', async () => {
    await page.goto(serverUrl)
    await expect(overlay(page)).toContainText('API Debugger')

    await page.locator('#form-request').click()

    const formRow = overlay(page).locator('.apidbg-row', { hasText: '/api/form' }).first()
    await formRow.press('Enter')
    await overlay(page).getByRole('button', { name: 'request' }).click()

    await expect(overlay(page).getByRole('tree', { name: 'Request JSON tree' })).toBeVisible()
    await expect(overlay(page)).toContainText('name=Ada')
    await expect(overlay(page)).toContainText('role=engineer')
  })
})

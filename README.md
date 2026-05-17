# API Debugger Overlay

API Debugger Overlay is a Chrome Manifest V3 extension that captures `fetch` and `XMLHttpRequest` traffic from the current page and shows a live in-page debugging overlay. It is built for frontend engineers, fullstack developers, and QA engineers who want quick API visibility without opening DevTools.

## Current Status

The project has the core extension scaffold and several PRD features implemented:

- MV3 Chrome extension setup with content script, injected page script, background service worker, popup, and side panel.
- Real-time request feed for `fetch` and XHR calls.
- Request metadata: method, URL, status, duration, request size, response size, timestamp, request body, response body, and TTFB where available.
- Duplicate request detection using FNV-1a fingerprinting over normalized method, URL, and body.
- Configurable capture settings, latency threshold, payload threshold, overlay position, and API key field from the popup.
- In-page overlay with live session metrics, status badges, slow request badges, duplicate badges, and a Canvas latency sparkline.
- Lazy JSON response viewer with tree expansion, search, copy JSON, and basic AI suggestion UI.
- Side panel with session dashboard, latency chart, dependency graph view, and request replay view.
- Request replay routed back through the original tab context so cookies/session state are preserved.
- AI suggestion requests routed through the background service worker with sanitization and rate limiting.
- Anthropic API key stored encrypted in `chrome.storage.local`, with migration from earlier plaintext storage.
- Focused Vitest unit coverage for encrypted settings storage and AI prompt sanitization.

Still pending from the PRD:

- Broader automated coverage for request interception, session metrics, replay, export, and E2E extension flows.
- Per-node JSON path copy.
- CI/CD workflow and Chrome Web Store packaging polish.

## Project Structure

```text
src/
  injected/      Page-context script that wraps fetch and XMLHttpRequest
  content/       Content script and React overlay mounted in Shadow DOM
  background/    MV3 service worker for session storage and message routing
  popup/         Extension popup settings UI
  sidepanel/     Session dashboard, dependency map, and replay UI
  shared/        Shared settings and TypeScript types
tests/           Reserved for unit and E2E tests
manifest.json    Chrome extension manifest
vite.config.ts   Vite + CRX build config
```

## Requirements

- Node.js 20+
- pnpm
- Chrome 114+ for `chrome.sidePanel`

## Setup

Install dependencies:

```bash
pnpm install
```

Run the development build:

```bash
pnpm dev
```

Create a production build:

```bash
pnpm build
```

Run linting:

```bash
pnpm lint
```

Run tests:

```bash
pnpm test
```

Note: the test suite is not populated yet.

## Loading In Chrome

1. Run `pnpm build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the generated `dist` directory.
6. Open a website that performs API calls and activate the extension.

## How It Works

The content script runs at `document_start` and injects `src/injected/index.js` into the page context. The injected script wraps `window.fetch` and `XMLHttpRequest` methods, captures completed request details, and sends those details back through `window.postMessage`.

The content script forwards captured events to the service worker and renders the overlay inside a Shadow DOM root so host page styles do not leak into the UI. The service worker keeps an in-memory per-tab session and broadcasts updates to the overlay and side panel.

Request replay is initiated from the overlay or side panel, sent through the service worker, and executed back in the original tab context using the page's native `fetch`.

## Privacy

Captured request data is processed locally in memory for the current tab session. Session data is cleared when the tab navigates or closes.

The popup stores regular settings in `chrome.storage.sync` and stores the optional API key encrypted in `chrome.storage.local`.

No request data is sent to external services unless the user explicitly clicks `Ask AI`. In that case, sanitized request context is sent from the background service worker to `api.anthropic.com`, subject to a local rate limit.

## PRD Alignment

The implementation is currently closest to phases 1-3 of the PRD, with partial phase 4 work:

- Phase 1: scaffold, injection, fetch/XHR interception, bridge, and basic overlay are implemented.
- Phase 2: duplicate detection, latency alerts, payload sizing, and JSON viewer are partially to mostly implemented.
- Phase 3: session metrics, Canvas chart, and popup settings are implemented. Regular settings now use sync storage; the API key remains local.
- Phase 4: side panel, replay flow, dependency graph rendering, and heuristic dependency inference are implemented.
- Phase 5: AI integration and HTML export are implemented.
- Phase 6: focused unit tests exist; broader test coverage, polish, CI/CD, and release materials are pending.

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start Vite development server |
| `pnpm build` | Build the Chrome extension into `dist` |
| `pnpm preview` | Preview the Vite build |
| `pnpm lint` | Run ESLint over `src` |
| `pnpm test` | Run Vitest |

## License

MIT. See [LICENSE](LICENSE).

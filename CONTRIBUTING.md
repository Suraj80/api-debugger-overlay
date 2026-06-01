# Contributing

Thanks for contributing to API Debugger Overlay.

## Local Setup

Requirements:

- Node.js 20+
- pnpm
- Chrome 114+

Install dependencies: 

```bash
pnpm install
```

Start the development build:

```bash
pnpm dev
```

Create a production build:

```bash
pnpm build
```

## Load The Extension

1. Build the project with `pnpm build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `dist` directory.

Reload the extension in Chrome after rebuilds when needed.

## Development Workflow

- Keep changes focused and small when possible.
- Prefer updating or adding tests with behavior changes.
- Preserve the existing extension architecture:
  - injected page script for page-context capture
  - content script for bridge and overlay mounting
  - background service worker for session state and message routing
  - popup and side panel as extension UI surfaces

## Testing

Run lint:

```bash
pnpm lint
```

Run unit tests:

```bash
pnpm test --run
```

Run end-to-end tests:

```bash
pnpm test:e2e
```

Run the full test suite:

```bash
pnpm test:all
```

## Packaging

Create a store-upload artifact:

```bash
pnpm build
pnpm package:extension
```

The generated ZIP is written to `release/`.

## Pull Request Guidance

- Describe the user-visible problem and the chosen fix clearly.
- Mention any privacy, replay, capture, or AI-related behavior changes explicitly.
- Include testing notes in the PR description.
- Keep docs in sync when behavior or setup changes.

## Extension-Specific Gotchas

- The injected script runs in the page context, not the extension world.
- The content script is responsible for safe bridging between page and extension runtime.
- Replay behavior must remain scoped to the original tab context.
- Session data is intentionally per-tab and in-memory.
- AI features should remain explicit user actions and use sanitized request context.
- Graph and export views should stay readable under noisy sessions.

## Related Docs

- [Project features](docs/features.md)
- [Privacy policy](docs/privacy-policy.md)
- [Chrome Web Store release guide](docs/chrome-web-store-release.md)

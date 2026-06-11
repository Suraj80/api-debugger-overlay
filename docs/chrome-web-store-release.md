# Chrome Web Store Release Guide

This project now supports a simple release flow:

1. Install dependencies with `pnpm install`.
2. Build the extension with `pnpm build`.
3. Run the full verification pass:
   - `pnpm lint`
   - `pnpm test --run`
   - `pnpm test:e2e`
4. Package the built extension with `pnpm package:extension`.
5. Upload `release/api-debugger-overlay-v<version>.zip` to the Chrome Web Store developer dashboard.

## Pre-publish Checklist

- Verify `manifest.json` version matches the intended release.
- Confirm the generated `dist/manifest.json` contains the expected permissions and entry points.
- Smoke test the unpacked build in Chrome:
  - capture `fetch` requests
  - capture XHR requests
  - open the side panel
  - replay a request
  - export a session report
  - test AI connection with a real key
- Review the permission list before submission:
  - `storage`: saves user settings
  - `activeTab`: targets the active tab for extension actions
  - `sidePanel`: opens the dashboard UI
  - `webRequest`: enriches captured status data
  - `debugger`: powers optional precise timing mode
  - `scripting`: required for extension script injection workflows
- Confirm the privacy disclosure in [privacy-policy.md](./privacy-policy.md) is still accurate.
- Refresh store screenshots if the UI changed.
- Refresh the store listing text in [chrome-web-store-listing.md](./chrome-web-store-listing.md) if features changed.

## Store Assets To Upload

- ZIP package: `release/api-debugger-overlay-v<version>.zip`
- Extension icon assets required by the store dashboard
- At least one screenshot of:
  - in-page overlay
  - side panel dashboard
  - replay editor
  - export report or AI suggestion flow
- Privacy policy URL or hosted copy of [privacy-policy.md](./privacy-policy.md)

## Notes

- The project uses Manifest V3 and a background service worker.
- Session data is kept in memory per tab and cleared on tab close/navigation.
- OpenAI requests occur only after a user clicks `Ask AI`.

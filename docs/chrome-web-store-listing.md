# Chrome Web Store Listing Copy

## Store Name

API Debugger Overlay

## Summary

Capture `fetch` and XHR traffic on any page and inspect API behavior without opening DevTools.

## Description

API Debugger Overlay is a Chrome extension for frontend engineers, fullstack developers, and QA teams who want instant visibility into API activity directly on the page they are testing.

It captures `fetch` and `XMLHttpRequest` calls in real time and renders a live overlay with request details, latency markers, duplicate detection, and payload previews. When deeper analysis is needed, the side panel expands the session into charts, dependency mapping, request replay, and export tools.

Key features:

- Real-time request feed for `fetch` and XHR
- Request metadata including method, URL, status, duration, TTFB, sizes, headers, and payloads where capturable
- Slow request, duplicate request, and large payload badges
- JSON viewer with expand/collapse, search, copy JSON, and JSON path copy
- Session dashboard with latency timeline and endpoint summary
- Dependency graph for inferred request chains
- Replay editor that reruns requests in the original tab context
- Optional AI suggestions with sanitized request context
- HTML session export for sharing debugging sessions

Precise timing mode can optionally attach the Chrome debugger to the active tab for more detailed timing metrics. Chrome will display its standard debugging banner when that mode is enabled.

## Category

Developer Tools

## Support

- Repository README: `README.md`
- Release checklist: `docs/chrome-web-store-release.md`

## Permissions Justification

- `storage`: persists extension settings
- `activeTab`: scopes actions to the current tab
- `sidePanel`: opens the debugging dashboard
- `webRequest`: captures final network status information
- `debugger`: enables optional precise timing mode
- `scripting`: supports extension runtime injection behavior
- `<all_urls>` host access: needed to observe API traffic on the pages the user chooses to debug

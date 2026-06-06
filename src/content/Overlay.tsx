import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AISuggestionResponse, RequestEntry } from '../shared/types'
import { saveSettings, type ApiDebuggerSettings } from '../shared/settings'
import { useSettings, useUpdateSettings } from '../shared/SettingsContext'
import { sendRuntimeMessage } from '../shared/sendMessage'

interface RequestCompleteMessage {
  type: 'REQUEST_COMPLETE'
  payload: RequestEntry
}

interface RequestUpdatedMessage {
  type: 'REQUEST_UPDATED'
  payload: RequestEntry
}

type OverlayState = 'feed' | 'paused' | 'minimised' | 'hidden'
type JsonExpandMode = 'all' | 'none' | null
type JsonTab = 'response' | 'request'
type AISuggestionState = 'idle' | 'loading' | 'result' | 'error'

function isRequestCompleteMessage(msg: unknown): msg is RequestCompleteMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as { type?: unknown }).type === 'REQUEST_COMPLETE' &&
    'payload' in msg
  )
}

function isRequestUpdatedMessage(msg: unknown): msg is RequestUpdatedMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as { type?: unknown }).type === 'REQUEST_UPDATED' &&
    'payload' in msg
  )
}

const overlayThemeCss = `
  :host {
    color-scheme: dark;
    --api-color-primary: #7c5cff;
    --api-color-primary-soft: #b7a6ff;
    --api-color-primary-strong: #5136c9;
    --api-color-secondary: #5b7cfa;
    --api-color-secondary-soft: #9cb8ff;
    --api-color-tertiary: #d49a2e;
    --api-color-tertiary-soft: #ffd477;
    --api-color-neutral: #7d8ba2;
    --api-bg: #050b14;
    --api-surface: #0a1421;
    --api-surface-raised: #101d2d;
    --api-surface-glass: rgba(11, 23, 37, 0.82);
    --api-border: rgba(126, 151, 183, 0.2);
    --api-border-strong: rgba(143, 169, 203, 0.38);
    --api-text: #f3f7ff;
    --api-text-muted: #aab7ca;
    --api-text-subtle: #718096;
    --api-danger: #ff786f;
    --api-danger-bg: rgba(255, 92, 82, 0.12);
    --api-success: #53e6a4;
    --api-warning: #ffbf4b;
    --api-info: #65a8ff;
    --api-chart-line: #8b6cff;
    --api-chart-grid: rgba(130, 153, 183, 0.12);
  }

  @keyframes apidbg-pulse-glow {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.7; transform: scale(1.15); }
  }

  @keyframes apidbg-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  @keyframes apidbg-slide-in-up {
    from { transform: translateY(8px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  @keyframes apidbg-sweep {
    0% { top: 0; opacity: 0.3; }
    100% { top: 100%; opacity: 0; }
  }

  @keyframes apidbg-pulse-soft {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }

  @keyframes apidbg-wave-pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  .apidbg-overlay,
  .apidbg-minimised {
    box-sizing: border-box;
    font-family: Inter, "SF Pro Display", "Segoe UI Variable", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 12px;
    line-height: 1.4;
    -webkit-font-smoothing: antialiased;
  }

  .apidbg-overlay *,
  .apidbg-minimised * {
    box-sizing: border-box;
  }

  .apidbg-overlay button,
  .apidbg-overlay input,
  .apidbg-minimised button {
    font: inherit;
  }

  .apidbg-overlay {
    position: fixed;
    z-index: 2147483647;
    display: flex;
    width: min(500px, calc(100vw - 24px));
    height: min(82vh, 720px);
    min-height: 520px;
    overflow: hidden;
    flex-direction: column;
    border: 1px solid var(--api-border-strong);
    border-radius: 18px;
    background:
      radial-gradient(circle at 5% 0%, rgba(47, 211, 145, 0.08), transparent 28%),
      radial-gradient(circle at 95% 10%, rgba(124, 92, 255, 0.1), transparent 32%),
      linear-gradient(145deg, rgba(8, 18, 30, 0.98), rgba(3, 9, 17, 0.99));
    color: var(--api-text);
    box-shadow:
      0 30px 80px rgba(0, 0, 0, 0.62),
      0 0 0 1px rgba(255, 255, 255, 0.025) inset,
      0 0 40px rgba(39, 123, 171, 0.08);
    backdrop-filter: blur(22px) saturate(125%);
  }

  .apidbg-overlay.is-bottom-right,
  .apidbg-minimised.is-bottom-right {
    right: 16px;
    bottom: 16px;
  }

  .apidbg-overlay.is-bottom-left,
  .apidbg-minimised.is-bottom-left {
    left: 16px;
    bottom: 16px;
  }

  .apidbg-overlay.is-top-right,
  .apidbg-minimised.is-top-right {
    top: 16px;
    right: 16px;
  }

  .apidbg-overlay.is-top-left,
  .apidbg-minimised.is-top-left {
    top: 16px;
    left: 16px;
  }

  .apidbg-header {
    flex-shrink: 0;
    padding: 15px 15px 12px;
  }

  .apidbg-title-row,
  .apidbg-brand,
  .apidbg-title,
  .apidbg-actions,
  .apidbg-paused,
  .apidbg-row,
  .apidbg-row-tools,
  .apidbg-tabs,
  .apidbg-detail-actions,
  .apidbg-ai-title,
  .apidbg-ai-footer,
  .apidbg-minimised {
    display: flex;
    align-items: center;
  }

  .apidbg-title-row {
    justify-content: space-between;
    gap: 10px;
  }

  .apidbg-brand {
    min-width: 0;
    gap: 10px;
  }

  .apidbg-brand-mark {
    display: inline-flex;
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(71, 232, 163, 0.22);
    border-radius: 10px;
    background: linear-gradient(145deg, rgba(26, 121, 85, 0.32), rgba(8, 59, 46, 0.55));
    box-shadow: 0 8px 24px rgba(31, 214, 143, 0.11), inset 0 1px rgba(255, 255, 255, 0.08);
    color: var(--api-success);
  }

  .apidbg-brand-mark svg {
    width: 22px;
    height: 22px;
  }

  .apidbg-title {
    align-items: flex-start;
    flex-direction: column;
    gap: 0;
    min-width: 0;
    font-size: 16px;
    font-weight: 780;
    letter-spacing: -0.35px;
    line-height: 1.15;
  }

  .apidbg-title-caption {
    margin-top: 3px;
    color: var(--api-text-subtle);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.55px;
    text-transform: uppercase;
  }

  .apidbg-actions {
    gap: 6px;
    padding: 3px;
    border: 1px solid rgba(126, 151, 183, 0.16);
    border-radius: 10px;
    background: rgba(9, 19, 31, 0.64);
  }

  .apidbg-icon-button {
    display: inline-flex;
    width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.025);
    color: var(--api-text-muted);
    cursor: pointer;
    line-height: 1;
    padding: 0;
    transition: transform 0.16s ease, background 0.16s ease, color 0.16s ease, border-color 0.16s ease;
  }

  .apidbg-icon-button:hover,
  .apidbg-icon-button:focus-visible {
    border-color: rgba(139, 108, 255, 0.4);
    background: rgba(124, 92, 255, 0.12);
    color: var(--api-text);
    outline: none;
    transform: translateY(-1px);
  }

  .apidbg-icon-button svg {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    stroke: currentColor;
  }

  .apidbg-header-button {
    display: inline-flex;
    height: 28px;
    align-items: center;
    gap: 5px;
    border: 1px solid rgba(126, 151, 183, 0.22);
    border-radius: 7px;
    background: linear-gradient(180deg, rgba(22, 35, 52, 0.9), rgba(11, 22, 35, 0.9));
    color: var(--api-text-muted);
    cursor: pointer;
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    padding: 0 9px;
    transition: transform 0.16s ease, background 0.16s ease, color 0.16s ease, border-color 0.16s ease;
  }

  .apidbg-header-button svg {
    width: 13px;
    height: 13px;
    stroke: currentColor;
  }

  .apidbg-header-button:hover,
  .apidbg-header-button:focus-visible {
    border-color: rgba(139, 108, 255, 0.4);
    background: rgba(124, 92, 255, 0.12);
    color: var(--api-text);
    outline: none;
    transform: translateY(-1px);
  }

  .apidbg-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin-top: 13px;
  }

  .apidbg-metric-card {
    position: relative;
    display: grid;
    min-width: 0;
    min-height: 61px;
    grid-template-columns: 28px minmax(0, 1fr);
    align-items: center;
    gap: 7px;
    overflow: hidden;
    border: 1px solid var(--api-border);
    border-radius: 11px;
    background: linear-gradient(145deg, rgba(16, 31, 48, 0.84), rgba(7, 17, 29, 0.9));
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.025), 0 8px 24px rgba(0, 0, 0, 0.12);
    padding: 8px;
  }

  .apidbg-metric-card::after {
    position: absolute;
    top: 8px;
    bottom: 8px;
    left: 0;
    width: 2px;
    border-radius: 0 2px 2px 0;
    background: var(--metric-color);
    box-shadow: 0 0 12px var(--metric-color);
    content: "";
    opacity: 0.75;
  }

  .apidbg-metric-card.is-purple { --metric-color: #9b7cff; --metric-bg: rgba(124, 92, 255, 0.14); }
  .apidbg-metric-card.is-green { --metric-color: #53e6a4; --metric-bg: rgba(57, 218, 151, 0.11); }
  .apidbg-metric-card.is-danger { --metric-color: #ff786f; --metric-bg: rgba(255, 92, 82, 0.11); }
  .apidbg-metric-card.is-amber { --metric-color: #ffbf4b; --metric-bg: rgba(255, 177, 51, 0.11); }

  .apidbg-metric-icon {
    display: inline-flex;
    width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--metric-color) 24%, transparent);
    border-radius: 9px;
    background: var(--metric-bg);
    color: var(--metric-color);
  }

  .apidbg-metric-icon svg {
    width: 15px;
    height: 15px;
  }

  .apidbg-metric-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .apidbg-metric-label {
    overflow: hidden;
    color: var(--api-text-subtle);
    font-size: 8px;
    font-weight: 650;
    letter-spacing: 0.15px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .apidbg-metric-value {
    margin-top: 1px;
    color: var(--metric-color);
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    font-size: 14px;
    font-weight: 800;
    letter-spacing: -0.4px;
  }

  .apidbg-metric-detail {
    grid-column: 2;
    margin-top: -8px;
    color: var(--api-text-subtle);
    font-size: 7px;
    white-space: nowrap;
  }

  .apidbg-chart-card {
    flex: 0 0 auto;
    margin: 0 14px 10px;
    overflow: hidden;
    border: 1px solid var(--api-border);
    border-radius: 12px;
    background: linear-gradient(180deg, rgba(12, 25, 40, 0.82), rgba(6, 15, 26, 0.88));
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.025);
    padding: 10px 10px 7px;
  }

  .apidbg-chart-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 0 3px 5px;
  }

  .apidbg-chart-title,
  .apidbg-chart-subtitle {
    display: block;
  }

  .apidbg-chart-title {
    color: var(--api-text-muted);
    font-size: 11px;
    font-weight: 720;
  }

  .apidbg-chart-subtitle,
  .apidbg-chart-count {
    margin-top: 2px;
    color: var(--api-text-subtle);
    font-size: 8px;
  }

  .apidbg-chart-count {
    border: 1px solid rgba(139, 108, 255, 0.2);
    border-radius: 999px;
    background: rgba(124, 92, 255, 0.08);
    color: var(--api-color-primary-soft);
    padding: 2px 6px;
  }

  .apidbg-sparkline {
    position: relative;
    padding: 0;
  }

  .apidbg-sparkline canvas {
    display: block;
    width: 100%;
    height: 88px;
  }

  .apidbg-tooltip {
    position: fixed;
    z-index: 2147483647;
    pointer-events: none;
    border: 1px solid var(--api-border-strong);
    border-radius: 8px;
    background: rgba(13, 27, 43, 0.96);
    color: var(--api-text);
    font-size: 11px;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.42);
    padding: 5px 8px;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .apidbg-paused {
    justify-content: center;
    gap: 12px;
    margin: 0 14px 9px;
    border: 1px solid rgba(255, 191, 75, 0.22);
    border-radius: 9px;
    background: rgba(255, 177, 51, 0.09);
    color: var(--api-warning);
    font-size: 11px;
    padding: 7px;
    text-align: center;
  }

  .apidbg-link-button {
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    text-decoration: underline;
  }

  .apidbg-table-shell {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    margin: 0 10px 10px;
    overflow: hidden;
    border: 1px solid var(--api-border);
    border-radius: 13px;
    background: rgba(4, 12, 21, 0.64);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.02);
  }

  .apidbg-table-head,
  .apidbg-row {
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr) 48px 39px 56px 14px;
    align-items: center;
    column-gap: 7px;
  }

  .apidbg-table-head {
    flex: 0 0 auto;
    min-height: 34px;
    border-bottom: 1px solid var(--api-border);
    background: rgba(13, 27, 43, 0.72);
    color: var(--api-text-subtle);
    font-size: 8px;
    font-weight: 750;
    letter-spacing: 0.7px;
    padding: 0 10px;
    text-transform: uppercase;
  }

  .apidbg-table-head span:nth-child(3),
  .apidbg-table-head span:nth-child(4) {
    text-align: center;
  }

  .apidbg-table-head span:nth-child(5) {
    text-align: right;
  }

  .apidbg-list {
    position: relative;
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    transition: opacity 0.2s;
    padding: 6px;
  }

  .apidbg-list.is-paused {
    opacity: 0.5;
  }

  .apidbg-sweep {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 2;
    height: 1px;
    background: rgba(238, 232, 245, 0.35);
    animation: apidbg-sweep 0.3s linear forwards;
  }

  .apidbg-row-wrap {
    position: relative;
    margin-bottom: 5px;
    overflow: hidden;
    border: 1px solid rgba(126, 151, 183, 0.14);
    border-radius: 10px;
    background: linear-gradient(100deg, rgba(14, 28, 44, 0.88), rgba(8, 19, 32, 0.9));
    box-shadow: 0 5px 16px rgba(0, 0, 0, 0.1), inset 0 1px rgba(255, 255, 255, 0.018);
    transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
  }

  .apidbg-row-wrap:last-child {
    margin-bottom: 0;
  }

  .apidbg-row-wrap::before {
    position: absolute;
    top: 10px;
    bottom: 10px;
    left: 0;
    width: 2px;
    border-radius: 0 3px 3px 0;
    background: var(--row-accent, var(--api-color-primary));
    box-shadow: 0 0 10px var(--row-accent, var(--api-color-primary));
    content: "";
    opacity: 0.82;
  }

  .apidbg-row-wrap[data-method="get"] { --row-accent: #9b7cff; }
  .apidbg-row-wrap[data-method="post"] { --row-accent: #53e6a4; }
  .apidbg-row-wrap[data-method="put"] { --row-accent: #65a8ff; }
  .apidbg-row-wrap[data-method="patch"] { --row-accent: #ffbf4b; }
  .apidbg-row-wrap[data-method="delete"] { --row-accent: #ff786f; }

  .apidbg-row-wrap:hover {
    border-color: rgba(139, 108, 255, 0.32);
    background: linear-gradient(100deg, rgba(18, 35, 55, 0.94), rgba(10, 23, 38, 0.95));
    box-shadow: 0 9px 22px rgba(0, 0, 0, 0.2), 0 0 18px rgba(111, 85, 214, 0.05);
    transform: translateY(-1px);
  }

  .apidbg-row-wrap.has-duplicates {
    border-color: rgba(255, 191, 75, 0.22);
  }

  .apidbg-row {
    min-height: 52px;
    padding: 7px 8px 7px 10px;
    background: transparent;
    cursor: pointer;
    transition: background 0.16s;
  }

  .apidbg-row:hover {
    background: rgba(255, 255, 255, 0.012);
  }

  .apidbg-row:focus-visible,
  .apidbg-tab:focus-visible,
  .apidbg-search:focus-visible,
  .apidbg-plain-button:focus-visible,
  .apidbg-primary-button:focus-visible,
  .apidbg-secondary-button:focus-visible,
  .apidbg-minimised:focus-visible,
  .apidbg-link-button:focus-visible,
  .apidbg-json-row:focus-visible,
  .apidbg-json-copy:focus-visible {
    outline: 2px solid var(--api-color-primary-soft);
    outline-offset: 2px;
  }

  .apidbg-path {
    display: block;
    min-width: 0;
    overflow: hidden;
    color: #c7d2e3;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    font-size: 10px;
    font-weight: 560;
    letter-spacing: -0.15px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .apidbg-endpoint-cell {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 4px;
  }

  .apidbg-row-flags {
    display: flex;
    min-width: 0;
    gap: 4px;
    overflow: hidden;
  }

  .apidbg-chevron {
    color: var(--api-text-subtle);
    font-size: 14px;
    transition: transform 0.15s ease;
  }

  .apidbg-chevron.is-open {
    transform: rotate(180deg);
  }

  .apidbg-footer {
    display: flex;
    min-height: 34px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    gap: 7px;
    border-top: 1px solid var(--api-border);
    background: rgba(9, 21, 34, 0.82);
    color: var(--api-text-subtle);
    font-size: 9px;
    padding: 0 9px;
    white-space: nowrap;
  }

  .apidbg-footer-live {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--api-success);
    font-weight: 750;
  }

  .apidbg-footer-live .apidbg-live-dot {
    width: 6px;
    height: 6px;
  }

  .apidbg-footer-divider {
    width: 3px;
    height: 3px;
    border-radius: 99px;
    background: var(--api-border-strong);
  }

  .apidbg-footer-stat.is-error {
    color: color-mix(in srgb, var(--api-danger) 78%, var(--api-text-subtle));
  }

  .apidbg-footer-stat.is-duplicate {
    color: color-mix(in srgb, var(--api-warning) 72%, var(--api-text-subtle));
  }

  .apidbg-detail {
    border-top: 1px solid var(--api-border);
    background: rgba(5, 13, 23, 0.96);
    padding: 12px;
  }

  .apidbg-detail.is-modal {
    display: flex;
    max-height: min(84vh, 760px);
    flex-direction: column;
    border: 1px solid var(--api-border);
    border-radius: 14px;
    box-shadow: 0 28px 68px rgba(0, 0, 0, 0.62);
    padding: 16px;
  }

  .apidbg-detail-header {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .apidbg-tabs {
    gap: 12px;
  }

  .apidbg-tab {
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--api-text-subtle);
    cursor: pointer;
    font-size: 12px;
    padding: 4px 0;
    text-transform: capitalize;
  }

  .apidbg-tab.is-active {
    border-bottom-color: var(--api-color-primary-soft);
    color: var(--api-text);
  }

  .apidbg-row-tools {
    gap: 8px;
  }

  .apidbg-search {
    width: 120px;
    border: 1px solid var(--api-border);
    border-radius: 6px;
    background: var(--api-surface);
    color: var(--api-text);
    font-size: 11px;
    outline: none;
    padding: 3px 8px;
  }

  .apidbg-search:focus {
    border-color: var(--api-color-primary-soft);
  }

  .apidbg-plain-button {
    border: 0;
    background: none;
    color: var(--api-text-subtle);
    cursor: pointer;
    font-size: 11px;
    padding: 0;
  }

  .apidbg-plain-button:hover {
    color: var(--api-color-primary-soft);
  }

  .apidbg-json-box {
    height: 132px;
    min-height: 120px;
    max-height: 320px;
    overflow-y: auto;
    border: 1px solid var(--api-border);
    border-radius: 6px 6px 0 0;
    background: #18151d;
    padding: 8px;
    resize: vertical;
  }

  .apidbg-json-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 28px;
    margin-top: -1px;
    border: 1px solid var(--api-border);
    border-top: 0;
    border-radius: 0 0 6px 6px;
    background: var(--api-surface);
    padding: 0 12px;
  }

  .apidbg-json-meta {
    color: var(--api-text-subtle);
    font-size: 11px;
  }

  .apidbg-json-row {
    display: flex;
    min-height: 20px;
    align-items: center;
    gap: 5px;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
  }

  .apidbg-json-row:hover {
    background: rgba(203, 184, 255, 0.06);
  }

  .apidbg-json-key {
    color: var(--api-color-primary-soft);
  }

  .apidbg-json-key.is-match {
    border-radius: 2px;
    background: rgba(201, 167, 77, 0.18);
    color: var(--api-warning);
    padding: 0 2px;
  }

  .apidbg-json-punct,
  .apidbg-json-preview,
  .apidbg-json-path {
    color: var(--api-text-subtle);
  }

  .apidbg-json-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .apidbg-json-value-string {
    color: var(--api-success);
  }

  .apidbg-json-value-number {
    color: #89c2ff;
  }

  .apidbg-json-value-boolean {
    color: var(--api-warning);
  }

  .apidbg-json-value-null,
  .apidbg-json-value-undefined {
    color: var(--api-text-subtle);
    font-style: italic;
  }

  .apidbg-json-copy {
    flex-shrink: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--api-text-subtle);
    cursor: pointer;
    font-size: 10px;
    line-height: 1;
    opacity: 0;
    padding: 3px 5px;
  }

  .apidbg-json-row:hover .apidbg-json-copy,
  .apidbg-json-copy:focus-visible,
  .apidbg-json-copy.is-copied {
    opacity: 1;
  }

  .apidbg-json-copy:hover,
  .apidbg-json-copy.is-copied {
    background: var(--api-surface-raised);
    color: var(--api-color-primary-soft);
  }

  .apidbg-detail-actions {
    gap: 8px;
    padding-top: 8px;
  }

  .apidbg-meta-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    margin-bottom: 8px;
  }

  .apidbg-meta-cell {
    border: 1px solid var(--api-border);
    border-radius: 6px;
    background: var(--api-surface);
    padding: 5px 7px;
  }

  .apidbg-meta-label {
    color: var(--api-text-subtle);
    font-size: 9px;
    text-transform: uppercase;
  }

  .apidbg-meta-value {
    margin-top: 2px;
    color: var(--api-text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    font-weight: 700;
  }

  .apidbg-detail-sections {
    display: grid;
    gap: 10px;
    margin-bottom: 10px;
  }

  .apidbg-detail-card {
    border: 1px solid var(--api-border);
    border-radius: 8px;
    background: var(--api-surface);
    padding: 10px 12px;
  }

  .apidbg-detail-card-title {
    color: var(--api-text);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.4px;
    text-transform: uppercase;
  }

  .apidbg-detail-card-body {
    margin-top: 6px;
    color: var(--api-text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .apidbg-detail-topline {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .apidbg-detail-heading {
    color: var(--api-text);
    font-size: 14px;
    font-weight: 800;
  }

  .apidbg-detail-subheading {
    color: var(--api-text-subtle);
    font-size: 11px;
  }

  .apidbg-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(8, 7, 10, 0.74);
    backdrop-filter: blur(3px);
    padding: 22px;
  }

  .apidbg-modal-shell {
    width: min(940px, calc(100vw - 44px));
    max-width: 100%;
  }

  .apidbg-primary-button,
  .apidbg-secondary-button {
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    padding: 5px 12px;
  }

  .apidbg-primary-button {
    border: 0;
    background: var(--api-color-primary);
    color: var(--api-text);
  }

  .apidbg-secondary-button {
    border: 1px solid var(--api-border);
    background: var(--api-surface);
    color: var(--api-text-muted);
  }

  .apidbg-ai-card {
    margin-top: 8px;
    border-left: 3px solid var(--api-color-primary-soft);
    border-radius: 6px;
    background: var(--api-surface);
    padding: 12px;
    animation: apidbg-slide-in-up 0.2s ease-out;
  }

  .apidbg-ai-title {
    gap: 8px;
  }

  .apidbg-ai-text {
    color: var(--api-text-muted);
    font-size: 13px;
    line-height: 1.6;
    margin-top: 8px;
    white-space: pre-wrap;
  }

  .apidbg-ai-section-label {
    display: inline-block;
    color: var(--api-text);
    font-weight: 700;
    margin-bottom: 2px;
  }

  .apidbg-ai-pill {
    margin: 0 2px;
    border-radius: 4px;
    background: rgba(201, 167, 77, 0.18);
    color: var(--api-warning);
    font-size: 11px;
    font-weight: 650;
    padding: 1px 6px;
  }

  .apidbg-ai-footer {
    margin-top: 8px;
  }

  .apidbg-minimised {
    position: fixed;
    z-index: 2147483647;
    gap: 6px;
    border: 1px solid var(--api-border-strong);
    border-radius: 99px;
    background: linear-gradient(145deg, rgba(13, 28, 44, 0.96), rgba(5, 14, 24, 0.98));
    box-shadow: 0 18px 42px rgba(0, 0, 0, 0.46), 0 0 24px rgba(83, 230, 164, 0.07);
    color: var(--api-text);
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    padding: 8px 13px;
    backdrop-filter: blur(18px);
  }

  .apidbg-live-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 99px;
    background: var(--api-text-subtle);
  }

  .apidbg-live-dot.is-capturing {
    background: var(--api-success);
    box-shadow: 0 0 8px var(--api-success);
    animation: apidbg-pulse-glow 2s ease-in-out infinite;
  }

  .apidbg-method {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 58px;
    height: 27px;
    border: 1px solid color-mix(in srgb, var(--method-color) 28%, transparent);
    border-radius: 7px;
    background: var(--method-bg, var(--api-surface-raised));
    color: var(--method-color, var(--api-color-primary-soft));
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.035);
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.3px;
  }

  .apidbg-status {
    display: inline-flex;
    min-width: 42px;
    height: 24px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--badge-border, var(--api-border));
    border-radius: 7px;
    background: var(--badge-bg, rgba(126, 151, 183, 0.08));
    color: var(--badge-color, var(--api-text-muted));
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    font-size: 10px;
    font-weight: 800;
  }

  .apidbg-duration {
    min-width: 54px;
    color: var(--badge-color, var(--api-text-muted));
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    font-size: 10px;
    font-weight: 780;
    text-align: right;
  }

  .apidbg-timing-chip {
    display: inline-flex;
    min-width: 31px;
    height: 22px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--chip-border, var(--api-border));
    border-radius: 7px;
    background: var(--chip-bg, var(--api-surface));
    color: var(--chip-color, var(--api-text-subtle));
    font-size: 9px;
    font-weight: 800;
    line-height: 1;
    padding: 0 6px;
  }

  .apidbg-badge {
    border: 1px solid var(--badge-border, var(--api-border));
    border-radius: 999px;
    background: var(--badge-bg, var(--api-surface));
    color: var(--badge-color, var(--api-text-muted));
    font-size: 7px;
    font-weight: 800;
    letter-spacing: 0.35px;
    line-height: 1.4;
    padding: 1px 5px;
  }

  .apidbg-spinner {
    display: inline-block;
    animation: apidbg-spin 0.9s linear infinite;
  }

  .apidbg-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 40px 16px;
    text-align: center;
  }

  .apidbg-wave {
    color: var(--api-border-strong);
    animation: apidbg-wave-pulse 2s ease-in-out infinite;
  }

  .apidbg-scroll::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  .apidbg-scroll::-webkit-scrollbar-track {
    border-radius: 99px;
    background: rgba(5, 13, 23, 0.6);
  }

  .apidbg-scroll::-webkit-scrollbar-thumb {
    border: 1px solid rgba(5, 13, 23, 0.75);
    background: linear-gradient(180deg, rgba(124, 92, 255, 0.6), rgba(83, 111, 153, 0.6));
    border-radius: 99px;
  }

  .apidbg-scroll::-webkit-scrollbar-thumb:hover {
    background: linear-gradient(180deg, rgba(139, 108, 255, 0.84), rgba(83, 230, 164, 0.55));
  }

  .apidbg-overlay.is-size-medium {
    width: min(430px, calc(100vw - 24px));
    height: min(74vh, 650px);
    min-height: 480px;
    border-radius: 16px;
  }

  .apidbg-overlay.is-size-medium .apidbg-header {
    padding: 12px 12px 10px;
  }

  .apidbg-overlay.is-size-medium .apidbg-brand {
    gap: 8px;
  }

  .apidbg-overlay.is-size-medium .apidbg-brand-mark {
    width: 30px;
    height: 30px;
    border-radius: 9px;
  }

  .apidbg-overlay.is-size-medium .apidbg-brand-mark svg {
    width: 19px;
    height: 19px;
  }

  .apidbg-overlay.is-size-medium .apidbg-title {
    font-size: 14px;
  }

  .apidbg-overlay.is-size-medium .apidbg-title-caption {
    margin-top: 2px;
    font-size: 8px;
  }

  .apidbg-overlay.is-size-medium .apidbg-actions {
    gap: 4px;
    padding: 2px;
    border-radius: 9px;
  }

  .apidbg-overlay.is-size-medium .apidbg-icon-button,
  .apidbg-overlay.is-size-medium .apidbg-header-button {
    height: 26px;
  }

  .apidbg-overlay.is-size-medium .apidbg-icon-button {
    width: 26px;
  }

  .apidbg-overlay.is-size-medium .apidbg-header-button {
    font-size: 10px;
    padding: 0 7px;
  }

  .apidbg-overlay.is-size-medium .apidbg-metrics {
    gap: 6px;
    margin-top: 10px;
  }

  .apidbg-overlay.is-size-medium .apidbg-metric-card {
    min-height: 52px;
    grid-template-columns: 23px minmax(0, 1fr);
    gap: 5px;
    border-radius: 9px;
    padding: 6px;
  }

  .apidbg-overlay.is-size-medium .apidbg-metric-icon {
    width: 23px;
    height: 23px;
    border-radius: 7px;
  }

  .apidbg-overlay.is-size-medium .apidbg-metric-icon svg {
    width: 13px;
    height: 13px;
  }

  .apidbg-overlay.is-size-medium .apidbg-metric-label {
    font-size: 7px;
  }

  .apidbg-overlay.is-size-medium .apidbg-metric-value {
    font-size: 12px;
  }

  .apidbg-overlay.is-size-medium .apidbg-metric-detail {
    margin-top: -7px;
    font-size: 6px;
  }

  .apidbg-overlay.is-size-medium .apidbg-chart-card {
    margin: 0 11px 8px;
    border-radius: 10px;
    padding: 8px 8px 5px;
  }

  .apidbg-overlay.is-size-medium .apidbg-chart-title {
    font-size: 10px;
  }

  .apidbg-overlay.is-size-medium .apidbg-chart-subtitle,
  .apidbg-overlay.is-size-medium .apidbg-chart-count {
    font-size: 7px;
  }

  .apidbg-overlay.is-size-medium .apidbg-sparkline canvas {
    height: 72px;
  }

  .apidbg-overlay.is-size-medium .apidbg-table-shell {
    margin: 0 8px 8px;
    border-radius: 11px;
  }

  .apidbg-overlay.is-size-medium .apidbg-table-head,
  .apidbg-overlay.is-size-medium .apidbg-row {
    grid-template-columns: 54px minmax(0, 1fr) 43px 34px 51px 12px;
    column-gap: 5px;
  }

  .apidbg-overlay.is-size-medium .apidbg-table-head {
    min-height: 31px;
    font-size: 7px;
    padding: 0 8px;
  }

  .apidbg-overlay.is-size-medium .apidbg-list {
    padding: 5px;
  }

  .apidbg-overlay.is-size-medium .apidbg-row-wrap {
    margin-bottom: 4px;
    border-radius: 9px;
  }

  .apidbg-overlay.is-size-medium .apidbg-row {
    min-height: 46px;
    padding: 6px 6px 6px 8px;
  }

  .apidbg-overlay.is-size-medium .apidbg-method {
    width: 51px;
    height: 24px;
    font-size: 9px;
  }

  .apidbg-overlay.is-size-medium .apidbg-path,
  .apidbg-overlay.is-size-medium .apidbg-duration,
  .apidbg-overlay.is-size-medium .apidbg-status {
    font-size: 9px;
  }

  .apidbg-overlay.is-size-medium .apidbg-status {
    min-width: 38px;
    height: 22px;
  }

  .apidbg-overlay.is-size-medium .apidbg-timing-chip {
    min-width: 28px;
    height: 20px;
    font-size: 8px;
  }

  .apidbg-overlay.is-size-medium .apidbg-duration {
    min-width: 49px;
  }

  .apidbg-overlay.is-size-medium .apidbg-badge {
    font-size: 6px;
  }

  .apidbg-overlay.is-size-medium .apidbg-footer {
    min-height: 31px;
    gap: 6px;
    font-size: 8px;
  }

  .apidbg-overlay.is-size-medium .apidbg-detail {
    padding: 10px;
  }

  .apidbg-overlay.is-size-medium .apidbg-json-box {
    height: 120px;
    min-height: 105px;
  }

  .apidbg-overlay.is-size-small {
    width: min(360px, calc(100vw - 16px));
    height: min(66vh, 560px);
    min-height: 430px;
    border-radius: 14px;
  }

  .apidbg-overlay.is-size-small .apidbg-header {
    padding: 9px 9px 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-title-row {
    gap: 6px;
  }

  .apidbg-overlay.is-size-small .apidbg-brand {
    gap: 6px;
  }

  .apidbg-overlay.is-size-small .apidbg-brand-mark {
    width: 27px;
    height: 27px;
    border-radius: 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-brand-mark svg {
    width: 17px;
    height: 17px;
  }

  .apidbg-overlay.is-size-small .apidbg-title {
    font-size: 13px;
  }

  .apidbg-overlay.is-size-small .apidbg-title-caption,
  .apidbg-overlay.is-size-small .apidbg-header-button span {
    display: none;
  }

  .apidbg-overlay.is-size-small .apidbg-live-dot {
    width: 6px;
    height: 6px;
  }

  .apidbg-overlay.is-size-small .apidbg-actions {
    gap: 2px;
    padding: 2px;
    border-radius: 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-icon-button,
  .apidbg-overlay.is-size-small .apidbg-header-button {
    width: 24px;
    height: 24px;
    justify-content: center;
    padding: 0;
  }

  .apidbg-overlay.is-size-small .apidbg-icon-button svg,
  .apidbg-overlay.is-size-small .apidbg-header-button svg {
    width: 12px;
    height: 12px;
  }

  .apidbg-overlay.is-size-small .apidbg-metrics {
    gap: 5px;
    margin-top: 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-metric-card {
    min-height: 43px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 1px;
    border-radius: 8px;
    padding: 5px 3px;
  }

  .apidbg-overlay.is-size-small .apidbg-metric-card::after {
    top: 7px;
    bottom: 7px;
  }

  .apidbg-overlay.is-size-small .apidbg-metric-icon,
  .apidbg-overlay.is-size-small .apidbg-metric-detail {
    display: none;
  }

  .apidbg-overlay.is-size-small .apidbg-metric-label {
    max-width: 100%;
    font-size: 7px;
  }

  .apidbg-overlay.is-size-small .apidbg-metric-value {
    font-size: 11px;
  }

  .apidbg-overlay.is-size-small .apidbg-chart-card {
    margin: 0 8px 7px;
    border-radius: 9px;
    padding: 7px 7px 4px;
  }

  .apidbg-overlay.is-size-small .apidbg-chart-heading {
    padding-bottom: 2px;
  }

  .apidbg-overlay.is-size-small .apidbg-chart-title {
    font-size: 9px;
  }

  .apidbg-overlay.is-size-small .apidbg-chart-subtitle,
  .apidbg-overlay.is-size-small .apidbg-chart-count {
    display: none;
  }

  .apidbg-overlay.is-size-small .apidbg-sparkline canvas {
    height: 58px;
  }

  .apidbg-overlay.is-size-small .apidbg-paused {
    margin: 0 8px 7px;
    font-size: 9px;
    padding: 5px;
  }

  .apidbg-overlay.is-size-small .apidbg-table-shell {
    margin: 0 6px 6px;
    border-radius: 10px;
  }

  .apidbg-overlay.is-size-small .apidbg-table-head,
  .apidbg-overlay.is-size-small .apidbg-row {
    grid-template-columns: 47px minmax(0, 1fr) 37px 29px 45px 10px;
    column-gap: 4px;
  }

  .apidbg-overlay.is-size-small .apidbg-table-head {
    min-height: 28px;
    font-size: 6px;
    letter-spacing: 0.45px;
    padding: 0 6px;
  }

  .apidbg-overlay.is-size-small .apidbg-list {
    padding: 4px;
  }

  .apidbg-overlay.is-size-small .apidbg-row-wrap {
    margin-bottom: 3px;
    border-radius: 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-row {
    min-height: 41px;
    padding: 5px;
  }

  .apidbg-overlay.is-size-small .apidbg-row-wrap::before {
    top: 8px;
    bottom: 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-method {
    width: 44px;
    height: 22px;
    border-radius: 6px;
    font-size: 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-endpoint-cell {
    gap: 2px;
  }

  .apidbg-overlay.is-size-small .apidbg-path {
    font-size: 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-row-flags {
    gap: 2px;
  }

  .apidbg-overlay.is-size-small .apidbg-badge {
    font-size: 5px;
    padding: 1px 3px;
  }

  .apidbg-overlay.is-size-small .apidbg-status {
    min-width: 33px;
    height: 19px;
    border-radius: 6px;
    font-size: 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-timing-chip {
    min-width: 25px;
    height: 18px;
    border-radius: 6px;
    font-size: 7px;
    padding: 0 4px;
  }

  .apidbg-overlay.is-size-small .apidbg-duration {
    min-width: 43px;
    font-size: 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-chevron {
    width: 10px;
    height: 10px;
  }

  .apidbg-overlay.is-size-small .apidbg-footer {
    min-height: 28px;
    gap: 5px;
    font-size: 7px;
  }

  .apidbg-overlay.is-size-small .apidbg-footer-stat {
    display: none;
  }

  .apidbg-overlay.is-size-small .apidbg-detail {
    padding: 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-detail-header {
    gap: 5px;
    margin-bottom: 6px;
  }

  .apidbg-overlay.is-size-small .apidbg-tabs {
    gap: 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-tab,
  .apidbg-overlay.is-size-small .apidbg-plain-button {
    font-size: 9px;
  }

  .apidbg-overlay.is-size-small .apidbg-search {
    width: 82px;
    font-size: 9px;
  }

  .apidbg-overlay.is-size-small .apidbg-meta-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
  }

  .apidbg-overlay.is-size-small .apidbg-meta-cell {
    padding: 4px 6px;
  }

  .apidbg-overlay.is-size-small .apidbg-meta-label {
    font-size: 7px;
  }

  .apidbg-overlay.is-size-small .apidbg-meta-value {
    font-size: 9px;
  }

  .apidbg-overlay.is-size-small .apidbg-json-box {
    height: 105px;
    min-height: 90px;
    padding: 6px;
  }

  .apidbg-overlay.is-size-small .apidbg-json-row {
    font-size: 9px;
  }

  .apidbg-overlay.is-size-small .apidbg-json-footer {
    height: 25px;
    padding: 0 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-json-meta {
    font-size: 8px;
  }

  .apidbg-overlay.is-size-small .apidbg-primary-button,
  .apidbg-overlay.is-size-small .apidbg-secondary-button {
    font-size: 9px;
    padding: 4px 9px;
  }

  .apidbg-overlay.is-size-small .apidbg-ai-card {
    padding: 9px;
  }

  .apidbg-overlay.is-size-small .apidbg-ai-text {
    font-size: 10px;
  }

  @media (max-width: 440px) {
    .apidbg-overlay.is-size-large {
      width: calc(100vw - 16px);
      min-width: 340px;
      height: min(76vh, 680px);
      border-radius: 15px;
    }

    .apidbg-overlay.is-bottom-right,
    .apidbg-minimised.is-bottom-right {
      right: 8px;
      bottom: 8px;
    }

    .apidbg-overlay.is-bottom-left,
    .apidbg-minimised.is-bottom-left {
      left: 8px;
      bottom: 8px;
    }

    .apidbg-overlay.is-top-right,
    .apidbg-minimised.is-top-right {
      top: 8px;
      right: 8px;
    }

    .apidbg-overlay.is-top-left,
    .apidbg-minimised.is-top-left {
      top: 8px;
      left: 8px;
    }

    .apidbg-header {
      padding: 12px 11px 10px;
    }

    .apidbg-title-caption,
    .apidbg-header-button span,
    .apidbg-metric-detail,
    .apidbg-footer-stat {
      display: none;
    }

    .apidbg-header-button {
      width: 28px;
      justify-content: center;
      padding: 0;
    }

    .apidbg-metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      margin-top: 10px;
    }

    .apidbg-metric-card {
      min-height: 50px;
      grid-template-columns: 28px minmax(0, 1fr);
      padding: 7px 8px;
    }

    .apidbg-metric-icon {
      width: 27px;
      height: 27px;
    }

    .apidbg-metric-detail {
      display: block;
    }

    .apidbg-chart-card {
      margin-right: 10px;
      margin-left: 10px;
    }

    .apidbg-table-head,
    .apidbg-row {
      grid-template-columns: 55px minmax(0, 1fr) 43px 34px 52px 12px;
      column-gap: 5px;
    }

    .apidbg-table-head {
      padding: 0 7px;
    }

    .apidbg-row {
      padding-right: 6px;
      padding-left: 7px;
    }

    .apidbg-method {
      width: 52px;
    }

    .apidbg-footer {
      gap: 5px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important;
      transition-duration: 0.001ms !important;
    }
  }
`

function LiveDot({ isCapturing }: { isCapturing: boolean }) {
  return <span className={`apidbg-live-dot${isCapturing ? ' is-capturing' : ''}`} />
}

function BrandMark() {
  return (
    <span className="apidbg-brand-mark" aria-hidden="true">
      <svg viewBox="0 0 28 28" fill="none">
        <path d="M4 14h5l2.2-6 4.2 12 2.4-6H24" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 5h9M6 5V3.5h4V5m-5.5 0 .6 7h5.8l.6-7M6.6 7.2v2.7M9.4 7.2v2.7" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4.5v7M10 4.5v7" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4.5l5 3.5-5 3.5v-7z" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function SidePanelIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="1.5" strokeWidth="1.4" />
      <path d="M9.5 3v10" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function MinimiseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 8h7" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    GET: { bg: 'rgba(203, 184, 255, 0.18)', color: 'var(--api-color-primary-soft)' },
    POST: { bg: 'rgba(143, 230, 188, 0.14)', color: 'var(--api-success)' },
    PUT: { bg: 'rgba(73, 145, 255, 0.14)', color: 'var(--api-info)' },
    PATCH: { bg: 'rgba(255, 177, 51, 0.14)', color: 'var(--api-warning)' },
    DELETE: { bg: 'rgba(255, 143, 143, 0.15)', color: 'var(--api-danger)' },
  }
  const c = colors[method.toUpperCase()] ?? colors.GET

  return (
    <span
      className="apidbg-method"
      style={{ '--method-bg': c.bg, '--method-color': c.color } as React.CSSProperties}
    >
      {method.toUpperCase()}
    </span>
  )
}

function StatusBadge({ status }: { status: number }) {
  const style = status >= 500
    ? {
        '--badge-color': 'var(--api-danger)',
        '--badge-bg': 'rgba(255, 92, 82, 0.11)',
        '--badge-border': 'rgba(255, 120, 111, 0.24)',
      }
    : status >= 400
      ? {
          '--badge-color': 'var(--api-warning)',
          '--badge-bg': 'rgba(255, 177, 51, 0.1)',
          '--badge-border': 'rgba(255, 191, 75, 0.24)',
        }
      : status >= 300
        ? {
            '--badge-color': 'var(--api-info)',
            '--badge-bg': 'rgba(73, 145, 255, 0.1)',
            '--badge-border': 'rgba(101, 168, 255, 0.24)',
          }
        : status >= 200
          ? {
              '--badge-color': 'var(--api-success)',
              '--badge-bg': 'rgba(57, 218, 151, 0.1)',
              '--badge-border': 'rgba(83, 230, 164, 0.22)',
            }
          : {
              '--badge-color': 'var(--api-text-muted)',
              '--badge-bg': 'rgba(126, 151, 183, 0.08)',
              '--badge-border': 'var(--api-border)',
            }

  return <span className="apidbg-status" style={style as React.CSSProperties}>{status || '-'}</span>
}

function latencyColor(ms: number) {
  if (ms < 300) return 'var(--api-success)'
  if (ms <= 800) return 'var(--api-warning)'
  return 'var(--api-danger)'
}

function Duration({ ms }: { ms: number }) {
  const color = latencyColor(ms)
  const display = ms > 999 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`

  return <span className="apidbg-duration" style={{ '--badge-color': color } as React.CSSProperties}>{display}</span>
}

function TimingSourceChip({ source }: { source: RequestEntry['timingSource'] }) {
  const label = source === 'cdp' ? 'CDP' : source === 'performance' ? 'BR' : 'JS'
  const style = source === 'cdp'
    ? {
        '--chip-bg': 'rgba(98, 214, 157, 0.14)',
        '--chip-border': 'rgba(98, 214, 157, 0.4)',
        '--chip-color': '#8fe6bc',
      }
    : source === 'performance'
    ? {
        '--chip-bg': 'rgba(77, 163, 255, 0.14)',
        '--chip-border': 'rgba(77, 163, 255, 0.4)',
        '--chip-color': '#89c2ff',
      }
    : {
        '--chip-bg': 'rgba(201, 167, 77, 0.16)',
        '--chip-border': 'rgba(201, 167, 77, 0.38)',
        '--chip-color': 'var(--api-warning)',
      }

  return (
    <span
      className="apidbg-timing-chip"
      style={style as React.CSSProperties}
      title={source === 'cdp' ? 'Chrome DevTools Protocol timing' : source === 'performance' ? 'Browser timing' : 'JavaScript proxy timing'}
    >
      {label}
    </span>
  )
}

function DupBadge({ count }: { count: number }) {
  return (
    <span
      className="apidbg-badge"
      style={{
        '--badge-bg': 'rgba(201, 167, 77, 0.18)',
        '--badge-border': 'rgba(201, 167, 77, 0.45)',
        '--badge-color': 'var(--api-warning)',
      } as React.CSSProperties}
      title={`${count} matching requests in this session`}
    >
      DUP x{count}
    </span>
  )
}

function SlowBadge() {
  return (
    <span
      className="apidbg-badge"
      style={{
        '--badge-bg': 'var(--api-danger-bg)',
        '--badge-border': 'rgba(255, 143, 143, 0.45)',
        '--badge-color': 'var(--api-danger)',
      } as React.CSSProperties}
    >
      SLOW
    </span>
  )
}

function LargePayloadBadge({ size }: { size: number }) {
  return (
    <span
      className="apidbg-badge"
      style={{
        '--badge-bg': 'rgba(201, 167, 77, 0.18)',
        '--badge-border': 'rgba(201, 167, 77, 0.45)',
        '--badge-color': 'var(--api-warning)',
      } as React.CSSProperties}
      title={`Large response payload: ${formatBytes(size)}`}
    >
      LARGE
    </span>
  )
}

function SpinnerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="apidbg-spinner">
      <circle cx="12" cy="12" r="9" stroke="var(--api-color-primary-soft)" strokeWidth="2.5" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="var(--api-color-primary-soft)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone: 'purple' | 'green' | 'danger' | 'amber'
}) {
  return (
    <div className={`apidbg-metric-card is-${tone}`}>
      <div className="apidbg-metric-icon" aria-hidden="true">
        {label === 'Total calls' && (
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M6.5 4.5c-2 1.2-2.8 3.8-1.6 5.8 1.7 2.8 4 5.1 6.8 6.8 2 1.2 4.6.4 5.8-1.6l.6-1c.3-.6.2-1.3-.4-1.7l-2.3-1.5c-.5-.3-1.2-.2-1.6.2l-.8.9a11 11 0 0 1-5.4-5.4l.9-.8c.4-.4.5-1.1.2-1.6L7.2 2.3C6.8 1.7 6.1 1.6 5.5 2l-1 .6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {label === 'Avg response' && (
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M3 14.5h3.2l2.2-4 2.7 2.1 2.3-5.1 3.6-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M14.2 5.5H17v2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {label === 'Errors' && (
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M10 3.1 17 16H3L10 3.1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M10 7.5v4M10 14h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        )}
        {label === 'Duplicates' && (
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M6.2 6.2h7.6v7.6H6.2z" stroke="currentColor" strokeWidth="1.35" />
            <path d="M3.5 10A6.5 6.5 0 0 1 10 3.5M16.5 10A6.5 6.5 0 0 1 10 16.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
          </svg>
        )}
      </div>
      <div className="apidbg-metric-copy">
        <span className="apidbg-metric-label">{label}</span>
        <span className="apidbg-metric-value">{value}</span>
      </div>
      <span className="apidbg-metric-detail">{detail}</span>
    </div>
  )
}

function escapeJsonPathKey(key: string) {
  return key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function appendJsonPath(parentPath: string, key: string, parentIsArray: boolean) {
  if (parentIsArray) return `${parentPath}[${key}]`
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return `${parentPath}.${key}`
  return `${parentPath}["${escapeJsonPathKey(key)}"]`
}

function stringifyJsonValue(value: unknown) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'

  return JSON.stringify(value, null, 2)
}

function JsonPathCopyButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      className={`apidbg-json-copy${copied ? ' is-copied' : ''}`}
      title={`Copy path: ${path}`}
      aria-label={`Copy JSON path ${path}`}
      onClick={event => {
        event.stopPropagation()
        navigator.clipboard?.writeText(path)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? 'Copied' : 'Path'}
    </button>
  )
}

function JsonNode({
  k,
  value,
  depth,
  search,
  forceExpand,
  path,
}: {
  k?: string
  value: unknown
  depth: number
  search: string
  forceExpand: JsonExpandMode
  path: string
}) {
  const [open, setOpen] = useState(depth < 2)
  const isOpen = forceExpand === 'all' ? true : forceExpand === 'none' ? false : open

  const isObj = value && typeof value === 'object' && !Array.isArray(value)
  const isArr = Array.isArray(value)
  const valueText = stringifyJsonValue(value)
  const normalizedSearch = search.trim().toLowerCase()
  const matches = Boolean(
    normalizedSearch &&
    (
      k?.toLowerCase().includes(normalizedSearch) ||
      path.toLowerCase().includes(normalizedSearch) ||
      (typeof valueText === 'string' && valueText.toLowerCase().includes(normalizedSearch))
    ),
  )
  const dim = normalizedSearch && !matches ? 0.35 : 1
  const indent = depth * 16

  if (isObj || isArr) {
    const obj = value as Record<string, unknown> | unknown[]
    const entries = isArr
      ? (obj as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
      : Object.entries(obj as Record<string, unknown>)
    const count = entries.length

    return (
      <div style={{ opacity: dim, paddingLeft: depth === 0 ? 0 : 12, borderLeft: depth === 0 ? 'none' : '1px solid var(--api-border)' }}>
        <div
          className="apidbg-json-row"
          role="treeitem"
          tabIndex={0}
          aria-expanded={isOpen}
          aria-label={`${path}, ${isArr ? 'array' : 'object'}, ${count} ${isArr ? 'items' : 'keys'}`}
          onClick={() => setOpen(o => !o)}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setOpen(o => !o)
            }
            if (event.key === 'ArrowRight' && !isOpen) {
              event.preventDefault()
              setOpen(true)
            }
            if (event.key === 'ArrowLeft' && isOpen) {
              event.preventDefault()
              setOpen(false)
            }
          }}
          style={{ cursor: 'pointer', paddingLeft: indent }}
        >
          <span style={{ display: 'inline-block', width: 10, color: 'var(--api-text-subtle)', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', fontSize: 10 }}>
            {'>'}
          </span>
          {k !== undefined && (
            <span className={`apidbg-json-key${matches ? ' is-match' : ''}`}>
              "{k}"
            </span>
          )}
          {k !== undefined && <span className="apidbg-json-punct">:</span>}
          {!isOpen && (
            <span className="apidbg-json-preview">
              {isArr ? `[...] ${count} items` : `{...} ${count} keys`}
            </span>
          )}
          {isOpen && <span className="apidbg-json-punct">{isArr ? '[' : '{'}</span>}
          <span className="apidbg-json-path" title={path}>{path}</span>
          <JsonPathCopyButton path={path} />
        </div>
        {isOpen && (
          <div role="group">
            {entries.map(([ck, cv]) => (
              <JsonNode
                key={ck}
                k={ck}
                value={cv}
                depth={depth + 1}
                search={search}
                forceExpand={forceExpand}
                path={appendJsonPath(path, ck, isArr)}
              />
            ))}
            <div style={{ paddingLeft: indent + 14, color: 'var(--api-text-subtle)', fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
              {isArr ? ']' : '}'}
            </div>
          </div>
        )}
      </div>
    )
  }

  const valueType = value === null ? 'null' : typeof value
  const valueClass = `apidbg-json-value-${valueType}`

  return (
    <div
      className="apidbg-json-row"
      role="treeitem"
      tabIndex={0}
      aria-label={`${path}, ${valueType}, ${valueText}`}
      style={{ opacity: dim, paddingLeft: indent + 14 }}
    >
      {k !== undefined && (
        <>
          <span className={`apidbg-json-key${matches ? ' is-match' : ''}`}>
            "{k}"
          </span>
          <span className="apidbg-json-punct">:</span>
        </>
      )}
      <span className={valueClass}>{valueText}</span>
      <span className="apidbg-json-path" title={path}>{path}</span>
      <JsonPathCopyButton path={path} />
    </div>
  )
}

function countKeys(v: unknown, depth = 0): number {
  if (depth > 8) return 0
  if (Array.isArray(v)) return v.reduce((a: number, x) => a + countKeys(x, depth + 1), 0)
  if (v && typeof v === 'object') {
    return Object.keys(v).length + Object.values(v).reduce((a: number, x) => a + countKeys(x, depth + 1), 0)
  }
  return 0
}

function parseBody(body: string | null): unknown {
  if (!body) return null

  try {
    return JSON.parse(body)
  } catch {
    return { body }
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function getPath(url: string) {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}

function formatTimingSourceLabel(source: RequestEntry['timingSource']) {
  return source === 'cdp' ? 'CDP' : source === 'performance' ? 'Browser' : 'Proxy'
}

function Sparkline({
  requests,
  overlaySize,
}: {
  requests: RequestEntry[]
  overlaySize: ApiDebuggerSettings['overlaySize']
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<{ x: number; y: number; r: RequestEntry } | null>(null)

  useEffect(() => {
    const c = ref.current
    if (!c) return

    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth
    const h = c.clientHeight
    c.width = w * dpr
    c.height = h * dpr

    const ctx = c.getContext('2d')
    if (!ctx) return

    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    if (requests.length < 2) return

    const styles = getComputedStyle(c)
    const lineColor = styles.getPropertyValue('--api-chart-line').trim() || '#8b6cff'
    const slowColor = styles.getPropertyValue('--api-danger').trim() || '#ff8f8f'
    const gridColor = styles.getPropertyValue('--api-chart-grid').trim() || 'rgba(130, 153, 183, 0.12)'
    const labelColor = styles.getPropertyValue('--api-text-subtle').trim() || '#718096'
    const max = Math.max(...requests.map(r => r.duration), 100)
    const chartMax = Math.max(100, Math.ceil(max / 100) * 100)
    const padding = { top: 12, right: 10, bottom: 12, left: 38 }
    const chartWidth = Math.max(1, w - padding.left - padding.right)
    const chartHeight = Math.max(1, h - padding.top - padding.bottom)
    const points = requests.map((r, i) => ({
      x: padding.left + (i / (requests.length - 1)) * chartWidth,
      y: padding.top + chartHeight - (r.duration / chartMax) * chartHeight,
      r,
    }))

    ctx.font = '10px Inter, ui-sans-serif, system-ui'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ;[0, 0.5, 1].forEach(step => {
      const y = padding.top + chartHeight - step * chartHeight
      ctx.beginPath()
      ctx.strokeStyle = gridColor
      ctx.lineWidth = 1
      ctx.setLineDash(step === 0 ? [] : [3, 5])
      ctx.moveTo(padding.left, y)
      ctx.lineTo(w - padding.right, y)
      ctx.stroke()
      ctx.fillStyle = labelColor
      ctx.fillText(`${Math.round(chartMax * step)}ms`, padding.left - 7, y)
    })
    ctx.setLineDash([])

    const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom)
    gradient.addColorStop(0, 'rgba(139, 108, 255, 0.3)')
    gradient.addColorStop(1, 'rgba(139, 108, 255, 0)')
    ctx.beginPath()
    ctx.moveTo(points[0].x, h - padding.bottom)
    ctx.lineTo(points[0].x, points[0].y)
    points.slice(1).forEach((point, index) => {
      const previous = points[index]
      const midpoint = (previous.x + point.x) / 2
      ctx.bezierCurveTo(midpoint, previous.y, midpoint, point.y, point.x, point.y)
    })
    ctx.lineTo(points[points.length - 1].x, h - padding.bottom)
    ctx.closePath()
    ctx.fillStyle = gradient
    ctx.fill()

    ctx.shadowColor = lineColor
    ctx.shadowBlur = 8
    ctx.strokeStyle = lineColor
    ctx.lineWidth = 2.2
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    points.slice(1).forEach((point, index) => {
      const previous = points[index]
      const midpoint = (previous.x + point.x) / 2
      ctx.bezierCurveTo(midpoint, previous.y, midpoint, point.y, point.x, point.y)
    })
    ctx.stroke()
    ctx.shadowBlur = 0

    points.forEach(p => {
      ctx.beginPath()
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#f6f2ff'
      ctx.fill()
      ctx.lineWidth = 2.5
      ctx.strokeStyle = p.r.isSlow ? slowColor : lineColor
      ctx.stroke()
    })
  }, [overlaySize, requests])

  return (
    <div className="apidbg-chart-card">
      <div className="apidbg-chart-heading">
        <div>
          <span className="apidbg-chart-title">Response timeline</span>
          <span className="apidbg-chart-subtitle">Latency across captured calls</span>
        </div>
        <span className="apidbg-chart-count">{requests.length} points</span>
      </div>
      <div className="apidbg-sparkline">
        <canvas
          ref={ref}
          onMouseMove={event => {
            const rect = event.currentTarget.getBoundingClientRect()
            const x = event.clientX - rect.left
            const chartX = Math.max(0, x - 38)
            const chartWidth = Math.max(1, rect.width - 48)
            const idx = Math.round((chartX / chartWidth) * (requests.length - 1))
            const r = requests[Math.max(0, Math.min(requests.length - 1, idx))]
            if (r) setHover({ x: event.clientX, y: event.clientY, r })
          }}
          onMouseLeave={() => setHover(null)}
        />
      </div>
      {hover && (
        <div className="apidbg-tooltip" style={{ top: hover.y - 36, left: hover.x + 8 }}>
          {getPath(hover.r.url)} - {Math.round(hover.r.duration)}ms
        </div>
      )}
    </div>
  )
}

function AICard({
  state,
  text,
  error,
  url,
  onDismiss,
}: {
  state: AISuggestionState
  text?: string
  error?: string
  url: string
  onDismiss: () => void
}) {
  if (state === 'idle') return null

  if (state === 'loading') {
    return (
      <div className="apidbg-ai-card">
        <div className="apidbg-ai-title">
          <SpinnerIcon />
          <span style={{ color: 'var(--api-text-muted)', fontSize: 13 }}>Analysing request...</span>
        </div>
        <div style={{ height: 10, width: '90%', borderRadius: 4, marginTop: 10, background: 'var(--api-surface-raised)' }} />
        <div style={{ height: 10, width: '72%', borderRadius: 4, marginTop: 6, background: 'var(--api-surface-raised)' }} />
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="apidbg-ai-card">
        <div className="apidbg-ai-title">
          <span style={{ color: 'var(--api-danger)', fontSize: 14 }}>!</span>
          <span style={{ color: 'var(--api-text)', fontSize: 13, fontWeight: 700 }}>AI Diagnosis</span>
          <span title={url} style={{ marginLeft: 'auto', color: 'var(--api-text-subtle)', fontSize: 11, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
        </div>
        <div className="apidbg-ai-text">{error ?? 'Unknown error. Check your API key.'}</div>
        <div className="apidbg-ai-footer">
          <button className="apidbg-plain-button" onClick={onDismiss} style={{ marginLeft: 'auto' }}>Dismiss</button>
        </div>
      </div>
    )
  }

  const formatAiText = (value: string) => {
    const lines = value.split('\n')
    const labels = new Set(['General info:', 'Output:', 'Solution to issue:'])

    return lines.map((line, index) => {
      const trimmedLine = line.trim()
      if (labels.has(trimmedLine)) {
        return (
          <React.Fragment key={`label-${index}`}>
            {index > 0 ? '\n' : null}
            <span className="apidbg-ai-section-label">{trimmedLine}</span>
            {'\n'}
          </React.Fragment>
        )
      }

      return (
        <React.Fragment key={`line-${index}`}>
          {line}
          {index < lines.length - 1 ? '\n' : null}
        </React.Fragment>
      )
    })
  }

  const patterns = ['N+1', 'over-fetching', 'waterfall', 'pagination']
  let parts: React.ReactNode[] = [formatAiText(text ?? 'General info:\nNo details available.\n\nOutput:\nNo output returned.\n\nSolution to issue:\nNo suggestion returned.')]

  patterns.forEach(pattern => {
    parts = parts.flatMap(part => {
      if (typeof part !== 'string') return [part]
      return part.split(new RegExp(`(${pattern})`, 'i')).map((segment, index) => (
        segment.toLowerCase() === pattern.toLowerCase()
          ? <span key={`${pattern}-${index}`} className="apidbg-ai-pill">{segment}</span>
          : segment
      ))
    })
  })

  return (
    <div className="apidbg-ai-card">
      <div className="apidbg-ai-title">
        <span style={{ color: 'var(--api-color-primary-soft)', fontSize: 14 }}>*</span>
        <span style={{ color: 'var(--api-text)', fontSize: 13, fontWeight: 700 }}>AI Diagnosis</span>
        <span title={url} style={{ marginLeft: 'auto', color: 'var(--api-text-subtle)', fontSize: 11, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
      </div>
      <div className="apidbg-ai-text">{parts}</div>
      <div className="apidbg-ai-footer">
        <span style={{ color: 'var(--api-text-subtle)', fontSize: 11 }}>Generated just now</span>
        <button className="apidbg-plain-button" onClick={onDismiss} style={{ marginLeft: 'auto' }}>Dismiss</button>
      </div>
    </div>
  )
}

function RequestRow({ req }: { req: RequestEntry }) {
  const settings = useSettings()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<JsonTab>('response')
  const [search, setSearch] = useState('')
  const [forceExpand, setForceExpand] = useState<JsonExpandMode>(null)
  const [aiState, setAiState] = useState<AISuggestionState>('idle')
  const [aiSuggestion, setAiSuggestion] = useState('')
  const [aiError, setAiError] = useState('')
  const [copied, setCopied] = useState(false)

  const path = useMemo(() => getPath(req.url), [req.url])
  const parsedBody = useMemo(() => parseBody(req.responseBody), [req.responseBody])
  const requestObj = useMemo(() => ({
    method: req.method,
    url: req.url,
    headers: req.requestHeaders,
    body: req.requestBody,
    requestSize: req.requestSize,
    fingerprint: req.fingerprint,
    duplicateOf: req.duplicateOf,
    duplicateCount: req.duplicateCount,
  }), [req])

  const jsonValue = tab === 'response' ? parsedBody ?? { body: null } : requestObj
  const isLargePayload = req.responseSize > settings.largePayloadThresholdKb * 1024

  const copyJson = () => {
    navigator.clipboard?.writeText(
      tab === 'response'
        ? (req.responseBody ?? JSON.stringify(jsonValue, null, 2))
        : JSON.stringify(requestObj, null, 2),
    )
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const replayRequest = () => {
    void sendRuntimeMessage({
      type: 'SELECT_REPLAY',
      payload: {
        id: req.id,
        method: req.method,
        url: req.url,
        headers: req.requestHeaders,
        body: req.requestBody,
        originalResponseBody: req.responseBody,
      },
    })
  }

  const triggerAI = async () => {
    setAiState('loading')
    setAiError('')

    try {
      const response = await sendRuntimeMessage({
        type: 'ASK_AI_SUGGESTION',
        payload: {
          id: req.id,
          method: req.method,
          url: req.url,
          status: req.status,
          duration: req.duration,
          ttfb: req.ttfb,
          responseSize: req.responseSize,
          isSlow: req.isSlow,
          isDuplicate: req.isDuplicate,
          duplicateCount: req.duplicateCount,
          dependsOnCount: req.dependsOn.length,
        },
      }) as AISuggestionResponse | undefined

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Unable to ask AI. Check the extension service worker.')
      }

      setAiSuggestion(response.suggestion ?? 'No suggestion returned.')
      setAiState('result')
    } catch (err: unknown) {
      setAiState('error')
      setAiError(err instanceof Error ? err.message : 'Unknown error. Check your API key.')
    }
  }

  return (
    <div
      className={`apidbg-row-wrap${req.duplicateCount > 1 ? ' has-duplicates' : ''}`}
      data-method={req.method.toLowerCase()}
    >
      <div
        className="apidbg-row"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${req.method} ${path}, status ${req.status || 'unknown'}, ${Math.round(req.duration)} milliseconds`}
        onClick={() => setOpen(o => !o)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(o => !o)
          }
        }}
      >
        <MethodBadge method={req.method} />
        <span className="apidbg-endpoint-cell">
          <span className="apidbg-path" title={req.url}>{path}</span>
          {(req.duplicateCount > 1 || req.isSlow || isLargePayload) && (
            <span className="apidbg-row-flags">
              {req.duplicateCount > 1 && <DupBadge count={req.duplicateCount} />}
              {req.isSlow && <SlowBadge />}
              {isLargePayload && <LargePayloadBadge size={req.responseSize} />}
            </span>
          )}
        </span>
        <StatusBadge status={req.status} />
        <TimingSourceChip source={req.timingSource} />
        <Duration ms={req.duration} />
        <svg
          className={`apidbg-chevron${open ? ' is-open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 4L6 8L10 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {open && (
        <div className="apidbg-detail">
          <div className="apidbg-detail-header">
            <div className="apidbg-tabs">
              {(['response', 'request'] as const).map(t => (
                <button
                  key={t}
                  className={`apidbg-tab${tab === t ? ' is-active' : ''}`}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="apidbg-row-tools">
              <input
                className="apidbg-search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search keys..."
              />
              <button
                className="apidbg-plain-button"
                onClick={() => setForceExpand(forceExpand === 'all' ? 'none' : 'all')}
              >
                {forceExpand === 'all' ? 'Collapse all' : 'Expand all'}
              </button>
            </div>
          </div>

          <div className="apidbg-meta-grid">
            <div className="apidbg-meta-cell">
              <div className="apidbg-meta-label">Duration</div>
              <div className="apidbg-meta-value">{req.duration > 0 ? `${req.duration}ms` : '-'}</div>
            </div>
            <div className="apidbg-meta-cell">
              <div className="apidbg-meta-label">TTFB</div>
              <div className="apidbg-meta-value">{req.ttfb > 0 ? `${req.ttfb}ms` : '-'}</div>
            </div>
            <div className="apidbg-meta-cell">
              <div className="apidbg-meta-label">Timing</div>
              <div className="apidbg-meta-value">{formatTimingSourceLabel(req.timingSource)}</div>
            </div>
            <div className="apidbg-meta-cell">
              <div className="apidbg-meta-label">Request</div>
              <div className="apidbg-meta-value">{formatBytes(req.requestSize)}</div>
            </div>
            <div className="apidbg-meta-cell">
              <div className="apidbg-meta-label">Response</div>
              <div className="apidbg-meta-value">{formatBytes(req.responseSize)}</div>
            </div>
            <div className="apidbg-meta-cell">
              <div className="apidbg-meta-label">Transfer</div>
              <div className="apidbg-meta-value">{formatBytes(req.transferSize)}</div>
            </div>
            {isLargePayload && (
              <div className="apidbg-meta-cell">
                <div className="apidbg-meta-label">Payload Limit</div>
                <div className="apidbg-meta-value">{formatBytes(settings.largePayloadThresholdKb * 1024)}</div>
              </div>
            )}
            {req.duplicateCount > 1 && (
              <div className="apidbg-meta-cell">
                <div className="apidbg-meta-label">Duplicate Group</div>
                <div className="apidbg-meta-value">{req.duplicateCount} calls</div>
              </div>
            )}
          </div>

          <div
            className="apidbg-json-box apidbg-scroll"
            role="tree"
            aria-label={`${tab === 'response' ? 'Response' : 'Request'} JSON tree`}
          >
            <JsonNode
              value={jsonValue}
              depth={0}
              search={search}
              forceExpand={forceExpand}
              path={tab}
            />
          </div>

          <div className="apidbg-json-footer">
            <span className="apidbg-json-meta">
              {formatBytes(tab === 'response' ? req.responseSize : req.requestSize)} - {countKeys(jsonValue)} keys
            </span>
            <button
              className="apidbg-plain-button"
              onClick={copyJson}
              style={{ color: copied ? 'var(--api-success)' : 'var(--api-color-primary-soft)' }}
            >
              {copied ? 'Copied' : 'Copy JSON'}
            </button>
          </div>

          <div className="apidbg-detail-actions">
            <button className="apidbg-primary-button" onClick={triggerAI}>Ask AI</button>
            <button className="apidbg-secondary-button" onClick={replayRequest}>Replay</button>
          </div>

          <AICard
            state={aiState}
            url={path}
            text={aiSuggestion || req.aiSuggestion || 'No suggestion returned.'}
            error={aiError}
            onDismiss={() => setAiState('idle')}
          />
        </div>
      )}
    </div>
  )
}

function EmptyFeed() {
  return (
    <div className="apidbg-empty">
      <svg width="40" height="40" viewBox="0 0 40 40" className="apidbg-wave">
        <path d="M2 20 Q 10 8 18 20 T 34 20" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
        <path d="M2 26 Q 10 14 18 26 T 34 26" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.5" />
      </svg>
      <div style={{ color: 'var(--api-text-subtle)', fontSize: 13, fontWeight: 600 }}>Waiting for requests</div>
      <div style={{ color: 'var(--api-border-strong)', fontSize: 12 }}>Navigate or interact with the page</div>
    </div>
  )
}

class OverlayErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 12, color: '#F87171', fontSize: 12 }}>
          Overlay error - reload the page to reset.
        </div>
      )
    }

    return this.props.children
  }
}

function positionClass(position: ApiDebuggerSettings['overlayPosition']) {
  return `is-${position.toLowerCase().replaceAll(' ', '-')}`
}

function sizeClass(size: ApiDebuggerSettings['overlaySize']) {
  return `is-size-${size.toLowerCase()}`
}

function getInitialOverlayState(settings: ApiDebuggerSettings, initialPaused: boolean): OverlayState {
  if (!settings.captureEnabled) return 'hidden'
  if (!settings.showOverlayOnLoad) return 'minimised'
  if (initialPaused) return 'paused'
  return 'feed'
}

export function Overlay({ initialPaused }: { initialPaused: boolean }) {
  const settings = useSettings()
  const updateSettings = useUpdateSettings()
  const [requests, setRequests] = useState<RequestEntry[]>([])
  const [state, setState] = useState<OverlayState>(() => getInitialOverlayState(settings, initialPaused))
  const [sweep, setSweep] = useState(false)
  const effectiveState: OverlayState = !settings.captureEnabled
    ? 'hidden'
    : (state === 'hidden' ? getInitialOverlayState({ ...settings, captureEnabled: true }, initialPaused) : state)
  const stateRef = useRef<OverlayState>(state)
  const pausedRef = useRef(initialPaused)
  const bufferedRequestsRef = useRef<RequestEntry[]>([])

  const upsertRequest = (currentRequests: RequestEntry[], nextRequest: RequestEntry) => {
    const existingIndex = currentRequests.findIndex(request => request.id === nextRequest.id)
    if (existingIndex === -1) {
      return [nextRequest, ...currentRequests].slice(0, 100)
    }

    const nextRequests = [...currentRequests]
    nextRequests[existingIndex] = nextRequest
    return nextRequests
  }

  const upsertBufferedRequest = (nextRequest: RequestEntry) => {
    const currentBuffered = bufferedRequestsRef.current
    const existingIndex = currentBuffered.findIndex(request => request.id === nextRequest.id)

    if (existingIndex === -1) {
      bufferedRequestsRef.current = [nextRequest, ...currentBuffered].slice(0, 100)
    } else {
      const nextBuffered = [...currentBuffered]
      nextBuffered[existingIndex] = nextRequest
      bufferedRequestsRef.current = nextBuffered
    }

  }

  useEffect(() => {
    const handler = (msg: unknown) => {
      if (isRequestCompleteMessage(msg)) {
        if (stateRef.current === 'paused') {
          upsertBufferedRequest(msg.payload)
          return
        }
        setRequests(prev => upsertRequest(prev, msg.payload))
      }
      if (isRequestUpdatedMessage(msg)) {
        if (stateRef.current === 'paused') {
          upsertBufferedRequest(msg.payload)
          return
        }
        setRequests(prev => upsertRequest(prev, msg.payload))
      }
    }
    try {
      if (!chrome.runtime?.id) return

      chrome.runtime.onMessage.addListener(handler)
      return () => {
        try {
          chrome.runtime.onMessage.removeListener(handler)
        } catch {
          // Extension context may be unavailable after a reload.
        }
      }
    } catch {
      return
    }
  }, [])

  useEffect(() => {
    stateRef.current = effectiveState

    if (effectiveState !== 'feed' || bufferedRequestsRef.current.length === 0) {
      return
    }

    setRequests(currentRequests => (
      bufferedRequestsRef.current.reduce(
        (nextRequests, bufferedRequest) => upsertRequest(nextRequests, bufferedRequest),
        currentRequests,
      )
    ))
    bufferedRequestsRef.current = []
  }, [effectiveState])

  const total = requests.length
  const avg = total ? Math.round(requests.reduce((sum, r) => sum + r.duration, 0) / total) : 0
  const errors = requests.filter(r => r.status >= 400).length
  const errorRate = total ? Math.round((errors / total) * 1000) / 10 : 0
  const dupes = requests.filter(r => r.isDuplicate).length
  const isCapturing = effectiveState !== 'paused'
  const showSparkline = requests.length >= 3
  const overlayPositionClass = positionClass(settings.overlayPosition)
  const overlaySizeClass = sizeClass(settings.overlaySize)

  const openSidePanel = () => {
    void sendRuntimeMessage({ type: 'OPEN_SIDE_PANEL' })
  }

  const clearSession = () => {
    setSweep(true)
    window.setTimeout(() => {
      setRequests([])
      bufferedRequestsRef.current = []
      void sendRuntimeMessage({ type: 'CLEAR_SESSION' })
      setSweep(false)
    }, 300)
  }

  const expandOverlay = () => {
    setState(pausedRef.current ? 'paused' : 'feed')
    persistShowOnLoad(true)
  }

  const persistShowOnLoad = (showOverlayOnLoad: boolean) => {
    const nextSettings = {
      ...settings,
      showOverlayOnLoad,
    }

    updateSettings(nextSettings)
    void saveSettings(nextSettings).catch(() => {
      // Ignore transient extension storage errors during reloads.
    })
  }

  const setPausedState = (paused: boolean) => {
    pausedRef.current = paused
    setState(paused ? 'paused' : 'feed')
    void sendRuntimeMessage({
      type: 'SET_OVERLAY_PAUSED',
      payload: { paused },
    })
  }

  if (effectiveState === 'hidden') {
    return null
  }

  if (effectiveState === 'minimised') {
    return (
      <>
        <style>{overlayThemeCss}</style>
        <button
          className={`apidbg-minimised ${overlayPositionClass} ${overlaySizeClass}`}
          onClick={expandOverlay}
        >
          <LiveDot isCapturing />
          <span>API</span>
          <span style={{ color: 'var(--api-text-subtle)', fontSize: 10 }}>^</span>
        </button>
      </>
    )
  }

  return (
    <>
      <style>{overlayThemeCss}</style>
      <div className={`apidbg-overlay ${overlayPositionClass} ${overlaySizeClass}`}>
        <div className="apidbg-header">
          <div className="apidbg-title-row">
            <div className="apidbg-brand">
              <BrandMark />
              <div className="apidbg-title">
                <span>API Debugger</span>
                <span className="apidbg-title-caption">Live network intelligence</span>
              </div>
              <LiveDot isCapturing={isCapturing} />
            </div>
            <div className="apidbg-actions">
              {requests.length > 0 && (
                <button
                  className="apidbg-header-button"
                  onClick={clearSession}
                  aria-label="Clear session"
                  title="Clear"
                >
                  <TrashIcon />
                  <span>Clear</span>
                </button>
              )}
              <button
                className="apidbg-icon-button"
                onClick={() => setPausedState(isCapturing)}
                aria-label={isCapturing ? 'Pause capture' : 'Resume capture'}
                title={isCapturing ? 'Pause' : 'Resume'}
              >
                {isCapturing ? <PauseIcon /> : <PlayIcon />}
              </button>
              <button
                className="apidbg-icon-button"
                onClick={openSidePanel}
                aria-label="Open side panel"
                title="Open side panel"
              >
                <SidePanelIcon />
              </button>
                <button
                  className="apidbg-icon-button"
                  onClick={() => {
                    setState('minimised')
                    persistShowOnLoad(false)
                  }}
                  aria-label="Minimise overlay"
                  title="Minimise"
                >
                <MinimiseIcon />
              </button>
            </div>
          </div>

          <div className="apidbg-metrics">
            <MetricCard label="Total calls" value={String(total)} detail="captured" tone="purple" />
            <MetricCard
              label="Avg response"
              value={`${avg}ms`}
              detail={avg < 300 ? 'healthy' : avg <= 800 ? 'moderate' : 'slow'}
              tone={avg < 300 ? 'green' : avg <= 800 ? 'amber' : 'danger'}
            />
            <MetricCard label="Errors" value={String(errors)} detail={`${errorRate}% rate`} tone={errors > 0 ? 'danger' : 'green'} />
            <MetricCard label="Duplicates" value={String(dupes)} detail="matching calls" tone={dupes > 0 ? 'amber' : 'purple'} />
          </div>
        </div>

        {showSparkline && <Sparkline requests={requests} overlaySize={settings.overlaySize} />}

        {effectiveState === 'paused' && (
          <div className="apidbg-paused">
            <span>Capture paused - new requests are ignored</span>
            <button className="apidbg-link-button" onClick={() => setPausedState(false)}>Resume</button>
          </div>
        )}

        <div className="apidbg-table-shell">
          <div className="apidbg-table-head" aria-hidden="true">
            <span>Method</span>
            <span>Endpoint</span>
            <span>Status</span>
            <span>Region</span>
            <span>Time</span>
            <span />
          </div>
          <OverlayErrorBoundary>
            <div className={`apidbg-list apidbg-scroll${effectiveState === 'paused' ? ' is-paused' : ''}`}>
              {sweep && <div className="apidbg-sweep" />}
              {requests.length === 0 ? <EmptyFeed /> : requests.map(r => <RequestRow key={r.id} req={r} />)}
            </div>
          </OverlayErrorBoundary>
          <div className="apidbg-footer">
            <span className="apidbg-footer-live">
              <LiveDot isCapturing={isCapturing} />
              {isCapturing ? 'Live' : 'Paused'}
            </span>
            <span className="apidbg-footer-divider" />
            <span>{total} calls captured</span>
            <span className="apidbg-footer-stat is-error">{errors} errors</span>
            <span className="apidbg-footer-stat is-duplicate">{dupes} duplicates</span>
          </div>
        </div>
      </div>
    </>
  )
}

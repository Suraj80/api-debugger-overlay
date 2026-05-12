/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState } from 'react'
import type { ApiDebuggerSettings } from './settings'

interface SettingsContextValue {
  settings: ApiDebuggerSettings
  updateSettings: (s: ApiDebuggerSettings) => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({
  initialSettings,
  children,
}: {
  initialSettings: ApiDebuggerSettings
  children: React.ReactNode
}) {
  const [settings, setSettings] = useState(initialSettings)

  return (
    <SettingsContext.Provider value={{ settings, updateSettings: setSettings }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings(): ApiDebuggerSettings {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider')
  return ctx.settings
}

export function useUpdateSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useUpdateSettings must be used inside SettingsProvider')
  return ctx.updateSettings
}

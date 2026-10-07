import { useState } from 'react'

export function readPreference<T>(key: string, fallback: T, validate: (value: unknown) => value is T): T {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null')
    return validate(value) ? value : fallback
  } catch { return fallback }
}

export function usePreference<T>(key: string, fallback: T, validate: (value: unknown) => value is T): [T, (value: T) => void] {
  const [value, setValue] = useState(() => readPreference(key, fallback, validate))
  return [value, (next) => {
    try { window.localStorage.setItem(key, JSON.stringify(next)) } catch { /* Layout preferences must not interrupt terminals. */ }
    setValue(next)
  }]
}

export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

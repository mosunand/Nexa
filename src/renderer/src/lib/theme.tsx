// lib/theme.tsx — 主题上下文：dark/light + 氛围光晕开关，持久化到主进程设置。

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

interface ThemeCtx {
  theme: 'dark' | 'light'
  aurora: boolean
  toggleTheme: () => void
  toggleAurora: () => void
}

const Ctx = createContext<ThemeCtx>({
  theme: 'dark',
  aurora: true,
  toggleTheme: () => {},
  toggleAurora: () => {}
})

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [aurora, setAurora] = useState(true)

  useEffect(() => {
    // 初始化：读回持久化设置
    void window.nexa.getSettings().then((s) => {
      if (s.theme) setTheme(s.theme)
      try {
        const a = localStorage.getItem('nexa.aurora')
        if (a !== null) setAurora(a === '1')
      } catch {
        /* localStorage 不可用 —— 保持默认 */
      }
    })
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    void window.nexa.setSettings({ theme })
    void window.nexa.applyOverlay(theme)
  }, [theme])

  useEffect(() => {
    try {
      localStorage.setItem('nexa.aurora', aurora ? '1' : '0')
    } catch {
      /* 忽略 */
    }
  }, [aurora])

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])
  const toggleAurora = useCallback(() => setAurora((a) => !a), [])

  return <Ctx.Provider value={{ theme, aurora, toggleTheme, toggleAurora }}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeCtx {
  return useContext(Ctx)
}

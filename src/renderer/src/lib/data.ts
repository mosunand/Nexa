// lib/data.ts — 渲染端数据钩子：懒加载查询、事件订阅、全局 dataChanged 脉搏。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { NexaApi, NexaEventMap } from '@shared/api'

export const api = (): NexaApi => window.nexa

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  enabled = true
): { data: T | undefined; err: string; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(enabled)
  const [tick, setTick] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled) return
    let alive = true
    setLoading(true)
    setErr('')
    fnRef
      .current()
      .then((v) => {
        if (alive) {
          setData(v)
          setLoading(false)
        }
      })
      .catch((e: Error) => {
        if (alive) {
          setErr(String(e.message ?? e))
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, err, loading, reload }
}

export function useNexaEvent<K extends keyof NexaEventMap>(
  event: K,
  cb: (payload: NexaEventMap[K]) => void
): void {
  const cbRef = useRef(cb)
  cbRef.current = cb
  useEffect(() => {
    const on = window.nexa.on as unknown as (e: string, fn: (payload?: unknown) => void) => () => void
    return on(event, cbRef.current as (payload?: unknown) => void)
  }, [event])
}

// dataChanged 脉搏：任意页面数据变更时 +1
export function useDataTick(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    return window.nexa.on('dataChanged', () => setN((v) => v + 1))
  }, [])
  return n
}

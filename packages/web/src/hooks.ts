import { useEffect, useState } from 'react'
import type { LoadResult } from './api.ts'

export interface ResourceState<T> {
  loading: boolean
  result: LoadResult<T> | null
}

/** 通用异步加载 hook；deps 变化或组件挂载时重新拉取，卸载后丢弃过期结果。 */
export function useResource<T>(loader: () => Promise<LoadResult<T>>, deps: unknown[]): ResourceState<T> {
  const [state, setState] = useState<ResourceState<T>>({ loading: true, result: null })
  useEffect(() => {
    let alive = true
    setState({ loading: true, result: null })
    loader()
      .then((result) => {
        if (alive) setState({ loading: false, result })
      })
      .catch((e: unknown) => {
        if (alive) setState({ loading: false, result: null })
        console.error('useResource failed', e)
      })
    return () => {
      alive = false
    }
    // loader 由调用点的 deps 决定稳定性，这里只跟随 deps。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

/**
 * 轮询版资源加载 hook：首屏 loading，之后每 intervalMs 静默刷新（页面不可见时跳过）。
 * 用于「牌桌直播」这类需要持续更新的页面；后端未就绪时每次都回退 mock，不影响渲染。
 */
export function usePolledResource<T>(
  loader: () => Promise<LoadResult<T>>,
  deps: unknown[],
  intervalMs = 5000,
): ResourceState<T> {
  const [state, setState] = useState<ResourceState<T>>({ loading: true, result: null })
  useEffect(() => {
    let alive = true
    const run = async (initial: boolean) => {
      if (initial) setState({ loading: true, result: null })
      try {
        const result = await loader()
        if (alive) setState({ loading: false, result })
      } catch (e: unknown) {
        if (alive && initial) setState({ loading: false, result: null })
        console.error('usePolledResource failed', e)
      }
    }
    void run(true)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void run(false)
    }, intervalMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

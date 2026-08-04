/**
 * 前端流式 Ticker — ICover 协议前端语义实现
 *
 * 论文模块: §3.5 前端流式 Ticker 与 ICover 覆盖, 算法 4
 *
 * 核心设计:
 *   - streamingRef: 用 ref 而不是 state, 避免重渲染
 *   - STREAM_INTERVAL_MS = 50ms: 每 50ms 推一个元素 (逐行入场动画)
 *   - STREAM_BATCH = 1: 每 tick 推 1 个
 *   - withStableId: 用 index 生成稳定 key (不拼接值字段!)
 *   - mergeExisting: ICover 字段级覆盖 (Overwrite Merge)
 *   - forceFlushPartial: 兜底同步推送, 绕过 ticker 节流
 *
 * 框架无关: 本文件仅包含纯逻辑, 不依赖 React/Zustand/Vue 等。
 * 集成时由调用方提供 store 的 get/set 函数。
 */

export interface StreamingRef<T> {
  appendedCount: number
  intervalId: ReturnType<typeof setInterval> | null
  partialRef: T[]
  cancelled: boolean
}

export const STREAM_INTERVAL_MS = 50
export const STREAM_BATCH = 1

/** 轮询调度 (指数退避) — 单位 ms */
export const POLL_SCHEDULE_MS = [
  1000, 1000, 1000, 1000, 1000,
  2000, 2000, 2000,
  3000, 3000,
  4000, 5000, 6000,
]
export const MAX_POLL_MS = 180_000  // 3 minutes max

/** 创建 streamingRef (替代 React useRef) */
export function createStreamingRef<T>(): StreamingRef<T> {
  return {
    appendedCount: 0,
    intervalId: null,
    partialRef: [],
    cancelled: false,
  }
}

/**
 * 稳定 ID 注入器
 *
 * ★ ICover 关键: ID 只用 index, 绝不拼接 name/amount 等值字段。
 *   原实现 stream-${idx}-${name} 会导致 "Cal" → "Calcium" 时 ID 变化,
 *   React 判定为新元素 → unmount 旧行 + mount 新行, 而非原地更新。
 *   正确做法: stream-${idx} 保证值变化时 React 执行 in-place overwrite。
 */
export function withStableId<T extends Record<string, unknown>>(
  item: T,
  idx: number,
): T & { id: string } {
  if (!item) {
    // 返回带 id 的占位对象, 类型断言确保编译通过
    return { id: `stream-${idx}` } as T & { id: string }
  }
  if ((item as { id?: unknown }).id) return item as T & { id: string }
  return { ...item, id: `stream-${idx}` } as T & { id: string }
}

/**
 * ICover 覆盖合并 (Overwrite Merge)
 *
 * ★ ICover 核心: 对 [0, appendedCount) 区间执行字段覆盖, 实现 ICover 协议的前端语义。
 *   原实现只追加新 index, 不更新已显示 index 的陈旧值,
 *   导致 t1 时刻的 {"name":"Cal"} 永远不会被 t2 时刻的 {"name":"Calcium"} 覆盖。
 */
export function mergeExisting<T extends Record<string, unknown>>(
  partial: T[],
  currentItems: T[],
): T[] {
  const overlapLen = Math.min(currentItems.length, partial.length)
  if (overlapLen === 0) return currentItems
  const merged = [...currentItems]
  for (let i = 0; i < overlapLen; i++) {
    const partialItem = partial[i]
    if (!partialItem) continue
    const newItem = withStableId(partialItem, i)
    // 字段级覆盖: 新值覆盖旧值, 保留旧值中不存在于新值的字段 (兼容性)
    merged[i] = { ...merged[i], ...newItem } as T
  }
  return merged
}

/**
 * 流式 Ticker — 50ms 逐行入场动画
 *
 * 仅处理新增 index 的入场动画; 已显示 index 的覆盖由 forceFlushPartial 完成。
 */
export function startStreamingTicker<T extends Record<string, unknown>>(
  ref: StreamingRef<T>,
  partial: T[],
  setItems: (items: T[]) => void,
  getItems: () => T[],
): void {
  if (ref.cancelled) return
  if (!Array.isArray(partial) || partial.length === 0) return

  ref.partialRef = partial
  if (ref.intervalId !== null) return  // 已有 ticker

  ref.intervalId = setInterval(() => {
    if (ref.cancelled) {
      if (ref.intervalId !== null) {
        clearInterval(ref.intervalId)
        ref.intervalId = null
      }
      return
    }
    const partialNow = ref.partialRef
    if (!Array.isArray(partialNow) || partialNow.length === 0) return

    const remaining = partialNow.length - ref.appendedCount
    if (remaining <= 0) {
      if (ref.intervalId !== null) {
        clearInterval(ref.intervalId)
        ref.intervalId = null
      }
      return
    }

    const nextCount = Math.min(remaining, STREAM_BATCH)
    const slice = partialNow.slice(ref.appendedCount, ref.appendedCount + nextCount)
    const sliceWithId = slice.map((s, i) => withStableId(s, ref.appendedCount + i))

    // 读取 store 当前 items, 追加 (避免覆盖已有)
    const currentItems = getItems()
    // ★ 游标 guard: 防止 store 长度与 appendedCount 漂移导致 index 空洞
    if (currentItems.length < ref.appendedCount) {
      ref.appendedCount = currentItems.length
    }
    const appended = [...currentItems, ...sliceWithId]
    ref.appendedCount = appended.length
    setItems(appended)
  }, STREAM_INTERVAL_MS)
}

/**
 * Force-Flush — 兜底同步推送 + ICover 覆盖
 *
 * ★ 每次 poll 拿到新 partial 时, 先覆盖已显示 index 的陈旧值, 再追加新 index。
 *   绕过 50ms ticker 节流, 防止 ticker 因渲染竞争丢失数据。
 */
export function forceFlushPartial<T extends Record<string, unknown>>(
  ref: StreamingRef<T>,
  partial: T[],
  setItems: (items: T[]) => void,
  getItems: () => T[],
): void {
  if (!Array.isArray(partial) || partial.length === 0) return
  if (ref.cancelled) return
  ref.partialRef = partial

  const currentItems = getItems()
  if (currentItems.length < ref.appendedCount) {
    ref.appendedCount = currentItems.length
  }

  // Step 1: ICover 覆盖 — 更新 [0, appendedCount) 区间的陈旧值
  const merged = mergeExisting(partial, currentItems)

  // Step 2: 追加 [appendedCount, partial.length) 区间的新元素 (绕过 50ms ticker)
  if (partial.length > ref.appendedCount) {
    const newSlice = partial.slice(ref.appendedCount)
    const newSliceWithId = newSlice.map((s, i) => withStableId(s, ref.appendedCount + i))
    merged.push(...newSliceWithId)
    ref.appendedCount = merged.length
  }

  setItems(merged)
}

/** 终态清理 */
export function cancelStreaming<T>(ref: StreamingRef<T>): void {
  ref.cancelled = true
  if (ref.intervalId !== null) {
    clearInterval(ref.intervalId)
    ref.intervalId = null
  }
}

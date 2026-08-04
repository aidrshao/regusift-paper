/**
 * ICover (Incremental Cover) 协议 — 参考实现
 *
 * 核心思想:
 *   传统 Delta 模式 (emit 新增切片) 会导致已显示对象停留在过时状态,
 *   因为 LLM 流式输出中值是非单调的 (例如 "Cal" → "Calcium")。
 *   ICover 协议要求每次 emit 完整数组, 由消费方执行覆盖更新,
 *   确保前端始终展示最新值, 终态收敛到真值。
 *
 * 关键不变量:
 *   - 键集随流式生成单调增长
 *   - 值在流式过程中可能非单调更新
 *   - 流式结束时收敛到完整真值
 *
 * 依赖: 无外部依赖 (纯协议定义)
 */

import { parsePartialJson } from './partial-json-parser'

/**
 * ICover 协议的 emit 函数类型
 *
 * @param parsed 当前 chunk 解析出的完整数组 (非 delta!)
 * @returns 消费方执行覆盖更新后的状态
 */
export type ICoverEmit<T> = (parsed: T[]) => T[]

/**
 * ICover 协议的 reduceStream 核心循环
 *
 * 与 Delta 模式的关键差异:
 *   Delta:  emit(parsed.slice(emittedCount))   — 仅新增切片, 消费方 append
 *   ICover: emit(parsed)                       — 完整数组, 消费方 overwrite
 *
 * 不做 length >= emittedCount 拦截:
 *   即使本次解析出的数组更短, 也要 emit, 因为最新数据一定更准确。
 *
 * @param chunks   LLM 流式输出的 chunk 迭代器 (async iterable)
 * @param arrayKey 目标数组键名 (如 "ingredients")
 * @param onEmit   ICover emit 回调 (消费方执行覆盖更新)
 * @returns 终态完整解析结果
 */
export async function reduceStream<T = unknown>(
  chunks: AsyncIterable<string>,
  arrayKey: string,
  onEmit: ICoverEmit<T>,
): Promise<T[] | null> {
  let buffer = ''
  let lastEmitted: T[] = []

  for await (const chunk of chunks) {
    buffer += chunk

    // 每个 chunk 后触发 parsePartialJson (全量抢救式解析)
    const result = parsePartialJson(buffer, arrayKey)

    if (result.parsed && typeof result.parsed === 'object') {
      const parsedObj = result.parsed as Record<string, unknown>
      const arr = parsedObj[arrayKey]
      if (Array.isArray(arr) && arr.length > 0) {
        // ★ ICover 核心: emit 完整数组 (非 delta), 调用方覆盖
        lastEmitted = onEmit(arr as T[])
      }
    }
  }

  // 终态解析 (t = T 时, buffer 为完整 JSON, Layer 1 直接解析成功)
  const finalResult = parsePartialJson(buffer, arrayKey)
  if (finalResult.parsed && typeof finalResult.parsed === 'object') {
    const parsedObj = finalResult.parsed as Record<string, unknown>
    const arr = parsedObj[arrayKey]
    if (Array.isArray(arr)) {
      lastEmitted = onEmit(arr as T[])
    }
  }

  return lastEmitted
}

/**
 * Delta 模式 (对照组 — 用于消融实验)
 *
 * 仅 emit 新增切片, 不更新已显示对象。
 * 论文表 9 消融实验显示: Delta 模式 F1 从 0.6286 骤降至 0.1833。
 */
export async function reduceStreamDelta<T = unknown>(
  chunks: AsyncIterable<string>,
  arrayKey: string,
  onEmit: (delta: T[]) => T[],
): Promise<T[] | null> {
  let buffer = ''
  let emittedCount = 0
  let accumulated: T[] = []

  for await (const chunk of chunks) {
    buffer += chunk
    const result = parsePartialJson(buffer, arrayKey)

    if (result.parsed && typeof result.parsed === 'object') {
      const parsedObj = result.parsed as Record<string, unknown>
      const arr = parsedObj[arrayKey]
      if (Array.isArray(arr) && arr.length > emittedCount) {
        // ★ Delta: 仅 emit 新增切片, 不更新已有
        const delta = (arr as T[]).slice(emittedCount)
        accumulated = onEmit(delta)
        emittedCount = arr.length
      }
    }
  }

  return accumulated
}

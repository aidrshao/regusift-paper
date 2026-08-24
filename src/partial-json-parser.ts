/**
 * 截断 JSON 抢救器 — 三层渐进恢复策略（V2 修复版）
 *
 * 论文模块: §2/§3 截断 JSON 救援 + §4 理论分析
 *
 * V2 修复版相对早期版本的两处关键修复:
 *   1. 【P1/P4 幽灵键】preprocessTruncated 的做法 4 不再为"不完整的尾部键名"补造 `:null`
 *      （这会制造幽灵键 `"stoc"` → 后续真实键 `"stock"` 出现后键集回退，违反完全键单调性，
 *      也破坏定理1/推论1）。改为: 检测到尾部是未闭合、不完整的键名时, 丢弃该碎片,
 *      回退到最近完整值之后, 由后续策略层闭合剩余括号。
 *   2. 【P5 Layer3 假数组】tryExtractArray 的正则锚点不做字符串感知, 可能误命中字符串值
 *      `\"ingredients\": [` 伪装数组。改为: 优先用字符串感知的顶层键扫描定位。
 *
 * 输入:
 *   - raw: 原始 LLM 流式累积 buffer 字符串
 *   - arrayKey: 可选, 目标数组键名 (默认 "ingredients")
 *
 * 输出:
 *   - { parsed, wasTruncated, recovered }
 */

export interface PartialJsonResult {
  parsed: unknown
  wasTruncated: boolean
  recovered: boolean
}

/** 判断"最后一个任务是被截断的字符串值"(前面是 ':')还是"不完整键名"(前面是 '{'或',') */
/** 是否应丢弃末尾字符串: 找到末尾字符串段的"开始引号", 看它左侧最近的非空白结构符。
 * 若左侧是 { 或 , → 该段是键名(值未到), 丢弃; 若左侧是 : → 该段是值, 保留。
 * 注意: 必须用"本字符串段的开始引号"定位起点, 否则会把左侧已配对 `"key":"value"` 误判。 */
function shouldDropTrailingStringKey(text: string): boolean {
  if (!text.endsWith('"')) return false
  const startQuote = findLastStringStart(text)
  if (startQuote === -1) return false
  // 从开始引号左侧向前找最近的非空白结构符
  let j = startQuote - 1
  while (j >= 0 && /\s/.test(text[j])) j--
  if (j < 0) return false
  const c = text[j]
  return c === '{' || c === ','
}

/** 从末尾去掉一个"处于键名位置的不完整键"碎片, 回退到最近完整边界。
 * 仅在 shouldDropTrailingStringKey 判定为键名时调用。 */
function trimBackToLastCompleteValue(text: string): string {
  let result = text.replace(/[ \t\r\n]+$/, '')
  // 找该键名段的开始引号
  const startQuoteIdx = findLastStringStart(result)
  if (startQuoteIdx === -1) return result
  let tail = result.slice(0, startQuoteIdx).replace(/[ \t\r\n]+$/, '')
  // 去掉前导分隔符: 若 -就一个 `,` 则去掉; 若以 `{` 或 `,` 结尾需要保留外层结构
  if (tail.endsWith(',')) {
    tail = tail.slice(0, -1).replace(/[ \t\r\n]+$/, '')
  }
  return tail
}

/** 找到最后一个字符串的开始引号索引 (从末尾向前扫) */
function findLastStringStart(text: string): number {
  let i = text.length - 1
  if (text[i] !== '"') return -1
  i-- // 跳过闭合引号
  let escape = false
  while (i >= 0) {
    if (escape) {
      escape = false
      i--
      continue
    }
    if (text[i] === '\\') {
      escape = true
      i--
      continue
    }
    if (text[i] === '"') return i
    i--
  }
  return -1
}

function preprocessTruncated(text: string): string {
  // Step 1: 闭合未关闭的字符串
  let result = closeOpenStrings(text).trimEnd()

  // Step 2: 移除尾随逗号
  if (result.endsWith(',')) {
    result = result.slice(0, -1).trimEnd()
  }

  // Step 3: 冒号后缺值 → 补 null
  if (result.endsWith(':')) {
    result = result + 'null'
  }

  // Step 4（修复版）: 若以已闭合字符串结尾, 且它处于"键名"位置(最近结构符是 { 或 ,)——
  // 不再补 `:null` 制造幽灵键; 改为丢弃该不完整键名, 回退到最近完整边界。
  // 若处于"值"位置(最近结构符是 ':'), 说明是值字符串被截断, 保留为部分值。
  // 这是对原版幽灵键 bug 的关键修复(整改方案 §3.2)。
  if (result.endsWith('"')) {
    if (shouldDropTrailingStringKey(result)) {
      result = trimBackToLastCompleteValue(result)
    }
  }

  // Step 5: 小数点截断 → 补 0
  if (result.endsWith('.') && result.length >= 2 && /\d/.test(result.charAt(result.length - 2))) {
    result = result + '0'
  }

  return result
}

export function parsePartialJson(raw: string, arrayKey?: string): PartialJsonResult {
  if (!raw || typeof raw !== 'string') {
    return { parsed: null, wasTruncated: false, recovered: false }
  }

  const trimmed = stripMarkdownJsonFence(raw.trim())

  // Layer 1: 直接解析
  try {
    const parsed = JSON.parse(trimmed)
    return { parsed, wasTruncated: false, recovered: false }
  } catch {
    // 继续尝试
  }

  // Layer 2: 截断尾部预处理 + 括号闭合恢复
  const recovered = tryRecoverByClosing(trimmed)
  if (recovered !== null) {
    return { parsed: recovered, wasTruncated: true, recovered: true }
  }

  // Layer 3: 目标数组定向提取 (动态 arrayKey)
  const targetKey = arrayKey || 'ingredients'
  const array = tryExtractArray(trimmed, targetKey)
  if (array !== null) {
    return {
      parsed: { [targetKey]: array },
      wasTruncated: true,
      recovered: true,
    }
  }

  return { parsed: null, wasTruncated: true, recovered: false }
}

function tryRecoverByClosing(trimmed: string): unknown | null {
  const prepared = preprocessTruncated(trimmed)
  const strategies = buildClosingStrategies(prepared)

  for (const candidate of strategies) {
    try {
      return JSON.parse(candidate)
    } catch {
      continue
    }
  }

  return null
}

/**
 * 提取目标数组 (动态 arrayKey) — 修复版
 *
 * 优先用字符串感知的"顶层键"扫描定位目标键, 避免字符串值内 `"ingredients": [`
 * 被误判为真实数组(整改方案 §3.5)。
 * 若顶层扫描未命中, 再降级使用原正则(保留兜底), 但此时不承诺对象对齐。
 */
function tryExtractArray(trimmed: string, arrayKey: string): unknown[] | null {
  // —— 方式 A: 字符串感知的顶层键定位 ——
  const found = findTopLevelArrayStart(trimmed, arrayKey)
  const startIdx = found !== null ? found : findRegexArrayStart(trimmed, arrayKey)

  if (startIdx === null) return null
  const arrayStr = trimmed.substring(startIdx)

  const prepared = preprocessTruncated(arrayStr)
  const strategies = buildClosingStrategies(prepared)

  for (const candidate of strategies) {
    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed)) return parsed
    } catch {
      continue
    }
  }

  return null
}

/** 字符串感知扫描: 在键上下文({或,之后、:之前)匹配 "arrayKey", 返回其后的 '[' 索引 */
function findTopLevelArrayStart(trimmed: string, arrayKey: string): number | null {
  const needle = `"${arrayKey}"`
  let i = 0
  let inString = false
  let escape = false
  const n = trimmed.length

  while (i < n) {
    const ch = trimmed[i]
    if (escape) { escape = false; i++; continue }
    if (ch === '\\' && inString) { escape = true; i++; continue }
    if (ch === '"') {
      // 检查是否是我们要找的键名(前一个非空白是 { 或 ,)
      if (!inString && trimmed.startsWith(needle, i)) {
        // 找 startsWith 前的一个非空白字符
        let j = i - 1
        while (j >= 0 && /\s/.test(trimmed[j])) j--
        const prev = j >= 0 ? trimmed[j] : null
        if (prev === '{' || prev === ',') {
          // 验证 needle 之后紧跟 ':' 与 '['
          let k = i + needle.length
          while (k < n && /\s/.test(trimmed[k])) k++
          if (trimmed[k] === ':') {
            k++
            while (k < n && /\s/.test(trimmed[k])) k++
            if (trimmed[k] === '[') return k // 返回 '[' 索引(与 findRegexArrayStart 一致)
          }
          // 该位置看似键但合法值缺失, 不终止, 继续扫(在其字符串内会消耗)
        }
      }
      inString = !inString
      i++
      continue
    }
    if (inString) { i++; continue }
    i++
  }
  return null
}

/** 原正则锚点 (兜底) */
function findRegexArrayStart(trimmed: string, arrayKey: string): number | null {
  const pattern = new RegExp(`"${escapeRegExp(arrayKey)}"\\s*:\\s*\\[`)
  const match = trimmed.match(pattern)
  if (!match?.index) return null
  return match.index + match[0].length - 1
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildClosingStrategies(text: string): string[] {
  const counts = countBrackets(text)
  const needBrackets = Math.max(0, counts.openBrackets)
  const needBraces = Math.max(0, counts.openBraces)

  const candidates: string[] = []

  // 策略 1: 交替闭合 (对象内嵌套数组)
  const alt1 = text + '}'.repeat(needBraces) + ']'.repeat(needBrackets)
  candidates.push(alt1)

  // 策略 2: 先 ] 后 }
  const alt2 = text + ']'.repeat(needBrackets) + '}'.repeat(needBraces)
  candidates.push(alt2)

  // 策略 3: 逐层交替闭合
  if (needBraces > 0 && needBrackets > 0) {
    const alt3 = text + '}' + ']'.repeat(needBrackets) + '}'.repeat(needBraces - 1)
    candidates.push(alt3)
  }

  // 策略 4: 仅闭合数组
  if (needBrackets > 0) {
    const alt4 = text + ']'.repeat(needBrackets)
    candidates.push(alt4)
  }

  // 策略 5: 仅闭合花括号
  if (needBraces > 0) {
    const alt5 = text + '}'.repeat(needBraces)
    candidates.push(alt5)
  }

  return candidates
}

function closeOpenStrings(text: string): string {
  let inString = false
  let escape = false

  for (const ch of text) {
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
    }
  }

  return inString ? text + '"' : text
}

/** 字符串感知的括号计数器: O(n) 时间, O(1) 空间 */
function countBrackets(text: string): { openBraces: number; openBrackets: number } {
  let openBraces = 0
  let openBrackets = 0
  let inString = false
  let escape = false

  for (const ch of text) {
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === '{') openBraces++
    else if (ch === '}') openBraces--
    else if (ch === '[') openBrackets++
    else if (ch === ']') openBrackets--
  }

  return { openBraces, openBrackets }
}

function stripMarkdownJsonFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim()
}
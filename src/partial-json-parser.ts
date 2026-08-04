/**
 * 截断 JSON 抢救器 — 三层渐进恢复策略
 *
 * 论文模块: §3.2 截断 JSON 抢救器, 算法 1/2/3
 *
 * 策略:
 *   Layer 1: 直接解析 (Direct Parse)
 *   Layer 2: 截断尾部 5 步预处理 + 五种括号闭合顺序枚举
 *   Layer 3: 目标数组定向提取 (动态 arrayKey)
 *
 * 输入:
 *   - raw: 原始 LLM 流式累积 buffer 字符串
 *   - arrayKey: 可选, 目标数组键名 (默认 "ingredients")
 *
 * 输出:
 *   - { parsed, wasTruncated, recovered }
 *
 * 依赖: 无外部依赖 (纯算法核)
 */

export interface PartialJsonResult {
  parsed: unknown
  wasTruncated: boolean
  recovered: boolean
}

/**
 * 解析可能被截断的 JSON。
 *
 * @param raw 原始 LLM 输出字符串
 * @param arrayKey 可选, 目标数组键名 (如 "ingredients"/"products"/"revenue"),
 *                 用于 Layer 3 定向提取。不传则默认 "ingredients"。
 */
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
  // 预处理: 闭合未关闭字符串 + 修复 5 类截断尾部
  const prepared = preprocessTruncated(trimmed)

  // 尝试多种闭合策略
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
 * 预处理截断的 JSON 文本, 修复 5 类常见截断尾部:
 *
 * 1. 未闭合字符串: `"name": "Vitamin C` → 追加 `"`
 * 2. 尾随逗号: `"amount": "900",` → 移除逗号
 * 3. 冒号后缺值: `"amount":` → 补 null
 * 4. 键名截断: `"stoc` → 闭合字符串后补 :null
 *    (即: 字符串已闭合, 但前面是 { 或 ,, 说明它是键而非值)
 * 5. 小数点截断: `"price": 34.` → 补 0
 */
function preprocessTruncated(text: string): string {
  // Step 1: 闭合未关闭的字符串
  let result = closeOpenStrings(text).trimEnd()

  // Step 2: 如果以逗号结尾, 移除尾随逗号
  if (result.endsWith(',')) {
    result = result.slice(0, -1).trimEnd()
  }

  // Step 3: 如果以冒号结尾 (缺值), 补 null
  if (result.endsWith(':')) {
    result = result + 'null'
  }

  // Step 4: 如果以闭合字符串结尾, 且该字符串是一个键 (前面是 { 或 ,)
  // 则补 :null, 使其成为完整的键值对
  if (result.endsWith('"')) {
    const charBefore = findCharBeforeLastString(result)
    if (charBefore === '{' || charBefore === ',') {
      result = result + ':null'
    }
  }

  // Step 5: 如果以小数点结尾且前面是数字 (如 "price": 34.), 补 0
  if (result.endsWith('.') && result.length >= 2 && /\d/.test(result.charAt(result.length - 2))) {
    result = result + '0'
  }

  return result
}

/**
 * 找到最后一个完整字符串之前的非空白字符
 * 用于判断该字符串是键 (前面是 { 或 ,) 还是值 (前面是 :)
 */
function findCharBeforeLastString(text: string): string | null {
  let i = text.length - 1
  if (text[i] !== '"') return null
  i-- // 跳过闭合引号

  // 向前查找开始引号
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
    if (text[i] === '"') {
      break
    }
    i--
  }
  if (i < 0) return null
  i-- // 跳过开始引号

  // 跳过空白
  while (i >= 0 && /\s/.test(text.charAt(i))) i--

  if (i < 0) return null
  return text.charAt(i)
}

/**
 * 提取目标数组 (动态 arrayKey)
 *
 * 查找 `"arrayKey": [ ...` 模式, 闭合后解析为数组
 */
function tryExtractArray(trimmed: string, arrayKey: string): unknown[] | null {
  const pattern = new RegExp(`"${escapeRegExp(arrayKey)}"\\s*:\\s*\\[`)
  const match = trimmed.match(pattern)
  if (!match?.index) return null

  const startIdx = match.index + match[0].length - 1
  const arrayStr = trimmed.substring(startIdx)

  // 预处理 + 闭合
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 构建多种闭合策略 — 五种括号闭合顺序
 *
 * 截断的 JSON 可能在任意位置断开, 简单的 "先 ] 后 }" 不一定正确。
 * 我们尝试多种闭合顺序, 返回第一个成功解析的 (语义一致性由 JSON 标准保证)。
 */
function buildClosingStrategies(text: string): string[] {
  const counts = countBrackets(text)
  const needBrackets = Math.max(0, counts.openBrackets)
  const needBraces = Math.max(0, counts.openBraces)

  const candidates: string[] = []

  // 策略 1: 交替闭合 (最常见场景 — 对象内嵌套数组)
  // 例如: {"ingredients":[{"name":"Vitamin D3"}]}
  // 闭合顺序: } ] }
  const alt1 = text + '}'.repeat(needBraces) + ']'.repeat(needBrackets)
  candidates.push(alt1)

  // 策略 2: 先 ] 后 } (数组优先闭合)
  const alt2 = text + ']'.repeat(needBrackets) + '}'.repeat(needBraces)
  candidates.push(alt2)

  // 策略 3: 逐层交替闭合
  // 对于嵌套结构如 {"ingredients":[{"name":"Vit D3","amount":"1000"
  // 需要: }]}}
  if (needBraces > 0 && needBrackets > 0) {
    // 先闭合一层对象, 再闭合数组, 再闭合剩余对象
    const alt3 = text + '}' + ']'.repeat(needBrackets) + '}'.repeat(needBraces - 1)
    candidates.push(alt3)
  }

  // 策略 4: 仅闭合括号
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

/**
 * 闭合 JSON 中未关闭的字符串
 * 当 JSON 在字符串值中间被截断时, 最后一个 " 未闭合
 */
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

  // 如果字符串未闭合, 追加一个引号
  return inString ? text + '"' : text
}

/**
 * 字符串感知的括号计数器
 * 跳过 JSON 字符串值内部的 { } [ ] 字符, 确保计数准确性。
 * 时间复杂度 O(n), 空间复杂度 O(1)。
 */
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

/**
 * 清洗 LLM 输出中的 markdown code fence 包裹
 *
 * LLM 经常返回 ```json\n{...}\n``` 格式,
 * 必须在 JSON.parse 之前剥离, 否则解析必然失败。
 */
function stripMarkdownJsonFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim()
}

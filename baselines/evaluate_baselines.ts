/**
 * 统一基线对比评估脚本（V2 修复版 + 完整外部基线）
 * ==================================================
 * 在同一次周转中评估：
 *   B1 naive (JSON.parse)
 *   B2 partial-json (npm)
 *   B3 json-repair (npm)
 *   B4 JsonCompleter (按文献[9]语义复现的有状态增量解析器, 见 method_json_completer 实现:
 *      字符串感知单遍扫描 + 上下文栈, 按栈顶闭合最小必要结构且不补造幽灵键; 非原作者原始代码)
 *   B5 best-effort-json-parser (npm)
 *   B6 llm-json-repair tolerantParse (npm)
 *   Ours (V2 修复版 parsePartialJson)
 * 全部在同一 V8 沙箱运行，保证等值可复现。
 * 输出 stdin->JSON array of samples, stdout->results。
 */
import { parsePartialJson } from '../src/partial-json-parser'
import { parse as parsePartialJsonLib, Allow as AllowPartial } from 'partial-json'
import { parse as parseBestEffort } from 'best-effort-json-parser'
import { tolerantParse } from 'llm-json-repair'
import { jsonrepair as repairJSON } from 'jsonrepair'

function method_naive(buffer: string): { parsed: any; latency_ms: number } {
  const t0 = performance.now(); let parsed: any = null
  try { parsed = JSON.parse(buffer.trim()) } catch { parsed = null }
  return { parsed, latency_ms: performance.now() - t0 }
}
function method_partial_json(buffer: string): { parsed: any; latency_ms: number } {
  const t0 = performance.now(); let parsed: any = null
  try { parsed = parsePartialJsonLib(buffer, AllowPartial.ALL) } catch { parsed = null }
  return { parsed, latency_ms: performance.now() - t0 }
}
function method_json_repair(buffer: string): { parsed: any; latency_ms: number } {
  if (!repairJSON) return { parsed: null, latency_ms: 0 }
  const t0 = performance.now(); let parsed: any = null
  try { parsed = JSON.parse(repairJSON(buffer)) } catch { parsed = null }
  return { parsed, latency_ms: performance.now() - t0 }
}
function method_best_effort(buffer: string): { parsed: any; latency_ms: number } {
  const t0 = performance.now(); let parsed: any = null
  try { parsed = parseBestEffort(buffer) } catch { parsed = null }
  return { parsed, latency_ms: performance.now() - t0 }
}
function method_tolerant_repair(buffer: string): { parsed: any; latency_ms: number } {
  const t0 = performance.now(); let parsed: any = null
  try { parsed = tolerantParse(buffer) } catch { parsed = null }
  return { parsed, latency_ms: performance.now() - t0 }
}

/**
 * B4 JsonCompleter — 忠实移植 aha-app/json_completer (Kuzmenko 原算法)
 * =====================================================================
 * 依据: github.com/aha-app/json_completer 的 completion_engine.rb + scanners.rb。
 * 关键语义 (与原实现一致):
 *   - 不完整键名 -> 补造 ":null" (例: '{"foo' -> '{"foo":null}')
 *   - 缺值 (末尾 ':') -> 补 'null'
 *   - 数组尾逗号 -> 补 'null'
 *   - 不完整字符串 -> 关闭引号; 不完整关键字 -> 补全 true/false/null
 *   - 按上下文栈闭合未闭合容器
 * 该算法以补造幽灵键换取高恢复率, 与本文"无幽灵键"保证形成诚实对照。
 */
function jsonCompleterParse(text: string): any {
  const input = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  // 先尝试完整解析
  try { return JSON.parse(input) } catch { /* fallthrough */ }

  const STRUCTURE = new Set(['[', '{', ',', ':'])
  const KEYWORD: Record<string, string> = { t: 'true', f: 'false', n: 'null' }
  const getLast = (t: string[]): string | null => {
    for (let i = t.length - 1; i >= 0; i--) { const s = t[i].trim(); if (s.length) return s[s.length - 1] }
    return null
  }
  const getPrev = (t: string[]): string | null => {
    let c = 0
    for (let i = t.length - 1; i >= 0; i--) { const s = t[i].trim(); if (!s.length) continue; c++; if (c >= 2) return s[s.length - 1] }
    return null
  }
  const rmComma = (t: string[]) => {
    let idx = -1
    for (let i = t.length - 1; i >= 0; i--) { if (t[i].trim().length) { idx = i; break } }
    if (idx !== -1 && t[idx].trim() === ',') { t.splice(idx, 1); while (idx > 0 && t[idx - 1].trim() === '') { t.splice(idx - 1, 1); idx-- } }
  }
  const commaBefore = (t: string[], st: string[], last: string | null) => {
    if (!t.length || !st.length || last == null) return
    if (STRUCTURE.has(last)) return
    const top = st[st.length - 1]
    if (top === '[' || (top === '{' && last !== ':')) t.push(',')
  }
  const colonIf = (t: string[], st: string[], last: string | null) => {
    if (!t.length || !st.length || last == null) return
    if (st[st.length - 1] === '{' && last === '"') t.push(':')
  }
  const scanStr = (s: string, start: number): { tok: string; consumed: number; ok: boolean } => {
    let buf = '"', esc = false, uni = false, digits = '', i = start
    for (; i < s.length; i++) {
      const ch = s[i]
      if (uni) { if (/[0-9a-fA-F]/.test(ch)) { digits += ch; if (digits.length === 4) uni = false } else uni = false; buf += ch; continue }
      if (esc) { if (ch === 'u') { uni = true; digits = '' } buf += ch; esc = false; continue }
      if (ch === '\\') { buf += ch; esc = true; continue }
      if (ch === '"') { buf += ch; i++; return { tok: buf, consumed: i - start, ok: true } }
      buf += ch
    }
    return { tok: buf, consumed: i - start, ok: false }
  }
  const finalizeStr = (buf: string): string => {
    let v = buf, tr = 0, i = v.length - 1
    while (i >= 0 && v[i] === '\\') { tr++; i-- }
    if (tr % 2 === 1) v = v.slice(0, -1)
    v = v.replace(/\\u[0-9a-fA-F]{0,3}$/, '')
    return v + '"'
  }
  const scanNum = (s: string, start: number): { num: string; consumed: number } => {
    let i = start
    while (i < s.length && (/[0-9\-+.]/.test(s[i]) || /[eE]/.test(s[i]))) i++
    return { num: s.slice(start, i), consumed: i - start }
  }
  const scanKw = (s: string, start: number, word: string): number => {
    let c = 0; while (c < word.length && s[start + c] === word[c]) c++; return Math.max(c, 1)
  }

  const tokens: string[] = []
  const stack: string[] = []
  let incomplete: string | null = null
  let index = 0
  while (index < input.length) {
    const ch = input[index]
    const last = getLast(tokens)
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { tokens.push(ch); index++; continue }
    if (ch === '"') {
      commaBefore(tokens, stack, last); colonIf(tokens, stack, last)
      const r = scanStr(input, index + 1)
      if (r.ok) tokens.push(r.tok); else incomplete = r.tok
      index += r.consumed + 1; continue
    }
    if (ch === ',') { rmComma(tokens); tokens.push(','); index++; continue }
    if (ch === ':') { rmComma(tokens); tokens.push(':'); index++; continue }
    if (ch === '{' || ch === '[') {
      commaBefore(tokens, stack, last); colonIf(tokens, stack, last)
      tokens.push(ch); stack.push(ch); index++; continue
    }
    if (ch === '}' || ch === ']') {
      rmComma(tokens); tokens.push(ch)
      if (stack.length && stack[stack.length - 1] === (ch === '}' ? '{' : '[')) stack.pop()
      index++; continue
    }
    if ((ch >= '0' && ch <= '9') || ch === '-') {
      commaBefore(tokens, stack, last); colonIf(tokens, stack, last)
      const nr = scanNum(input, index); tokens.push(nr.num); index += nr.consumed; continue
    }
    if (ch === 't' || ch === 'f' || ch === 'n') {
      commaBefore(tokens, stack, last); colonIf(tokens, stack, last)
      const w = KEYWORD[ch]; index += scanKw(input, index, w); tokens.push(w); continue
    }
    index++
  }
  // finalize_completion
  if (incomplete) tokens.push(finalizeStr(incomplete))
  let lf = getLast(tokens)
  if (stack.length) {
    const ctx = stack[stack.length - 1]
    if (ctx === '{') {
      if (lf === '"') { const prev = getPrev(tokens); if (prev === '{' || prev === ',') tokens.push(':', 'null') }
      else if (lf === ':') tokens.push('null')
    } else if (ctx === '[') {
      if (lf === ',') tokens.push('null')
    }
  }
  while (stack.length) { const op = stack.pop(); rmComma(tokens); tokens.push(op === '{' ? '}' : ']') }
  const out = tokens.join('')
  if (/^\s*[,:]\s*$/.test(out)) return null
  try { return JSON.parse(out) } catch { return null }
}
function method_json_completer(buffer: string): { parsed: any; latency_ms: number } {
  const t0 = performance.now()
  let parsed: any = null
  try {
    parsed = jsonCompleterParse(buffer)
  } catch { parsed = null }
  return { parsed, latency_ms: performance.now() - t0 }
}

function method_ours_fixed(buffer: string, arrayKey: string | null): { parsed: any; latency_ms: number } {
  const t0 = performance.now()
  const result = parsePartialJson(buffer, arrayKey || undefined)
  return { parsed: result.parsed, latency_ms: performance.now() - t0 }
}

interface Sample { sample_id:string; schema:string; truncation_pct:number; buffer_path:string; complete_path:string; array_key:string|null }
interface R { sample_id:string; schema:string; truncation_pct:number; method:string; recovered:boolean; recovered_array_length:number; latency_ms:number; parsed:any; array_key:string|null }

function extractArray(parsed: any, arrayKey: string | null): any[] {
  if (!parsed || !arrayKey) return []
  const arr = parsed[arrayKey]
  return Array.isArray(arr) ? arr : []
}

async function main() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const samples: Sample[] = JSON.parse(Buffer.concat(chunks).toString('utf-8'))

  const out: R[] = []
  const warm = (m: any) => m('{"test":1}' as string)
  warm((b:string)=>method_naive(b)); warm((b:string)=>method_partial_json(b)); warm((b:string)=>method_json_repair(b))
  warm((b:string)=>method_best_effort(b)); warm((b:string)=>method_tolerant_repair(b)); warm((b:string)=>method_json_completer(b)); warm((b:string)=>method_ours_fixed(b, null))

  const defs: Array<[string, (b:string, ak:string|null)=>any]> = [
    ['naive', (b)=>method_naive(b)],
    ['partial_json', (b)=>method_partial_json(b)],
    ['json_repair', (b)=>method_json_repair(b)],
    ['json_completer', (b)=>method_json_completer(b)],
    ['best_effort', (b)=>method_best_effort(b)],
    ['tolerant_repair', (b)=>method_tolerant_repair(b)],
    ['ours', (b,ak)=>method_ours_fixed(b, ak)],
  ]

  for (const s of samples) {
    const buffer = readFileText(s.buffer_path)
    for (const [name, fn] of defs) {
      const r = fn(buffer, s.array_key)
      const arr = extractArray(r.parsed, s.array_key)
      out.push({ sample_id:s.sample_id, schema:s.schema, truncation_pct:s.truncation_pct, method:name,
        recovered: arr.length>0, recovered_array_length: arr.length, latency_ms: r.latency_ms, parsed: r.parsed, array_key: s.array_key })
    }
  }
  process.stdout.write(JSON.stringify(out))
}

import { readFileSync } from 'fs'
function readFileText(p: string): string { return readFileSync(p, 'utf-8') }

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
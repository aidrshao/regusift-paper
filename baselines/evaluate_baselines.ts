/**
 * 统一基线对比评估脚本（V2 修复版 + 完整外部基线）
 * ==================================================
 * 在同一次周转中评估：
 *   B1 naive (JSON.parse)
 *   B2 partial-json (npm)
 *   B3 json-repair (npm)
 *   B4 JsonCompleter (按论文语义复现有状态增量)
 *   B6 best-effort-json-parser (npm)
 *   B7 llm-json-repair tolerantParse (npm)
 *   Ours (V2 修复版 parsePartialJson)
 * 全部在同一 V8 沙箱运行，保证等值可复现。
 * 输出 stdin->JSON array of samples, stdout->results。
 */
import { parsePartialJson } from '../src/partial-json-parser'
import { parse as parsePartialJsonLib } from 'partial-json'
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
  try { const A = { STR:1,NUM:2,OBJ:4,ARR:8,BOOL:16,NULL:32 }; parsed = parsePartialJsonLib(buffer, A.STR|A.NUM|A.OBJ|A.ARR|A.BOOL|A.NULL) } catch { parsed = null }
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
 * B4 JsonCompleter 语义复现（有状态增量解析）
 * 核心: 单遍扫描维护 <inString, escape, 深度栈>, 遇截断时基于栈顶闭合最小必要结构。
 * 本质是 O(n) 状态机式最佳努力，返回 {objSoFar} 或 null。
 * 这里实现为优雅的"有状态单遍补全"，反映该路线的恢复能力上限。
 */
function method_json_completer(buffer: string): { parsed: any; latency_ms: number } {
  const t0 = performance.now()
  let parsed: any = null
  try {
    parsed = jsonCompleterParse(buffer)
  } catch { parsed = null }
  return { parsed, latency_ms: performance.now() - t0 }
}
function jsonCompleterParse(text: string): any {
  const stripped = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  // 先尝试完整解析
  try { return JSON.parse(stripped) } catch { /* fallthrough */ }
  // 有状态: 关闭未闭合字符串 + 按字符串感知闭合未闭合容器
  let inString = false, escape = false
  const stack: string[] = []
  for (const ch of stripped) {
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') { if (stack.length && stack[stack.length-1] === ch) stack.pop() }
  }
  let base = inString ? stripped + '"' : stripped
  // 处理尾部: 若以逗号结尾移除
  if (base.endsWith(',')) base = base.slice(0, -1).trimEnd()
  // 若以 " 结尾且是键名上下文(前是 { 或, 或:) 视情况: 这里只闭合结构, 不造幽灵键
  const close = stack.reverse().join('')
  try { return JSON.parse(base + close) } catch { return null }
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

  try { const m: any = require('jsonrepair'); repairJSON = m.jsonrepair || m.default?.jsonrepair || m.default } catch {}

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
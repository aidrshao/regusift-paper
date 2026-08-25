/**
 * 统一 Node.js 评估脚本 — V2 修复版
 * ==================================
 * ⊞ 与原 evaluate_all.ts 的区别:
 *   - 解析器取 V2 修复版 `src/partial-json-parser.ts`
 *     (消除幽灵键 + Layer3 字符串感知化)。
 *   - B1/B2/B3 基线保持不变, 同 V8 沙箱运行。
 *
 * 用法 (从 V2 目录执行):
 *   npx tsx baselines/evaluate_fixed.ts < input.json > output.json
 *
 * 输入 (stdin): JSON array of samples
 *   [{"sample_id": "...", "buffer_path": "...", "complete_path": "...", "array_key": "..."}]
 *
 * 输出 (stdout): JSON array of results
 *   [{"sample_id": "...", "method": "ours", "recovered": true, "parsed": {...}, "latency_ms": 0.123}, ...]
 */
import { parsePartialJson as parseFixed } from '../src/partial-json-parser'

// ★ 基线 B2: partial-json npm 包
import { parse as parsePartialJsonLib } from 'partial-json'

// ★ 基线 B3: jsonrepair npm 包 (在 main() 中同步 require)
let repairJSON: ((text: string) => string) | null = null

/** B1: 朴素丢弃 */
function method_naive(buffer: string): { parsed: any; latency_ms: number } {
  const t0 = performance.now()
  let parsed: any = null
  try {
    parsed = JSON.parse(buffer.trim())
  } catch {
    parsed = null
  }
  return { parsed, latency_ms: performance.now() - t0 }
}

/** B2: partial-json npm 库 */
function method_partial_json(buffer: string): { parsed: any; latency_ms: number } {
  const t0 = performance.now()
  let parsed: any = null
  try {
    const ALLOW = { STR: 1, NUM: 2, OBJ: 4, ARR: 8, BOOL: 16, NULL: 32 }
    parsed = parsePartialJsonLib(
      buffer,
      ALLOW.STR | ALLOW.NUM | ALLOW.OBJ | ALLOW.ARR | ALLOW.BOOL | ALLOW.NULL
    )
  } catch {
    parsed = null
  }
  return { parsed, latency_ms: performance.now() - t0 }
}

/** B3: json-repair npm 库 */
function method_json_repair(buffer: string): { parsed: any; latency_ms: number } {
  if (!repairJSON) return { parsed: null, latency_ms: 0 }
  const t0 = performance.now()
  let parsed: any = null
  try {
    const repaired = repairJSON(buffer)
    parsed = JSON.parse(repaired)
  } catch {
    parsed = null
  }
  return { parsed, latency_ms: performance.now() - t0 }
}

/** Ours (V2 修复版): 消除幽灵键 + Layer3 字符串感知化, 动态 arrayKey */
function method_ours_fixed(buffer: string, arrayKey: string | null): { parsed: any; latency_ms: number; was_truncated: boolean; used_recovery: boolean } {
  const t0 = performance.now()
  const result = parseFixed(buffer, arrayKey || undefined)
  return {
    parsed: result.parsed,
    latency_ms: performance.now() - t0,
    was_truncated: result.wasTruncated,
    used_recovery: result.recovered,
  }
}

interface Sample {
  sample_id: string
  schema: string
  truncation_pct: number
  buffer_path: string
  complete_path: string
  array_key: string | null
}

interface MethodResult {
  sample_id: string
  schema: string
  truncation_pct: number
  method: string
  recovered: boolean
  recovered_array_length: number
  latency_ms: number
  was_truncated?: boolean
  used_recovery?: boolean
  parsed: any
  array_key: string | null
}

function extractArray(parsed: any, arrayKey: string | null): any[] {
  if (!parsed || !arrayKey) return []
  const arr = parsed[arrayKey]
  return Array.isArray(arr) ? arr : []
}

async function main() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  const inputText = Buffer.concat(chunks).toString('utf-8')
  const samples: Sample[] = JSON.parse(inputText)

  try {
    const jsonRepairModule: any = require('jsonrepair')
    repairJSON = jsonRepairModule.jsonrepair || jsonRepairModule.default?.jsonrepair || jsonRepairModule.default
  } catch {
    console.error('[WARN] jsonrepair not installed. Run: pnpm add jsonrepair')
  }

  const allResults: MethodResult[] = []

  // 预热 V8 (JIT 编译)
  method_naive('{"test":1}')
  method_partial_json('{"test":1}')
  method_json_repair('{"test":1}')
  method_ours_fixed('{"test":1}', null)

  for (const sample of samples) {
    const buffer = readFileText(sample.buffer_path)
    const arrayKey = sample.array_key

    // B1
    {
      const r = method_naive(buffer)
      const arr = extractArray(r.parsed, arrayKey)
      allResults.push({
        sample_id: sample.sample_id, schema: sample.schema, truncation_pct: sample.truncation_pct,
        method: 'naive', recovered: arr.length > 0, recovered_array_length: arr.length,
        latency_ms: r.latency_ms, parsed: r.parsed, array_key: arrayKey,
      })
    }

    // B2
    {
      const r = method_partial_json(buffer)
      const arr = extractArray(r.parsed, arrayKey)
      allResults.push({
        sample_id: sample.sample_id, schema: sample.schema, truncation_pct: sample.truncation_pct,
        method: 'partial_json', recovered: arr.length > 0, recovered_array_length: arr.length,
        latency_ms: r.latency_ms, parsed: r.parsed, array_key: arrayKey,
      })
    }

    // B3
    {
      const r = method_json_repair(buffer)
      const arr = extractArray(r.parsed, arrayKey)
      allResults.push({
        sample_id: sample.sample_id, schema: sample.schema, truncation_pct: sample.truncation_pct,
        method: 'json_repair', recovered: arr.length > 0, recovered_array_length: arr.length,
        latency_ms: r.latency_ms, parsed: r.parsed, array_key: arrayKey,
      })
    }

    // Ours (V2 修复版)
    {
      const r = method_ours_fixed(buffer, arrayKey)
      const arr = extractArray(r.parsed, arrayKey)
      allResults.push({
        sample_id: sample.sample_id, schema: sample.schema, truncation_pct: sample.truncation_pct,
        method: 'ours', recovered: arr.length > 0, recovered_array_length: arr.length,
        latency_ms: r.latency_ms, was_truncated: r.was_truncated, used_recovery: r.used_recovery,
        parsed: r.parsed, array_key: arrayKey,
      })
    }
  }

  process.stdout.write(JSON.stringify(allResults))
}

import { readFileSync } from 'fs'
function readFileText(path: string): string {
  return readFileSync(path, 'utf-8')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
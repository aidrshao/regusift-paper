/**
 * 统一 Node.js 评估脚本 — 4 种方法对比
 * =======================================
 *
 * 论文模块: §5 实验设计, 表 7 (恢复率), 表 8 (字段 F1)
 *
 * 直接 import 生产环境 TypeScript 代码, 4 种方法在同一 V8 引擎中运行,
 * 消除跨语言对比偏差。所有评估基于预采集的 LLM 完整输出文件,
 * 与 API 传输层完全无关。
 *
 * 用法 (从本仓库根目录执行):
 *   npx tsx baselines/evaluate_all.ts < input.json > output.json
 *
 * 输入 (stdin): JSON array of samples
 *   [{"sample_id": "...", "buffer_path": "...", "array_key": "..."}]
 *
 * 输出 (stdout): JSON array of results
 *   [{"sample_id": "...", "method": "ours", "recovered": true, "parsed": {...}, "latency_ms": 0.123}, ...]
 *
 * 依赖:
 *   - 本仓库 src/partial-json-parser.ts (所提方法)
 *   - partial-json (npm, 基线 B2)
 *   - jsonrepair  (npm, 基线 B3)
 */

// ★ 所提方法: 本仓库 src/partial-json-parser.ts
import { parsePartialJson } from '../src/partial-json-parser'

// ★ 基线 B2: partial-json npm 包
import { parse as parsePartialJsonLib } from 'partial-json'

// ★ 基线 B3: jsonrepair npm 包 (ESM 静态导入, 避免 require 在 ESM 下不可用)
import { jsonrepair as repairJSON } from 'jsonrepair'

// ── 方法定义 ──

/** B1: 朴素丢弃 */
function method_naive(buffer: string): { parsed: unknown; latency_ms: number } {
  const t0 = performance.now()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(buffer.trim())
  } catch {
    parsed = null
  }
  return { parsed, latency_ms: performance.now() - t0 }
}

/** B2: partial-json npm 库 */
function method_partial_json(buffer: string): { parsed: unknown; latency_ms: number } {
  const t0 = performance.now()
  let parsed: unknown = null
  try {
    const ALLOW = { STR: 1, NUM: 2, OBJ: 4, ARR: 8, BOOL: 16, NULL: 32 }
    parsed = parsePartialJsonLib(
      buffer,
      ALLOW.STR | ALLOW.NUM | ALLOW.OBJ | ALLOW.ARR | ALLOW.BOOL | ALLOW.NULL,
    )
  } catch {
    parsed = null
  }
  return { parsed, latency_ms: performance.now() - t0 }
}

/** B3: json-repair npm 库 */
function method_json_repair(buffer: string): { parsed: unknown; latency_ms: number } {
  const t0 = performance.now()
  let parsed: unknown = null
  try {
    const repaired = repairJSON(buffer)
    parsed = JSON.parse(repaired)
  } catch {
    parsed = null
  }
  return { parsed, latency_ms: performance.now() - t0 }
}

/** Ours: 三层渐进截断恢复 (动态 arrayKey) */
function method_ours(
  buffer: string,
  arrayKey: string | null,
): { parsed: unknown; latency_ms: number; was_truncated: boolean; used_recovery: boolean } {
  const t0 = performance.now()
  const result = parsePartialJson(buffer, arrayKey || undefined)
  return {
    parsed: result.parsed,
    latency_ms: performance.now() - t0,
    was_truncated: result.wasTruncated,
    used_recovery: result.recovered,
  }
}

// ── 主逻辑 ──

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
  parsed: unknown
  array_key: string | null
}

function extractArray(parsed: unknown, arrayKey: string | null): unknown[] {
  if (!parsed || !arrayKey) return []
  const arr = (parsed as Record<string, unknown>)[arrayKey]
  return Array.isArray(arr) ? arr : []
}

async function main() {
  // 读取 stdin
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  const inputText = Buffer.concat(chunks).toString('utf-8')
  const samples: Sample[] = JSON.parse(inputText)

  const allResults: MethodResult[] = []

  // 预热 V8 (JIT 编译)
  method_naive('{"test":1}')
  method_partial_json('{"test":1}')
  method_json_repair('{"test":1}')
  method_ours('{"test":1}', null)

  for (const sample of samples) {
    const buffer = readFileText(sample.buffer_path)
    const arrayKey = sample.array_key

    // B1: Naive
    {
      const r = method_naive(buffer)
      const arr = extractArray(r.parsed, arrayKey)
      allResults.push({
        sample_id: sample.sample_id, schema: sample.schema, truncation_pct: sample.truncation_pct,
        method: 'naive', recovered: arr.length > 0, recovered_array_length: arr.length,
        latency_ms: r.latency_ms, parsed: r.parsed, array_key: arrayKey,
      })
    }

    // B2: partial-json
    {
      const r = method_partial_json(buffer)
      const arr = extractArray(r.parsed, arrayKey)
      allResults.push({
        sample_id: sample.sample_id, schema: sample.schema, truncation_pct: sample.truncation_pct,
        method: 'partial_json', recovered: arr.length > 0, recovered_array_length: arr.length,
        latency_ms: r.latency_ms, parsed: r.parsed, array_key: arrayKey,
      })
    }

    // B3: json-repair
    {
      const r = method_json_repair(buffer)
      const arr = extractArray(r.parsed, arrayKey)
      allResults.push({
        sample_id: sample.sample_id, schema: sample.schema, truncation_pct: sample.truncation_pct,
        method: 'json_repair', recovered: arr.length > 0, recovered_array_length: arr.length,
        latency_ms: r.latency_ms, parsed: r.parsed, array_key: arrayKey,
      })
    }

    // Ours
    {
      const r = method_ours(buffer, arrayKey)
      const arr = extractArray(r.parsed, arrayKey)
      allResults.push({
        sample_id: sample.sample_id, schema: sample.schema, truncation_pct: sample.truncation_pct,
        method: 'ours', recovered: arr.length > 0, recovered_array_length: arr.length,
        latency_ms: r.latency_ms, was_truncated: r.was_truncated, used_recovery: r.used_recovery,
        parsed: r.parsed, array_key: arrayKey,
      })
    }
  }

  // 输出结果到 stdout
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

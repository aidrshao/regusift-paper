/**
 * TTPF (Time To First Parsable Field) 实测脚本
 * ==============================================
 *
 * 论文模块: §4.8 工业案例, 表 8
 *
 * 对 supplement_facts 场景实测两种模式的端到端延迟:
 *   - Before (stream: false): 等待完整响应后才解析, TTPF = 总生成时间
 *   - After  (stream: true + parsePartialJson + ICover): 流式增量解析,
 *           TTPF = 首个 ingredient 可解析时刻
 *
 * 每种模式跑 N=20 次, 输出 P50/P95/均值, 对应论文表 8。
 *
 * 用法 (从本仓库根目录执行):
 *   npx tsx baselines/measure_ttpf.ts                    # 默认 20 次
 *   npx tsx baselines/measure_ttpf.ts --iterations 10    # 10 次
 *
 * 环境变量:
 *   OPENAI_API_KEY=sk-xxx  (或你的 LLM 代理 key)
 */
import { parsePartialJson } from '../src/partial-json-parser'

const MODEL = 'gpt-5.4-mini'
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
const API_KEY = process.env.OPENAI_API_KEY || ''

const PROMPT = `You are a nutrition label generator. Generate a realistic FDA Supplement Facts label as JSON.
Include 8-15 supplement ingredients with name, amount, unit, and %DV.
Also include meta fields: productName, servingSize, servingsPerContainer.
Return ONLY valid JSON, no markdown fences.

Schema:
{
  "productName": string,
  "servingSize": string,
  "servingsPerContainer": number,
  "ingredients": [
    {"name": string, "amount": string, "unit": string, "dailyValue": string}
  ]
}`

interface TTPFResult {
  mode: 'before' | 'after'
  iteration: number
  ttft_ms: number        // 首个 ingredient 可解析时刻 (before 模式 = 完成时间)
  total_ms: number       // 流式完成总时间
  first_ingredient_name: string | null
  ingredient_count_at_ttft: number
  final_ingredient_count: number
  response_length: number
}

// ── 非流式调用 (Before 模式) ──
async function measureNonStreaming(iteration: number): Promise<TTPFResult> {
  const url = `${BASE_URL}/chat/completions`
  const headers = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: PROMPT }],
    stream: false,
    temperature: 0.7,
  }

  const start = Date.now()
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
  const total_ms = Date.now() - start

  const content = data?.choices?.[0]?.message?.content || ''
  let firstIngredientName: string | null = null
  let ingredientCount = 0
  // 走真实恢复管线 (stripMarkdownJsonFence + 三层恢复) 统计, 与生产行为一致
  const res = parsePartialJson(content, 'ingredients')
  const parsed = res.parsed as { ingredients?: Array<{ name?: string }> } | null
  if (parsed && Array.isArray(parsed.ingredients) && parsed.ingredients.length > 0) {
    firstIngredientName = parsed.ingredients[0]?.name || null
    ingredientCount = parsed.ingredients.length
  }

  // Before 模式: TTPF = 完成时间 (用户必须等待全部生成)
  return {
    mode: 'before',
    iteration,
    ttft_ms: total_ms,
    total_ms,
    first_ingredient_name: firstIngredientName,
    ingredient_count_at_ttft: ingredientCount,
    final_ingredient_count: ingredientCount,
    response_length: content.length,
  }
}

// ── 流式调用 + parsePartialJson (After 模式) ──
async function measureStreaming(iteration: number): Promise<TTPFResult> {
  const url = `${BASE_URL}/chat/completions`
  const headers = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: PROMPT }],
    stream: true,
    temperature: 0.7,
  }

  const start = Date.now()
  let buffer = ''
  let ttft_ms = 0
  let firstIngredientName: string | null = null
  let ingredientCountAtTtft = 0
  let foundFirst = false

  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const reader = resp.body?.getReader()
  if (!reader) throw new Error('No response body reader')

  const decoder = new TextDecoder()
  let done = false
  while (!done) {
    const { value, done: readerDone } = await reader.read()
    done = readerDone
    if (value) {
      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n')
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') { done = true; break }
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>
          }
          const delta = parsed?.choices?.[0]?.delta?.content || ''
          if (delta) {
            buffer += delta
            // 尝试增量解析 — 只有还没找到首个 ingredient 时才尝试
            if (!foundFirst) {
              const result = parsePartialJson(buffer, 'ingredients')
              if (result.parsed && typeof result.parsed === 'object') {
                const ings = (result.parsed as { ingredients?: Array<{ name?: string }> }).ingredients
                if (Array.isArray(ings) && ings.length > 0 && ings[0]?.name) {
                  ttft_ms = Date.now() - start
                  firstIngredientName = String(ings[0].name || '')
                  ingredientCountAtTtft = ings.length
                  foundFirst = true
                }
              }
            }
          }
        } catch { /* ignore parse errors */ }
      }
    }
  }

  const total_ms = Date.now() - start

  // 统计最终 ingredient 数量: 走真实恢复管线 (stripMarkdownJsonFence + 三层恢复 + ICover 终态),
  // 与生产行为一致; 不用严格 JSON.parse(全量响应) (后者遇 markdown 围栏/尾随文本即抛错计 0)
  let finalIngredientCount = 0
  const finalResult = parsePartialJson(buffer, 'ingredients')
  const finalParsed = finalResult.parsed as { ingredients?: unknown[] } | null
  if (finalParsed && Array.isArray(finalParsed.ingredients)) {
    finalIngredientCount = finalParsed.ingredients.length
  }

  // 如果整个流式过程都没解析出首个 ingredient, TTPF = 总时间 (fallback)
  if (!foundFirst) {
    ttft_ms = total_ms
  }

  return {
    mode: 'after',
    iteration,
    ttft_ms,
    total_ms,
    first_ingredient_name: firstIngredientName,
    ingredient_count_at_ttft: ingredientCountAtTtft,
    final_ingredient_count: finalIngredientCount,
    response_length: buffer.length,
  }
}

// ── 统计工具 ──
function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(p * sorted.length) - 1
  return sorted[Math.max(0, idx)] ?? 0
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length
  return {
    mean: Math.round(mean),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

// ── 主函数 ──
async function main() {
  const args = process.argv.slice(2)
  let iterations = 20
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iterations' && args[i + 1]) {
      iterations = parseInt(args[i + 1], 10)
    }
  }

  if (!API_KEY) {
    console.error('ERROR: OPENAI_API_KEY environment variable not set')
    process.exit(1)
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`TTPF Measurement — ${MODEL} via ${BASE_URL}`)
  console.log(`Iterations: ${iterations} per mode`)
  console.log(`${'='.repeat(60)}\n`)

  const beforeResults: TTPFResult[] = []
  const afterResults: TTPFResult[] = []

  // 交替运行 before/after 以平衡网络波动
  for (let i = 0; i < iterations; i++) {
    console.log(`[${i + 1}/${iterations}] Measuring BEFORE (non-streaming)...`)
    try {
      const r = await measureNonStreaming(i)
      beforeResults.push(r)
      console.log(`  TTPF=${r.ttft_ms}ms, total=${r.total_ms}ms, ings=${r.final_ingredient_count}`)
    } catch (e) {
      console.error(`  FAILED: ${(e as Error).message}`)
    }

    console.log(`[${i + 1}/${iterations}] Measuring AFTER (streaming + parsePartialJson)...`)
    try {
      const r = await measureStreaming(i)
      afterResults.push(r)
      console.log(`  TTPF=${r.ttft_ms}ms, total=${r.total_ms}ms, firstIng="${r.first_ingredient_name}", ingsAtTTPF=${r.ingredient_count_at_ttft}/${r.final_ingredient_count}`)
    } catch (e) {
      console.error(`  FAILED: ${(e as Error).message}`)
    }
  }

  // 统计
  const beforeTTPF = beforeResults.map(r => r.ttft_ms)
  const afterTTPF = afterResults.map(r => r.ttft_ms)
  const beforeTotal = beforeResults.map(r => r.total_ms)
  const afterTotal = afterResults.map(r => r.total_ms)

  const beforeStats = stats(beforeTTPF)
  const afterStats = stats(afterTTPF)
  const beforeTotalStats = stats(beforeTotal)
  const afterTotalStats = stats(afterTotal)

  console.log(`\n${'='.repeat(60)}`)
  console.log('RESULTS SUMMARY')
  console.log(`${'='.repeat(60)}\n`)

  console.log('┌─────────────────────────────────────────────────────────┐')
  console.log('│ TTPF (Time To First Ingredient)                         │')
  console.log('├──────────────────┬──────────┬──────────┬──────────────────┤')
  console.log('│ Mode             │    P50   │    P95   │   Mean           │')
  console.log('├──────────────────┼──────────┼──────────┼──────────────────┤')
  console.log(`│ Before (no str)  │ ${String(beforeStats.p50).padStart(6)}ms│ ${String(beforeStats.p95).padStart(6)}ms│ ${String(beforeStats.mean).padStart(6)}ms         │`)
  console.log(`│ After (stream)   │ ${String(afterStats.p50).padStart(6)}ms│ ${String(afterStats.p95).padStart(6)}ms│ ${String(afterStats.mean).padStart(6)}ms         │`)
  console.log('└──────────────────┴──────────┴──────────┴──────────────────┘')

  const speedup = beforeStats.mean / afterStats.mean
  console.log(`\nTTPF Improvement: ${speedup.toFixed(2)}x (mean), ${(beforeStats.p50 / afterStats.p50).toFixed(2)}x (P50)`)

  console.log(`\n┌─────────────────────────────────────────────────────────┐`)
  console.log('│ Total Generation Time                                   │')
  console.log('├──────────────────┬──────────┬──────────┬──────────────────┤')
  console.log('│ Mode             │    P50   │    P95   │   Mean           │')
  console.log('├──────────────────┼──────────┼──────────┼──────────────────┤')
  console.log(`│ Before (no str)  │ ${String(beforeTotalStats.p50).padStart(6)}ms│ ${String(beforeTotalStats.p95).padStart(6)}ms│ ${String(beforeTotalStats.mean).padStart(6)}ms         │`)
  console.log(`│ After (stream)   │ ${String(afterTotalStats.p50).padStart(6)}ms│ ${String(afterTotalStats.p95).padStart(6)}ms│ ${String(afterTotalStats.mean).padStart(6)}ms         │`)
  console.log('└──────────────────┴──────────┴──────────┴──────────────────┘')

  // 保存原始数据
  const output = {
    model: MODEL,
    base_url: BASE_URL,
    iterations,
    timestamp: new Date().toISOString(),
    summary: {
      before: { ttft: beforeStats, total: beforeTotalStats },
      after: { ttft: afterStats, total: afterTotalStats },
      improvement: {
        ttft_speedup_mean: parseFloat(speedup.toFixed(2)),
        ttft_speedup_p50: parseFloat((beforeStats.p50 / afterStats.p50).toFixed(2)),
        ttft_reduction_ms: beforeStats.mean - afterStats.mean,
      },
    },
    raw_results: { before: beforeResults, after: afterResults },
  }

  const outputPath = './results/ttpf_measurement.json'
  const { writeFileSync, mkdirSync } = await import('fs')
  try { mkdirSync('./results', { recursive: true }) } catch { /* ignore */ }
  writeFileSync(outputPath, JSON.stringify(output, null, 2))
  console.log(`\nRaw data saved to: ${outputPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })

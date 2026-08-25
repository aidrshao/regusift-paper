/**
 * TTPF 增补实验: 扩充流式逐块基线 (best-effort / llm-json-repair)
 * ============================================================
 * 同一会话内交错运行 4 种"流式逐块解析"模式, 各 20 次:
 *   mode2_partialjson   : 流式+partial-json 逐块
 *   mode2b_best_effort  : 流式+best-effort-json-parser 逐块
 *   mode2c_llmjsonrepair: 流式+llm-json-repair(repairJson) 逐块
 *   mode3_ours          : 流式+本文三层恢复 逐块
 * 与既有 mode1a(非流式)/mode1b(流式缓冲) 对照 (二者与解析器无关, 沿用既有会话数据)。
 * TTPF = 从请求发出到逐块解析首次得到 ingredients[0].name 的时刻。
 */
import { parsePartialJson } from '../src/partial-json-parser'
import { parse, Allow } from 'partial-json'
import { parse as beParse } from 'best-effort-json-parser'
import { repairJson } from 'llm-json-repair'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dir, '..')

function loadEnv(p: string) {
  try {
    const t = readFileSync(p, 'utf-8')
    for (const line of t.split('\n')) {
      const l = line.trim()
      if (!l || l.startsWith('#') || !l.includes('=')) continue
      const i = l.indexOf('='); const k = l.slice(0, i).trim(); const v = l.slice(i + 1).trim()
      if (!process.env[k]) process.env[k] = v
    }
  } catch { /* ignore */ }
}
loadEnv(join(ROOT, '.env'))

const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || ''

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

interface RR { mode: string; iteration: number; ttft_ms: number; total_ms: number; first: string | null; cnt_at: number; fin: number; len: number }

async function chatStream(onDelta: (delta: string, tms: number, acc: string) => void): Promise<{ full: string; timeline: { t_ms: number; acc_len: number; delta_len: number }[] }> {
  const t0 = Date.now()
  let full = ''
  const timeline: { t_ms: number; acc_len: number; delta_len: number }[] = []
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], stream: true, temperature: 0.7 }),
  })
  const reader = resp.body?.getReader()
  if (!reader) throw new Error('No reader')
  const decoder = new TextDecoder()
  let buf = ''
  let done = false
  while (!done) {
    const { value, done: d } = await reader.read()
    done = d
    if (value) {
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') { done = true; break }
        try {
          const j = JSON.parse(data)
          const delta = j?.choices?.[0]?.delta?.content || ''
          if (delta) {
            const tms = Date.now() - t0
            full += delta
            timeline.push({ t_ms: tms, acc_len: full.length, delta_len: delta.length })
            onDelta(delta, tms, full)
          }
        } catch { /* ignore */ }
      }
    }
  }
  return { full, timeline }
}

function firstIngredient(parsed: any): { name: string; count: number } | null {
  if (!parsed || typeof parsed !== 'object') return null
  const arr = Array.isArray(parsed) ? parsed : parsed.ingredients
  if (Array.isArray(arr) && arr.length && arr[0] && typeof arr[0] === 'object' && arr[0].name !== undefined) {
    return { name: String(arr[0].name), count: arr.length }
  }
  return null
}

const PARSERS: Record<string, (acc: string) => any> = {
  mode2_partialjson: (acc) => { try { return parse(acc, Allow.COLLECTION) } catch { return null } },
  mode2b_best_effort: (acc) => { try { return beParse(acc) } catch { return null } },
  mode2c_llmjsonrepair: (acc) => { try { const r: any = repairJson(acc); return r?.value ?? r } catch { return null } },
  mode3_ours: (acc) => { try { return parsePartialJson(acc, 'ingredients').parsed } catch { return null } },
}

async function main() {
  if (!API_KEY) { console.error('ERROR: no API key'); process.exit(1) }
  const MODES = ['mode2_partialjson', 'mode2b_best_effort', 'mode2c_llmjsonrepair', 'mode3_ours']
  const ITER = 20
  const results: Record<string, RR[]> = { mode2_partialjson: [], mode2b_best_effort: [], mode2c_llmjsonrepair: [], mode3_ours: [] }
  console.log(`TTPF 增补实验 — ${MODEL}, ${ITER}次/模式, 交错运行`)
  for (let i = 0; i < ITER; i++) {
    for (const mode of MODES) {
      let ttft = 0, found = false, first: string | null = null, cnt = 0
      const { full, timeline } = await chatStream((_d, tms, acc) => {
        if (found) return
        const p = PARSERS[mode](acc)
        const fi = firstIngredient(p)
        if (fi) { ttft = tms; first = fi.name; cnt = fi.count; found = true }
      })
      if (!found) ttft = timeline[timeline.length - 1]?.t_ms ?? 0
      let fin = 0
      try { const p = JSON.parse(full); if (Array.isArray(p.ingredients)) fin = p.ingredients.length } catch {}
      results[mode].push({ mode, iteration: i, ttft_ms: ttft, total_ms: timeline[timeline.length - 1]?.t_ms ?? 0, first, cnt_at: cnt, fin, len: full.length })
      console.log(`[iter ${i + 1}/${ITER}] ${mode} -> TTPF=${ttft}ms ${found ? 'FOUND' : '(末块)'}`)
    }
  }
  const tcrit: Record<number, number> = { 20: 2.093 }
  function sum(vals: number[]) {
    const n = vals.length, mean = vals.reduce((s, v) => s + v, 0) / n
    const sd = n > 1 ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0
    const half = tcrit[n] * sd / Math.sqrt(n)
    const sorted = [...vals].sort((a, b) => a - b)
    return { n, mean: +mean.toFixed(1), ci: [+(mean - half).toFixed(1), +(mean + half).toFixed(1)], p50: +sorted[Math.min(n - 1, 9)].toFixed(1), p95: +sorted[Math.min(n - 1, 18)].toFixed(1) }
  }
  const summary: Record<string, any> = {}
  console.log('\n==== 汇总 ====')
  for (const m of MODES) {
    const s = sum(results[m].map(r => r.ttft_ms))
    summary[m] = s
    console.log(`${m}: mean=${s.mean} CI=${s.ci} P50=${s.p50} P95=${s.p95} n=${s.n}`)
  }
  const outDir = join(ROOT, 'results', 'ttft')
  mkdirSync(outDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const base = `${MODEL.replace(/[^a-z0-9]/gi, '_')}_extra_${ts}`
  const rawPath = join(outDir, `${base}_raw.json`)
  writeFileSync(rawPath, JSON.stringify({ model: MODEL, base_url: BASE_URL, iterations: ITER, modes: MODES, results, summary }, null, 2))
  const slimPath = join(ROOT, 'results', `${base}_slim.json`)
  writeFileSync(slimPath, JSON.stringify({ model: MODEL, iterations: ITER, summary, slim_results: results, raw_file: rawPath.split('/').pop(), raw_sha256: createHash('sha256').update(readFileSync(rawPath)).digest('hex') }, null, 2))
  console.log('saved:', rawPath, '\nsha256:', slimPath)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })

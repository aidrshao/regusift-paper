/**
 * TTPF 参考模式补充: mode1a(非流式) / mode1b(流式缓冲) — 与 measure_ttft_extra 同日同模型
 * 二者与解析器无关, 作为非流式参考基线。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dir, '..')
function loadEnv(p: string) {
  try { const t = readFileSync(p, 'utf-8'); for (const l of t.split('\n')) { const s = l.trim(); if (!s || s.startsWith('#') || !s.includes('=')) continue; const i = s.indexOf('='); if (!process.env[s.slice(0, i).trim()]) process.env[s.slice(0, i).trim()] = s.slice(i + 1).trim() } } catch {}
}
loadEnv(join(ROOT, '.env'))
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const API_KEY = process.env.DEEPSEEK_API_KEY || ''

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

interface RR { mode: string; iteration: number; ttft_ms: number; total_ms: number; first: string | null; fin: number; len: number }

async function chat(mode: 'stream' | 'nonstream'): Promise<{ full: string; total: number }> {
  const t0 = Date.now()
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], stream: mode === 'stream', temperature: 0.7 }),
  })
  if (mode === 'nonstream') {
    const data: any = await resp.json()
    return { full: data?.choices?.[0]?.message?.content || '', total: Date.now() - t0 }
  }
  const reader = resp.body?.getReader(); if (!reader) throw new Error('no reader')
  const dec = new TextDecoder(); let full = ''; let buf = ''; let done = false
  while (!done) {
    const { value, done: d } = await reader.read(); done = d
    if (value) {
      buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim(); if (data === '[DONE]') { done = true; break }
        try { const j = JSON.parse(data); const dl = j?.choices?.[0]?.delta?.content || ''; if (dl) full += dl } catch {}
      }
    }
  }
  return { full, total: Date.now() - t0 }
}

async function main() {
  if (!API_KEY) { console.error('no key'); process.exit(1) }
  const results: Record<string, RR[]> = { mode1a_buffered: [], mode1b_stream_buffered: [] }
  for (let i = 0; i < 20; i++) {
    for (const m of ['mode1a_buffered', 'mode1b_stream_buffered']) {
      const { full, total } = await chat(m === 'mode1a_buffered' ? 'nonstream' : 'stream')
      let fin = 0, first: string | null = null
      try { const p = JSON.parse(full); if (Array.isArray(p.ingredients)) { fin = p.ingredients.length; first = p.ingredients[0]?.name ?? null } } catch {}
      results[m].push({ mode: m, iteration: i, ttft_ms: total, total_ms: total, first, fin, len: full.length })
      console.log(`[iter ${i + 1}/20] ${m} -> total=${total}ms fin=${fin}`)
    }
  }
  const tcrit: Record<number, number> = { 20: 2.093 }
  function sum(vals: number[]) { const n = vals.length, mean = vals.reduce((s, v) => s + v, 0) / n; const sd = n > 1 ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0; const half = tcrit[n] * sd / Math.sqrt(n); const s = [...vals].sort((a, b) => a - b); return { n, mean: +mean.toFixed(1), ci: [+(mean - half).toFixed(1), +(mean + half).toFixed(1)], p50: +s[9].toFixed(1), p95: +s[18].toFixed(1) } }
  const summary: any = {}
  console.log('\n==== 汇总 ====')
  for (const m of ['mode1a_buffered', 'mode1b_stream_buffered']) { summary[m] = sum(results[m].map(r => r.ttft_ms)); console.log(m, JSON.stringify(summary[m])) }
  const outDir = join(ROOT, 'results', 'ttft'); mkdirSync(outDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-'); const base = `${MODEL.replace(/[^a-z0-9]/gi, '_')}_ref_${ts}`
  const rawPath = join(outDir, `${base}_raw.json`); writeFileSync(rawPath, JSON.stringify({ model: MODEL, iterations: 20, results, summary }, null, 2))
  const slim = join(ROOT, 'results', `${base}_slim.json`); writeFileSync(slim, JSON.stringify({ model: MODEL, iterations: 20, summary, slim_results: results, raw_sha256: createHash('sha256').update(readFileSync(rawPath)).digest('hex') }, null, 2))
  console.log('saved:', slim)
}
main().catch(e => { console.error('Fatal:', e); process.exit(1) })

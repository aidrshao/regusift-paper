/**
 * GPT 归因双对照 (方案 A + 方案 B)
 * ============================================
 * 在 gpt-5.4-mini (经第三方兼容中转通道 dmxapi) 上统一完成 4 模式 TTPF 归因:
 *   mode1a_buffered    : 非流式 (缓冲到结束才解析)
 *   mode1b_stream_buff : 流式 (缓冲到结束才解析)  — 分离"流式本身"的收益
 *   mode2_partialjson  : 流式 + partial-json 逐块
 *   mode3_ours         : 流式 + 本文三层恢复 逐块
 * 与表 8 (生产 GPT) 同模型同通道, 消除"两条证据链模型不同"的质疑。
 * 方案 B: 含网络停顿重试协议 (透明记录) + 交错运行以平衡时段波动。
 *
 * 用法:
 *   OPENAI_API_KEY=... OPENAI_BASE_URL=https://www.dmxapi.cn/v1 \
 *   OPENAI_MODEL=gpt-5.4-mini npx tsx baselines/measure_ttpf_gpt.ts --iter=40
 */
import { parsePartialJson } from '../src/partial-json-parser'
import { parse, Allow } from 'partial-json'
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

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini'
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://www.dmxapi.cn/v1'
const API_KEY = process.env.OPENAI_API_KEY || ''

const ITER = parseInt(process.argv.find(a => a.startsWith('--iter='))?.split('=')[1] || '40', 10)
const MAX_RETRY = 2
const STALL_MS = 25000 // 网络停顿阈值: 超过则中断并重试

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface RR { mode: string; iteration: number; ttft_ms: number; total_ms: number; first: string | null; cnt_at: number; fin: number; len: number; retries: number }

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
  mode3_ours: (acc) => { try { return parsePartialJson(acc, 'ingredients').parsed } catch { return null } },
}

/** 非流式单次 */
async function runNonStream(): Promise<{ full: string; total: number }> {
  const t0 = Date.now()
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 60000)
  try {
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], stream: false, temperature: 0.7 }),
    })
    const data: any = await resp.json()
    return { full: data?.choices?.[0]?.message?.content || '', total: Date.now() - t0 }
  } finally { clearTimeout(timer) }
}

/** 流式单次: 返回 timeline, 检测网络停顿 */
async function runStream(onDelta: (delta: string, tms: number, acc: string) => void): Promise<{ full: string; timeline: { t_ms: number; acc_len: number; delta_len: number }[] }> {
  const t0 = Date.now()
  let full = ''
  const timeline: { t_ms: number; acc_len: number; delta_len: number }[] = []
  const ctl = new AbortController()
  const stallTimer = setInterval(() => { if (Date.now() - lastData > STALL_MS) ctl.abort() }, 5000)
  let lastData = Date.now()
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST', signal: ctl.signal,
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], stream: true, temperature: 0.7 }),
  })
  const reader = resp.body?.getReader()
  if (!reader) throw new Error('No reader')
  const decoder = new TextDecoder()
  let buf = '', done = false
  try {
    while (!done) {
      const { value, done: d } = await reader.read()
      done = d
      if (value) {
        lastData = Date.now()
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
  } finally { clearInterval(stallTimer) }
  return { full, timeline }
}

/** 带重试的测量 (方案 B: 网络停顿/错误 -> 重试, 透明记录) */
async function measure(mode: string): Promise<RR & { retries: number }> {
  let lastErr = ''
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      if (mode === 'mode1a_buffered') {
        const { full, total } = await runNonStream()
        let fin = 0, first: string | null = null
        try { const p = JSON.parse(full); if (Array.isArray(p.ingredients)) { fin = p.ingredients.length; first = p.ingredients[0]?.name ?? null } } catch {}
        return { mode, iteration: -1, ttft_ms: total, total_ms: total, first, cnt_at: fin, fin, len: full.length, retries: attempt }
      }
      // 流式模式
      let ttft = 0, found = false, first: string | null = null, cnt = 0
      const { full, timeline } = await runStream((_d, tms, acc) => {
        if (found) return
        if (mode === 'mode1b_stream_buff') return // 缓冲到结束, 不逐块
        const p = PARSERS[mode](acc)
        const fi = firstIngredient(p)
        if (fi) { ttft = tms; first = fi.name; cnt = fi.count; found = true }
      })
      const total = timeline[timeline.length - 1]?.t_ms ?? 0
      // mode1b: 流式缓冲到结束才解析 -> TTPF = 总完成时刻
      if (mode === 'mode1b_stream_buff') { ttft = total; found = true }
      if (!found && mode !== 'mode1b_stream_buff') ttft = total
      let fin = 0
      try { const p = JSON.parse(full); if (Array.isArray(p.ingredients)) fin = p.ingredients.length } catch {}
      return { mode, iteration: -1, ttft_ms: ttft, total_ms: total, first, cnt_at: cnt, fin, len: full.length, retries: attempt }
    } catch (e: any) {
      lastErr = e?.message || String(e)
      if (attempt < MAX_RETRY) { await sleep(3000 * (attempt + 1)); continue }
    }
  }
  throw new Error(`mode=${mode} 重试${MAX_RETRY}次仍失败: ${lastErr}`)
}

function main() {
  if (!API_KEY) { console.error('ERROR: OPENAI_API_KEY not set'); process.exit(1) }
  const MODES = ['mode1a_buffered', 'mode1b_stream_buff', 'mode2_partialjson', 'mode3_ours']
  const results: Record<string, RR[]> = { mode1a_buffered: [], mode1b_stream_buff: [], mode2_partialjson: [], mode3_ours: [] }
  let retryTotal = 0
  console.log(`[GPT归因] model=${MODEL} base=${BASE_URL} iter=${ITER}/模式 交错+重试(STALL>${STALL_MS}ms)`)
  ;(async () => {
    for (let i = 0; i < ITER; i++) {
      for (const mode of MODES) {
        const r = await measure(mode)
        r.iteration = i
        results[mode].push(r)
        retryTotal += r.retries
        console.log(`[iter ${i + 1}/${ITER}] ${mode} -> TTPF=${r.ttft_ms}ms total=${r.total_ms}ms first=${r.first} fin=${r.fin}${r.retries ? ` (重试${r.retries})` : ''}`)
      }
      await sleep(500) // 交错间小幅间隔, 避免突发拥塞 (方案 B)
    }
    // 汇总
    const tcrit: Record<number, number> = { 20: 2.093, 30: 2.045, 40: 2.023, 50: 2.009, 100: 1.984 }
    function sum(vals: number[]) {
      const n = vals.length, mean = vals.reduce((s, v) => s + v, 0) / n
      const sd = n > 1 ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0
      const tc = tcrit[n] ?? 2.0
      const half = tc * sd / Math.sqrt(n)
      const sorted = [...vals].sort((a, b) => a - b)
      const p50 = sorted[Math.floor((n - 1) * 0.5)], p95 = sorted[Math.min(n - 1, Math.ceil((n - 1) * 0.95))]
      return { n, mean: +mean.toFixed(1), ci: [+(mean - half).toFixed(1), +(mean + half).toFixed(1)], p50: +p50.toFixed(1), p95: +p95.toFixed(1), sd: +sd.toFixed(1) }
    }
    const summary: Record<string, any> = {}
    console.log('\n==== 汇总 ====')
    for (const m of MODES) { summary[m] = sum(results[m].map(r => r.ttft_ms)); console.log(`${m}: mean=${summary[m].mean} CI=${summary[m].ci} P50=${summary[m].p50} P95=${summary[m].p95} sd=${summary[m].sd} n=${summary[m].n}`) }
    // 配对 t (mode3 vs mode1a / mode3 vs mode1b / mode2 vs mode1b)
    function paired(a: number[], b: number[]) {
      const d = a.map((x, i) => x - b[i]); const n = d.length, dm = d.reduce((s, v) => s + v, 0) / n
      const sd = Math.sqrt(d.reduce((s, v) => s + (v - dm) ** 2, 0) / (n - 1))
      const t = dm / (sd / Math.sqrt(n)); return { dm: +dm.toFixed(1), t: +t.toFixed(2), p: (2 * tDist(t, n - 1)).toExponential(2) }
    }
    function tDist(t: number, df: number): number {
      // 近似 (Student t 尾概率, df 较大时用正态; 这里直接查表近似)
      const z = Math.abs(t); const p = Math.exp(-0.717 * z - 0.416 * z * z); return Math.min(1, p)
    }
    const A = results['mode3_ours'].map(r => r.ttft_ms), A1 = results['mode1a_buffered'].map(r => r.ttft_ms), B = results['mode1b_stream_buff'].map(r => r.ttft_ms), P = results['mode2_partialjson'].map(r => r.ttft_ms)
    const pairs: [string, number[], number[]][] = [
      ['mode3 vs mode1a', A, A1], ['mode3 vs mode1b', A, B], ['mode2 vs mode1b', P, B], ['mode3 vs mode2', A, P],
    ]
    console.log('\n==== 配对 t 检验 ====')
    for (const [name, x, y] of pairs) { const r = paired(x, y); console.log(`${name}: Δmean=${r.dm} t=${r.t} p≈${r.p}`) }
    // 保存
    const outDir = join(ROOT, 'results', 'ttft'); mkdirSync(outDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const base = `${MODEL.replace(/[^a-z0-9]/gi, '_')}_attribution_${ts}`
    const rawPath = join(outDir, `${base}_raw.json`)
    writeFileSync(rawPath, JSON.stringify({ model: MODEL, base_url: BASE_URL, iterations: ITER, modes: MODES, max_retry: MAX_RETRY, retry_total: retryTotal, results, summary }, null, 2))
    console.log('\nsaved:', rawPath, '\nretry_total =', retryTotal)
  })().catch(e => { console.error('Fatal:', e); process.exit(1) })
}
main()

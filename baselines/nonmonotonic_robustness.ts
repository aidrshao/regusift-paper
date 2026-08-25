/**
 * D2 实验 B: 幽灵键注入鲁棒性测试 (nonmonotonic_robustness.ts)
 * ===========================================================
 * 场景: 宽松/退化解析器在流式截断时对"不完整键名"补造幽灵键 (如 "am" -> "am": null),
 *       随后真实键名补全 ("amount"), 幽灵键 "am" 从解析输出中消失 —— 键集非单调。
 * 对比 3 种消费协议在前端 store 上的终态行为:
 *   - ICover(全量覆盖)   : 每块推送完整数组, 消费方覆盖 -> 幽灵键被后续覆盖清除
 *   - 无删除字段级 diff   : 仅对新增/变化字段做 add/update, 不删除 -> 幽灵键残留
 *   - 含删除字段级 diff   : 每元素按最新键集替换 (处理删除) -> 收敛 (诚实对照组)
 * 指标: 幽灵字段残留率 / 终态元素级收敛率 (按 Schema 与总体)。
 *
 * 用法: npx tsx baselines/nonmonotonic_robustness.ts [--samples 30] [--chunk 8]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dir, '..')
const DATA = join(ROOT, 'data', 'llm_outputs')

const SAMPLES = parseInt(process.argv.find(a => a.startsWith('--samples='))?.split('=')[1] || '30', 10)
const CHUNK = parseInt(process.argv.find(a => a.startsWith('--chunk='))?.split('=')[1] || '8', 10)

/** 从解析对象中取"目标数组" (取第一个顶层数组) */
function targetArray(parsed: any): any[] | null {
  if (!parsed || typeof parsed !== 'object') return null
  for (const v of Object.values(parsed)) {
    if (Array.isArray(v)) return v
  }
  return null
}

/** 关闭未闭合的字符串/括号, 返回可 parse 的候选 */
function closeTail(buf: string): string {
  let s = buf
  // 关闭未闭合字符串
  const inStr = (t: string) => { let q = false, esc = false; for (const c of t) { if (esc) { esc = false; continue } if (c === '\\') { esc = true; continue } if (c === '"') q = !q } return q }
  if (inStr(s)) s += '"'
  // 按 LIFO 补右括号
  const stack: string[] = []
  let inQ = false, esc = false
  for (const c of s) {
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inQ = !inQ; continue }
    if (inQ) continue
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']')
    else if (c === '}' || c === ']') { const e = stack.pop(); if (e !== c) return s /* 不匹配, 放弃 */ }
  }
  while (stack.length) s += stack.pop()!
  return s
}

/** 幽灵键注入解析器: 对"键名位置"的不完整键名补造 "<key>": null */
function ghostParse(buffer: string): any {
  const strict = tryParse(buffer)
  if (strict !== null) return strict
  // 检测尾部不完整键名 (键名位置: 引号前(去空白)是 { 或 , )
  const m = /"([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(buffer)
  if (m) {
    const pre = buffer.slice(0, m.index).replace(/\s+$/, '')
    if (pre.endsWith('{') || pre.endsWith(',')) {
      const partial = m[1]
      const fabricated = buffer.slice(0, m.index) + `"${partial}": null`
      const cand = closeTail(fabricated)
      const r = tryParse(cand)
      if (r !== null) return r
    }
  }
  // 否则普通闭合恢复
  const r = tryParse(closeTail(buffer))
  return r
}

function tryParse(s: string): any {
  try { return JSON.parse(s) } catch { return null }
}

/** 无删除字段级 diff: 仅 add/update, 不删除消失的键 */
function applyDiffNoDelete(store: any[], fresh: any[]): void {
  for (let i = 0; i < fresh.length; i++) {
    const f = fresh[i]
    if (!f || typeof f !== 'object') continue
    if (!store[i]) store[i] = {}
    for (const [k, v] of Object.entries(f)) {
      store[i][k] = v // add/update, 绝不删除
    }
  }
  // 元素数取较大者, 不做截断处理 (避免掩盖幽灵键)
}

/** 含删除字段级 diff: 每元素按最新键集整体替换 (处理删除) */
function applyDiffWithDelete(store: any[], fresh: any[]): void {
  for (let i = 0; i < fresh.length; i++) {
    const f = fresh[i]
    if (!f || typeof f !== 'object') continue
    store[i] = { ...f } // 整体替换 = 含删除
  }
}

interface SampleMetrics {
  schema: string
  sample: string
  icover: { ghost: number; converged: boolean; ghostRate: number }
  diffNoDel: { ghost: number; converged: boolean; ghostRate: number }
  diffWithDel: { ghost: number; converged: boolean; ghostRate: number }
}

function run() {
  const files = readdirSync(DATA).filter(f => f.endsWith('_complete.json'))
  const bySchema: Record<string, string[]> = {}
  for (const f of files) {
    const schema = f.split('_gpt')[0] // 完整 Schema 名 (如 financial_report)
    if (!bySchema[schema]) bySchema[schema] = []
    bySchema[schema].push(f)
  }
  const picked: string[] = []
  for (const schema of Object.keys(bySchema)) {
    picked.push(...bySchema[schema].slice(0, SAMPLES))
  }
  console.log(`样本: ${picked.length} (每 Schema ≤${SAMPLES}), chunk=${CHUNK}`)
  const metrics: SampleMetrics[] = []
  let totalGhostICover = 0, totalGhostNoDel = 0, totalGhostWithDel = 0, totalTrueKeys = 0
  let convICover = 0, convNoDel = 0, convWithDel = 0
  let nArr = 0

  for (const f of picked) {
    const schema = f.split('_gpt')[0]
    let parsed: any
    try { parsed = JSON.parse(readFileSync(join(DATA, f), 'utf-8')) } catch { continue } // 跳过无效样本
    const trueArr = targetArray(parsed)
    if (!trueArr || trueArr.length === 0) continue
    const raw = JSON.stringify(parsed)
    // 模拟流式: 逐 chunk 累积 (确保末块覆盖完整原文)
    let storeIc: any[] = [], storeNd: any[] = [], storeWd: any[] = []
    for (let pos = CHUNK; pos < raw.length + CHUNK; pos += CHUNK) {
      const buf = raw.slice(0, Math.min(pos, raw.length))
      const gp = ghostParse(buf)
      const arr = targetArray(gp)
      if (!arr) continue
      storeIc = arr.map(x => ({ ...x })) // ICover 全量覆盖
      applyDiffNoDelete(storeNd, arr)
      applyDiffWithDelete(storeWd, arr)
    }
    // 终态对比
    const gt = trueArr
    function evalStore(store: any[]) {
      let ghost = 0
      for (let i = 0; i < gt.length; i++) {
        const s = store[i] || {}, g = gt[i] || {}
        for (const k of Object.keys(s)) if (!(k in g)) ghost++
      }
      const converged = JSON.stringify(store.slice(0, gt.length)) === JSON.stringify(gt)
      const ghostRate = ghost / Math.max(1, Object.keys(gt[0] || {}).length)
      return { ghost, converged, ghostRate }
    }
    const mIc = evalStore(storeIc), mNd = evalStore(storeNd), mWd = evalStore(storeWd)
    metrics.push({ schema, sample: f, icover: mIc, diffNoDel: mNd, diffWithDel: mWd })
    totalGhostICover += mIc.ghost; totalGhostNoDel += mNd.ghost; totalGhostWithDel += mWd.ghost
    totalTrueKeys += Math.max(1, Object.keys(gt[0] || {}).length)
    if (mIc.converged) convICover++; if (mNd.converged) convNoDel++; if (mWd.converged) convWithDel++
    nArr++
  }
  // 汇总
  const perSchema: Record<string, any> = {}
  for (const m of metrics) {
    if (!perSchema[m.schema]) perSchema[m.schema] = { n: 0, icoverGhost: 0, ndGhost: 0, wdGhost: 0, icoverConv: 0, ndConv: 0, wdConv: 0 }
    perSchema[m.schema].n++
    perSchema[m.schema].icoverGhost += m.icover.ghost
    perSchema[m.schema].ndGhost += m.diffNoDel.ghost
    perSchema[m.schema].wdGhost += m.diffWithDel.ghost
    if (m.icover.converged) perSchema[m.schema].icoverConv++
    if (m.diffNoDel.converged) perSchema[m.schema].ndConv++
    if (m.diffWithDel.converged) perSchema[m.schema].wdConv++
  }
  console.log('\n==== 幽灵键注入鲁棒性 (按 Schema) ====')
  console.log('Schema        n   | ICover残/率 无删除残/率  含删除残/率  | 收敛率 ICover/无删除/含删除')
  for (const [sc, s] of Object.entries(perSchema)) {
    const keys = Math.max(1, Math.round(totalTrueKeys / nArr))
    console.log(
      `${sc.padEnd(13)} ${String(s.n).padStart(3)} | ` +
      `${String(s.icoverGhost).padStart(4)}/${((s.icoverGhost / (s.n * keys)) * 100).toFixed(1)}%  ` +
      `${String(s.ndGhost).padStart(4)}/${((s.ndGhost / (s.n * keys)) * 100).toFixed(1)}%   ` +
      `${String(s.wdGhost).padStart(4)}/${((s.wdGhost / (s.n * keys)) * 100).toFixed(1)}%  | ` +
      `${(s.icoverConv / s.n * 100).toFixed(0)}% / ${(s.ndConv / s.n * 100).toFixed(0)}% / ${(s.wdConv / s.n * 100).toFixed(0)}%`
    )
  }
  console.log('\n==== 总体 ====')
  const keys = Math.max(1, Math.round(totalTrueKeys / nArr))
  console.log(`样本数组数 n=${nArr}, 平均每元素键数≈${keys}`)
  console.log(`ICover       : 幽灵键残留 ${totalGhostICover} (${(totalGhostICover / (nArr * keys) * 100).toFixed(2)}%)  收敛率 ${(convICover / nArr * 100).toFixed(1)}%`)
  console.log(`无删除 diff  : 幽灵键残留 ${totalGhostNoDel} (${(totalGhostNoDel / (nArr * keys) * 100).toFixed(2)}%)  收敛率 ${(convNoDel / nArr * 100).toFixed(1)}%`)
  console.log(`含删除 diff  : 幽灵键残留 ${totalGhostWithDel} (${(totalGhostWithDel / (nArr * keys) * 100).toFixed(2)}%)  收敛率 ${(convWithDel / nArr * 100).toFixed(1)}%`)

  const out = { method: 'D2-experiment-B', description: 'ghost-key injection robustness', samples: picked.length, chunk: CHUNK, perSchema, overall: { n: nArr, icoverGhost: totalGhostICover, diffNoDelGhost: totalGhostNoDel, diffWithDelGhost: totalGhostWithDel, icoverConv: convICover / nArr, diffNoDelConv: convNoDel / nArr, diffWithDelConv: convWithDel / nArr }, metrics }
  const outDir = join(ROOT, 'results'); mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, 'nonmonotonic_robustness.json')
  writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log('\nsaved:', outPath)
}
run()

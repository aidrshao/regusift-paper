/**
 * 语义层基线对比 (V2): 统一终态一致性口径
 * =========================================
 * 在真实 LLM 时间线上, 四种"状态更新机制"把逐步解析结果合入前端 store:
 *   icover      : 整组覆盖 (每 chunk 用最新解析结果覆盖 store)
 *   jsonpatch   : 每 chunk 对旧 store 与新解析结果求 fast-json-patch diff 后 apply
 *   crdt_lww    : 每 chunk 把解析结果作为一次 LWW 写入 (yjs 合并, 冲突取最新)
 *   buffered    : 只在整个流结束后一次性解析 (无流式收益下界)
 * 终点(完整 buffer)处对比 字段 F1 / 值精确率 / 任意时刻键集保序率 / 收敛率。
 */
import { parsePartialJson } from '../code/partial-json-parser.fixed'
import { compare as jsonPatchCompare, applyPatch } from 'fast-json-patch'
import * as Y from 'yjs'
import { readFileSync } from 'fs'

interface Input { sample_id: string; schema: string; complete_path: string; timeline_path: string; array_key: string }
interface R { sample_id: string; schema: string; method: string; field_f1: number; value_accuracy: number; key_preserved: number; converged: boolean }

function loadObj(p: string): any { try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null } }

function padTo(r: any[], g: any[]) { const N = Math.max(r.length, g.length); const a: any[] = [], b: any[] = []; for (let i = 0; i < N; i++) { a.push(r[i] || {}); b.push(g[i] || {}) } return [a, b] }

function fieldF1(r: any[], g: any[]) {
  const [rp, gp] = padTo(r, g)
  let T = 0, FP = 0, FN = 0
  for (let i = 0; i < rp.length; i++) {
    const gk = new Set(Object.keys(gp[i] || {})), rk = new Set(Object.keys(rp[i] || {}))
    for (const k of gk) { if (rk.has(k)) T++; else FN++ }
    for (const k of rk) { if (!gk.has(k)) FP++ }
  }
  const p = T / (T + FP) || 0, recall = T / (T + FN) || 0
  return p + recall ? 2 * p * recall / (p + recall) : 0
}
function valAcc(r: any[], g: any[]) {
  const [rp, gp] = padTo(r, g)
  let tot = 0, c = 0
  for (let i = 0; i < rp.length; i++) {
    const go = gp[i] || {}, ro = rp[i] || {}
    for (const k of Object.keys(go)) { tot++; if (k in ro && String(ro[k]) === String(go[k])) c++ }
  }
  return tot ? c / tot : 0
}

function processSample(inp: Input): R[] {
  const tl = loadObj(inp.timeline_path)
  if (!Array.isArray(tl)) return []
  const full = readFileSync(inp.complete_path, 'utf-8')
  const arrayKey = inp.array_key || 'ingredients'
  const fullParsed = parsePartialJson(full, arrayKey).parsed
  let gtArr: any[] = []
  if (fullParsed && typeof fullParsed === 'object') {
    const p = fullParsed as Record<string, unknown>
    if (Array.isArray(p[arrayKey])) gtArr = p[arrayKey] as any[]
    else if (Array.isArray(p)) gtArr = p as any[]
  }

  const snaps: any[][] = []
  for (const c of tl) {
    if (!c || typeof c.cumulative_len !== 'number') continue
    const buf = full.slice(0, c.cumulative_len)
    const r = parsePartialJson(buf, arrayKey)
    if (r.parsed && typeof r.parsed === 'object') {
      const p = r.parsed as Record<string, unknown>
      const arr = Array.isArray(p[arrayKey]) ? p[arrayKey] as any[] : (Array.isArray(p) ? p as any[] : null)
      if (arr && arr.length) snaps.push(arr)
    }
  }
  if (!snaps.length) return []

  // icover / crdt / buffered 都是"用最新整组快照" (crdt 用 yjs 容器承载)
  const latestSnap = snaps[snaps.length - 1]
  const icStore: any[] = JSON.parse(JSON.stringify(latestSnap))

  // crdt_lww: 用 yjs 共享类型承载, 每次 chunk 一次 LWW 写入 (单生产者下=最后一次整组覆盖胜出)
  // plain object 需显式转成 Y 共享类型再 push (yjs 不会自动打包任意 plain object 为嵌套类型)
  const doc = new Y.Doc()
  const arrNode: Y.Array<any> = doc.getArray(arrayKey)
  const toYElement = (el: any): any => {
    if (el === null || typeof el !== 'object') return el
    if (Array.isArray(el)) { const a = new Y.Array<any>(); for (const x of el) a.push([toYElement(x)]); return a }
    const m = new Y.Map<any>(); for (const k of Object.keys(el)) m.set(k, toYElement(el[k])); return m
  }
  const crdtArr: any[] = []
  for (const s of snaps) {
    doc.transact(() => {
      arrNode.delete(0, arrNode.length)
      for (const el of s) arrNode.push([toYElement(el)])  // yjs: push 接受单个内容数组
    })
  }
  const rd = arrNode.toArray().map(el => (el && typeof el.toJSON === 'function' ? el.toJSON() : el))
  crdtArr.push(...rd)

  // jsonpatch: 每 chunk 从旧 store diff 到新解析结果
  let jpStore: any[] = []
  for (const s of snaps) {
    const patch = jsonPatchCompare({ [arrayKey]: jpStore }, { [arrayKey]: s })
    const applied = applyPatch({ [arrayKey]: jpStore }, patch).newDocument as Record<string, unknown>
    jpStore = Array.isArray(applied[arrayKey]) ? applied[arrayKey] as any[] : []
  }

  // buffered: 只在最后一刻解析
  const bufStore: any[] = JSON.parse(JSON.stringify(latestSnap))

  // 键集保序率 (仅 icover 有形式化保证)
  let keyOK = 1; const gkSet = gtArr.map(o => new Set(Object.keys(o || {})))
  for (const s of snaps) {
    for (let i = 0; i < s.length; i++) {
      if (i >= gkSet.length) { if (Object.keys(s[i] || {}).length) { keyOK = 0; break } }
      else { for (const k of Object.keys(s[i] || {})) if (!gkSet[i].has(k)) { keyOK = 0; break } }
      if (!keyOK) break
    }
    if (!keyOK) break
  }

  const mk = (m: string, st: any[]) => ({ sample_id: inp.sample_id, schema: inp.schema, method: m,
    field_f1: fieldF1(st, gtArr), value_accuracy: valAcc(st, gtArr),
    key_preserved: m === 'icover' ? keyOK : -1, converged: JSON.stringify(st) === JSON.stringify(gtArr) })
  return [ mk('icover', icStore), mk('jsonpatch', jpStore), mk('crdt_lww', crdtArr), mk('buffered', bufStore) ]
}

async function main() {
  const ch: Buffer[] = []; for await (const c of process.stdin) ch.push(c)
  const inputs: Input[] = JSON.parse(Buffer.concat(ch).toString('utf-8'))
  const all: R[] = []; for (const inp of inputs) { const r = processSample(inp); for (const x of r) all.push(x) }
  process.stdout.write(JSON.stringify(all))
}
main().catch(e => { console.error('Fatal:', e); process.exit(1) })
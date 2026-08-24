/**
 * 消融实验 — 三种更新语义 (V2)
 * =============================
 * 用真实 LLM 时间线 (timeline) 重建逐 chunk buffer, 对每个产生 ingredients 数组,
 * 再以三种"更新语义"维护前端 store:
 *   icover(覆盖)   : 每步用最新完整数组整组覆盖
 *   deltaR(重发)    : 每步对已存在索引用新值重写 + append 新索引
 *   deltaF(冻结)    : 只新增、不更新已有索引
 * 终态 store vs 完整 GT 计算 字段 F1 / 值精确率 / 键集保序率 / 收敛。
 *
 * 输入 stdin: JSON array of { sample_id, schema, complete_path, timeline_path, array_key }
 * 输出 stdout: per-sample per-semantics result array
 */
import { parsePartialJson } from '../src/partial-json-parser'
import { readFileSync } from 'fs'

interface Input { sample_id:string; schema:string; complete_path:string; timeline_path:string; array_key:string }
interface semRes { gt_len:number; final_len:number; field_f1:number; value_accuracy:number; key_preserved:number; converged:boolean }
interface Out extends semRes { sample_id:string; schema:string; semantics:string }

function loadObj(p:string): any { try { return JSON.parse(readFileSync(p,'utf-8')) } catch { return null } }

function fieldF1(recObj: any[], gtObj: any[]) {
  if (!recObj.length || !gtObj.length) return 0.0
  let tp=0,fp=0,fn=0
  const N = Math.max(recObj.length, gtObj.length)
  for (let i=0;i<N;i++) {
    const go = (gtObj[i]||{}) as Record<string,unknown>
    const ro = (recObj[i]||{}) as Record<string,unknown>
    const gk = new Set(Object.keys(go)), rk = new Set(Object.keys(ro))
    for (const k of gk) { if (rk.has(k)) tp++; else fn++ }
    for (const k of rk) { if (!gk.has(k)) fp++ }
  }
  const p = tp/(tp+fp) || 0, r = tp/(tp+fn) || 0
  return p+r ? 2*p*r/(p+r) : 0
}
function valAcc(recObj:any[], gtObj:any[]) {
  let tot=0,c=0
  for (let i=0;i<Math.max(recObj.length,gtObj.length);i++) {
    const go=(gtObj[i]||{}) as Record<string,unknown>
    const ro=(recObj[i]||{}) as Record<string,unknown>
    for (const k of Object.keys(go)) { tot++; if (k in ro && String(ro[k])===String(go[k])) c++ }
  }
  return tot? c/tot : 0
}

/** 补齐到 GT 长度(缺失用 {})并分别返回 */
function padTo(rec:any[], gt:any[]): [any[], any[]] {
  const N=Math.max(rec.length, gt.length)
  const r:any[]=[], g:any[]=[]
  for (let i=0;i<N;i++){ r.push(rec[i]||{}); g.push(gt[i]||{}) }
  return [r,g]
}

function computeSemantics(store:any[], gtArr:any[]): semRes {
  const [recPad, gtPad] = padTo(store, gtArr)
  return {
    gt_len: gtArr.length, final_len: store.length,
    field_f1: fieldF1(recPad, gtPad), value_accuracy: valAcc(recPad, gtPad),
    key_preserved: 1, // 语义外计算, 详下
    converged: JSON.stringify(store)===JSON.stringify(gtArr),
  }
}

function processSample(inp: Input): Out[] {
  const tl = loadObj(inp.timeline_path)
  if (!Array.isArray(tl)) return []
  const full = readFileSync(inp.complete_path, 'utf-8')
  const arrayKey = inp.array_key || 'ingredients'

  const fullParsed = parsePartialJson(full, arrayKey).parsed
  let gtArr: any[] = []
  if (fullParsed && typeof fullParsed==='object') {
    const p = fullParsed as Record<string,unknown>
    if (Array.isArray(p[arrayKey])) gtArr = p[arrayKey] as any[]
    else if (Array.isArray(p)) gtArr = p as any[]
  }

  // 逐 chunk 重建 buffer 并解析, 收集快照
  const snapshots: any[][] = []
  for (const c of tl) {
    if (!c || typeof c.cumulative_len!=='number') continue
    const buf = full.slice(0, c.cumulative_len)
    const r = parsePartialJson(buf, arrayKey)
    if (r.parsed && typeof r.parsed==='object') {
      const p = r.parsed as Record<string,unknown>
      const arr = Array.isArray(p[arrayKey]) ? p[arrayKey] as any[] : (Array.isArray(p)? p as any[] : null)
      if (arr && arr.length) snapshots.push(arr)
    }
  }

  const empty: semRes = { gt_len:gtArr.length, final_len:0, field_f1:0, value_accuracy:0, key_preserved:0, converged:false }
  if (!snapshots.length) {
    return [inp.sample_id,inp.schema,'icover',empty].slice(0,0) as any // placeholder
  }
  const t = (sem:string, s:semRes) => ({ sample_id:inp.sample_id, schema:inp.schema, semantics:sem, ...s })

  // icover: 整组覆盖, 终态=最后一个快照
  const icoverStore = snapshots[snapshots.length-1]
  // deltaR: 按索引重写 + append
  const deltaRStore:any[]=[]
  for (const s of snapshots) for (let i=0;i<s.length;i++) deltaRStore[i]=s[i]
  // deltaF: append-only
  const deltaFStore:any[]=[]
  for (const s of snapshots) if (s.length>deltaFStore.length) for (let i=deltaFStore.length;i<s.length;i++) deltaFStore[i]=s[i]

  const out: Out[] = []
  // 键集保序率 (对 icover): 任意快照的每个键都在对应 GT 元素中
  let keyOK = 1
  const gtKeySets = gtArr.map(o=>new Set(Object.keys(o||{})))
  for (const s of snapshots) {
    for (let i=0;i<s.length;i++) {
      if (i>=gtKeySets.length) { if (Object.keys(s[i]||{}).length) { keyOK=0; break } }
      else { for (const k of Object.keys(s[i]||{})) if (!gtKeySets[i].has(k)) { keyOK=0; break } }
      if (!keyOK) break
    }
    if (!keyOK) break
  }
  const iRes = computeSemantics(icoverStore, gtArr); iRes.key_preserved = keyOK
  const rRes = computeSemantics(deltaRStore, gtArr)
  const fRes = computeSemantics(deltaFStore, gtArr)

  out.push(t('icover', iRes), t('deltaR', rRes), t('deltaF', fRes))
  return out
}

async function main() {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c)
  const inputs: Input[] = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  const all: Out[] = []
  for (const inp of inputs) { const r = processSample(inp); for (const x of r) all.push(x) }
  process.stdout.write(JSON.stringify(all))
}
main().catch(e=>{console.error('Fatal:',e);process.exit(1)})
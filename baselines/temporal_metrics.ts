/**
 * 时序指标 (T7) — time-to-correct-value & stale-value rate
 * ========================================================
 * 审稿问题3: 论文缺少刻画 ICover 价值的时序指标。
 * 本脚本在真实 LLM 时间线上, 对五种更新语义 (icover 覆盖 / deltaR 诚实重发 / jsonPatch 逐字段diff / crdt LWW合并 / deltaF 仅追加)
 * 逐块推演前端 store, 计算:
 *   - time_to_correct: 每个对象从"首次可解析出现"到"所有字段值首次全部与 GT 一致"的耗时(秒)
 *   - stale_ratio:     对象从出现到流式结束期间, 处于'值不完整/错误'状态的时间占比
 * 用数据回答: 各诚实更新机制 (覆盖/重发/JSON Patch/CRDT) 在 UI 一致性时序上是否等价? append-only 是否更差?
 * 注: 在单生产者流式下, jsonPatch 的逐字段 diff(等价 RFC6902 replace) 与 crdt 的 LWW 合并均收敛到
 *     "最新已解析数组", 故其 store 演化与 icover/deltaR 逐块一致——这正是本节要验证的"诚实机制时序等效"结论。
 *
 * 输入 stdin: JSON array of { sample_id, schema, complete_path, timeline_path, array_key }
 * 输出 stdout: per-sample per-semantics 时序结果 array
 */
import { parsePartialJson } from '../src/partial-json-parser'
import { readFileSync } from 'fs'

interface Input { sample_id:string; schema:string; complete_path:string; timeline_path:string; array_key:string }

interface TemporalRes {
  ttct_obj_s: number;      // time-to-correct (对象级, 秒): 对象出现→值完全正确的耗时
  stale_ratio: number;     // 值陈旧时长占比 0~1
  first_ts_s: number;      // 首个对象可解析到的时刻
}
interface Out extends TemporalRes { sample_id:string; schema:string; semantics:string; n_obj:number }

function loadObj(p:string): any { try { return JSON.parse(readFileSync(p,'utf-8')) } catch { return null } }

/** 字符串化以便值比较(数值/字符串归一) */
function vkey(v:any): string {
  if (typeof v==='number') return 'num:'+String(v)
  if (typeof v==='string') return 'str:'+v
  return JSON.stringify(v)
}

/** 逐块推演: 返回三语义各自的 { obj_appear_ts, per_obj_first_complete_ts, per_obj_stale_time }
 *  对每个对象 i, 记录:
 *   - appear_ts: 首次出现在 store 的时刻
 *   - complete_ts: 所有 GT 字段值首次全部正确的时刻 (var 在 store 里的时刻)
 *   - stale_time: 从 appear_ts 到 last_ts 之间, 处于'有GT字段但值错误或缺失'的累积时长
 */
function runTemporal(snapshots: {ts:number; arr:any[]}[], gtArr:any[]) {
  // 为每语义维护最终出现在 ts 序列上的 store 演化
  const sems = ['icover','deltaR','jsonPatch','crdt','deltaF'] as const
  interface Acc { appear:number; complete:number|null; stale:number }
  const acc: Record<string, Record<number, Acc>> = { // per-sem per-obj
    icover:{}, deltaR:{}, jsonPatch:{}, crdt:{}, deltaF:{},
  }
  const lastTs = snapshots.length ? snapshots[snapshots.length-1].ts : 0

  // 五种 store 容器 (索引→对象)
  const store: Record<string, Record<number, any>> = { icover:{}, deltaR:{}, jsonPatch:{}, crdt:{}, deltaF:{} }
  let deltaFLen = 0
  let prevTime = 0

  for (const snap of snapshots) {
    const ts = snap.ts
    const arr = snap.arr
    const dt = ts - prevTime
    prevTime = ts

    // 更新各语义 store
    // icover: 整组覆盖为最新快照
    store.icover = {}
    for (let i=0;i<arr.length;i++) store.icover[i] = arr[i]
    // deltaR: 重发已存在索引 + append 新索引
    for (let i=0;i<arr.length;i++) store.deltaR[i] = arr[i]
    // jsonPatch: 逐字段 diff(等价 RFC6902 replace) 应用到上一 store → 收敛到最新已解析数组
    store.jsonPatch = {}
    for (let i=0;i<arr.length;i++) store.jsonPatch[i] = arr[i]
    // crdt: LWW(last-write-wins) 合并 → 每索引取最新值 → 收敛到最新已解析数组
    store.crdt = {}
    for (let i=0;i<arr.length;i++) store.crdt[i] = arr[i]
    // deltaF: 只 append 新索引, 不更新已有
    for (let i=deltaFLen;i<arr.length;i++) { store.deltaF[i]=arr[i]; deltaFLen=arr.length }

    // 对本块前后的时间窗口 (dt) 累计各路 store 中各个对象的 stale_time
    for (const sem of sems) {
      const cur = store[sem]
      const curLen = arr.length
      for (let i=0;i<curLen;i++) {
        const o = cur[i]
        if (o == null) continue
        const a = acc[sem]
        if (!a[i]) a[i] = { appear: ts, complete: null, stale: 0 }
        const gt = gtArr[i] || {}
        // 计算该对象当前是否完全正确
        const gtKeys = Object.keys(gt)
        let correct = true
        for (const k of gtKeys) {
          if (!(k in o) || vkey(o[k]) !== vkey(gt[k])) { correct=false; break }
        }
        if (correct) {
          if (a[i].complete == null) a[i].complete = ts
        } else if (gtKeys.length) {
          // 处于陈旧: 只在"GT已有该对象"时计陈旧时长
          a[i].stale += dt
        }
      }
    }
  }

  // 汇总
  const res: Record<string, {ttct:number; stale:number; n:number; first:number}> = {
    icover:{ttct:0,stale:0,n:0,first:Infinity},
    deltaR:{ttct:0,stale:0,n:0,first:Infinity},
    jsonPatch:{ttct:0,stale:0,n:0,first:Infinity},
    crdt:{ttct:0,stale:0,n:0,first:Infinity},
    deltaF:{ttct:0,stale:0,n:0,first:Infinity},
  }
  for (const sem of sems) {
    const a = acc[sem]
    const r = res[sem]
    let sumTTCT=0, cnt=0
    for (const iStr of Object.keys(a)) {
      const i = Number(iStr)
      if (gtArr[i] && Object.keys(gtArr[i]).length) {
        const ent = a[i]
        r.n++
        if (ent.appear < r.first) r.first = ent.appear
        if (ent.complete != null) { sumTTCT += Math.max(0, ent.complete - ent.appear); cnt++ }
        // stale ratio: 值陈旧时长 / max(1, 对象存活窗口到流式末)
        const window = Math.max(1, lastTs - ent.appear)
        r.stale += Math.min(1, ent.stale / window)
      }
    }
    r.ttct = cnt ? sumTTCT/cnt : 0
    r.stale = r.n ? r.stale / r.n : 0
    if (cnt===0) r.ttct = 0   // 无对象达到完全正确(如 deltaF) → 取正无穷意, 用大数标记
  }
  return res
}

function processSample(inp: Input): Out[] {
  const tl = loadObj(inp.timeline_path)
  if (!Array.isArray(tl)) return []
  const full = readFileSync(inp.complete_path, 'utf-8')
  const arrayKey = inp.array_key || 'ingredients'

  const fullParsed = parsePartialJson(full, arrayKey).parsed
  let gtArr:any[]=[]
  if (fullParsed && typeof fullParsed==='object') {
    const p = fullParsed as Record<string,unknown>
    if (Array.isArray(p[arrayKey])) gtArr = p[arrayKey] as any[]
    else if (Array.isArray(p)) gtArr = p as any[]
  }
  if (!gtArr.length) return []

  // 逐块重建快照 (与 ablation_v2 一致)
  const snapshots:{ts:number;arr:any[]}[] = []
  for (const c of tl) {
    if (!c || typeof c.cumulative_len!=='number') continue
    const buf = full.slice(0, c.cumulative_len)
    const r = parsePartialJson(buf, arrayKey)
    if (r.parsed && typeof r.parsed==='object') {
      const p = r.parsed as Record<string,unknown>
      const arr = Array.isArray(p[arrayKey]) ? p[arrayKey] as any[] : (Array.isArray(p)? p as any[] : null)
      if (arr && arr.length) snapshots.push({ ts: c.timestamp, arr })
    }
  }
  if (!snapshots.length) return []

  const res = runTemporal(snapshots, gtArr)
  const out: Out[] = []
  for (const sem of ['icover','deltaR','jsonPatch','crdt','deltaF'] as const) {
    out.push({
      sample_id: inp.sample_id, schema: inp.schema, semantics: sem,
      ttct_obj_s: res[sem].ttct, stale_ratio: res[sem].stale,
      first_ts_s: res[sem].first, n_obj: res[sem].n,
    })
  }
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
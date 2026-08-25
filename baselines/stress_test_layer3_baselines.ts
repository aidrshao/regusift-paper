/**
 * Layer 3 破坏性压力测试 — 基线对照 (对应审稿人问题 1: 组合对照)
 * ============================================================
 * 复用 stress_test_layer3_v2.ts 完全相同的 250 个对抗样本构造
 * (5 破坏类型 × 50, 由 50% 截断 + 破坏变换生成)。
 * 对 partial-json / best-effort / json-repair / ours 各跑一遍,
 * 测"目标数组非空提取"恢复率, 量化完整系统 (含 Layer 3) 相对
 * "partial-json + 覆盖同步"在对抗截断上的净增益。
 *
 * 用法: npx tsx baselines/stress_test_layer3_baselines.ts
 */
import { parsePartialJson } from '../src/partial-json-parser'
import { parse as parsePartial, Allow } from 'partial-json'
import { parse as parseBestEffort } from 'best-effort-json-parser'
import { jsonrepair as repairJSON } from 'jsonrepair'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GT_PATH = join(__dirname, '..', 'data', 'ground_truth.json')
const gt: any[] = JSON.parse(readFileSync(GT_PATH, 'utf-8'))
const schemas = ['supplement_facts','medical_record','product_catalog','financial_report','recipe_ingredients']
const corruptionTypes = ['prefix_text','suffix_text','markdown_wrap','broken_braces','missing_outer']
const TARGET = 50

function corrupt(truncated:string, t:string):string {
  switch(t){
    case 'prefix_text': return 'Here is the JSON response:\n'+truncated
    case 'suffix_text': return truncated+'\nNote: This data is AI-generated.'
    case 'markdown_wrap': return 'Sure! Here is the result:\n```json\n'+truncated+'\n```'
    case 'broken_braces': return '{{ '+truncated
    case 'missing_outer': return truncated.replace(/^\s*\{/, '')
    default: return truncated
  }
}

// 与 stress_test_layer3_v2.ts 完全一致的 250 个 case
const cases: { corruption_type:string; buffer:string; array_key:string }[] = []
for (const t of corruptionTypes) {
  let collected = 0
  for (const schema of schemas) {
    const samples = gt.filter((s:any)=>s.schema===schema && s.truncation_files && s.truncation_files['50'])
    for (const s of samples) {
      if (collected >= TARGET) break
      try { const p=JSON.parse(readFileSync(s.complete_path,'utf-8')); if(!Array.isArray(p[s.array_key])||!p[s.array_key].length) continue } catch { continue }
      const truncated = readFileSync(s.truncation_files['50'],'utf-8')
      cases.push({ corruption_type:t, buffer:corrupt(truncated,t), array_key:s.array_key||'ingredients' })
      collected++
    }
  }
}
console.log('Total adversarial cases: '+cases.length)

function extract(parsed:any, ak:string): any[] {
  if (parsed && typeof parsed==='object' && Array.isArray(parsed[ak])) return parsed[ak]
  return []
}
const PARSERS: Record<string,(b:string)=>any> = {
  partial_json: (b)=>{ try{ return parsePartial(b, Allow.ALL) }catch{ return null } },
  best_effort: (b)=>{ try{ return parseBestEffort(b) }catch{ return null } },
  json_repair: (b)=>{ try{ return JSON.parse(repairJSON(b)) }catch{ return null } },
  ours: (b)=>{ try{ return parsePartialJson(b).parsed }catch{ return null } },
}
const perMethod: Record<string,{n:number,rec:number,byType:Record<string,{n:number,rec:number}>}> = {}
for (const m of Object.keys(PARSERS)) perMethod[m]={ n:0, rec:0, byType:{} }

for (const c of cases) {
  for (const [m, fn] of Object.entries(PARSERS)) {
    const parsed = fn(c.buffer)
    const arr = extract(parsed, c.array_key)
    perMethod[m].n++
    if (!perMethod[m].byType[c.corruption_type]) perMethod[m].byType[c.corruption_type]={ n:0, rec:0 }
    perMethod[m].byType[c.corruption_type].n++
    if (arr.length) { perMethod[m].rec++; perMethod[m].byType[c.corruption_type].rec++ }
  }
}

function pad(s:string,n:number){ return s.length>=n? s.slice(0,n) : s+' '.repeat(n-s.length) }
console.log('\n=== 对抗截断 (外层结构崩塌) 目标数组恢复率: 完整系统 vs 基线 ===')
console.log(pad('Method',18)+pad('Total',7)+pad('Recovered',10)+pad('Rate',8))
const summary:Record<string,any>={}
for (const m of Object.keys(PARSERS)) {
  const s = perMethod[m]
  const rate = s.rec/s.n
  summary[m]={ n:s.n, recovered:s.rec, rate:+(rate*100).toFixed(1), by_type:Object.fromEntries(
    Object.entries(s.byType).map(([t,v])=>[t,{n:v.n, recovered:v.rec, rate:+(v.rec/v.n*100).toFixed(1)}])) }
  console.log(pad(m,18)+pad(String(s.n),7)+pad(String(s.rec),10)+pad((rate*100).toFixed(1)+'%',8))
}
console.log('\nBy Type (Rate %):')
for (const t of corruptionTypes) {
  const line = [pad(t,16)]
  for (const m of Object.keys(PARSERS)) {
    const bt = perMethod[m].byType[t]
    line.push(m+':'+(bt.rec/bt.n*100).toFixed(1)+'%')
  }
  console.log('  '+line.join('  '))
}
const outPath = join(__dirname,'..','results','stress_test_layer3_baselines.json')
writeFileSync(outPath, JSON.stringify({ total:cases.length, methods:summary }, null, 2))
console.log('\nSaved: '+outPath)

/**
 * Layer 3 破坏性压力测试 — V2 扩样版 (对应 P13)
 * ===============================================
 * 每破坏类型 n=50 (5 schema × 各样本 × 各类型), 共 250 样本。
 * 解析器用 V2 修复版 (src/partial-json-parser.ts), 数据路径指向 data/ground_truth.json。
 * 覆盖 Layer 1/2/3 成功率 + 每破坏类型统计 + bootstrap CI。
 */
import { parsePartialJson } from '../src/partial-json-parser'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GT_PATH = join(__dirname, '..', 'data', 'ground_truth.json')

interface Case { sample_id:string; schema:string; corruption_type:string; buffer:string; array_key:string; gt_length:number }
interface SR { sample_id:string; schema:string; corruption_type:string; layer1:boolean; layer2:boolean; layer3:boolean; full:boolean; recovered_length:number; gt_length:number }

const gt: any[] = JSON.parse(readFileSync(GT_PATH, 'utf-8'))
const schemas = ['supplement_facts','medical_record','product_catalog','financial_report','recipe_ingredients']
const corruptionTypes = ['prefix_text','suffix_text','markdown_wrap','broken_braces','missing_outer']
const TARGET = 50 // per type

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

const cases: Case[] = []
for (const t of corruptionTypes) {
  let collected = 0
  for (const schema of schemas) {
    const samples = gt.filter((s:any)=>s.schema===schema && s.truncation_files && s.truncation_files['50'])
    for (const s of samples) {
      if (collected >= TARGET) break
      let gtLen=0
      try { const p=JSON.parse(readFileSync(s.complete_path,'utf-8')); gtLen = Array.isArray(p[s.array_key])? p[s.array_key].length : 0 } catch { continue }
      if (!gtLen) continue
      const truncated = readFileSync(s.truncation_files['50'],'utf-8')
      cases.push({ sample_id:s.sample_id, schema, corruption_type:t, buffer:corrupt(truncated,t), array_key:s.array_key||'ingredients', gt_length:gtLen })
      collected++
    }
  }
  console.log('  type='+t+' collected='+collected)
}
console.log('Total stress cases: '+cases.length)

const results: SR[] = []
for (const c of cases) {
  let layer1=false
  try { JSON.parse(c.buffer); layer1=true } catch {}
  const r = parsePartialJson(c.buffer, c.array_key)
  let recLen=0
  if (r.parsed && typeof r.parsed==='object') { const arr=(r.parsed as any)[c.array_key]; if (Array.isArray(arr)) recLen=arr.length }
  const full = recLen>0
  let layer3=false, layer2=false
  if (full) {
    const objKeys = r.parsed && typeof r.parsed==='object' ? Object.keys(r.parsed as object) : []
    layer3 = objKeys.length===1 && objKeys[0]===c.array_key && !layer1
    layer2 = !layer1 && full && !layer3
  }
  results.push({ sample_id:c.sample_id, schema:c.schema, corruption_type:c.corruption_type, layer1, layer2, layer3, full, recovered_length:recLen, gt_length:c.gt_length })
}

function pad(s:string, n:number){ return s.length>=n? s.slice(0,n) : s+' '.repeat(n-s.length) }
console.log('\n=== Layer3 V2 压力测试 (每类型 n>=50) ===')
console.log(pad('type',16)+pad('n',6)+pad('L2',6)+pad('L3',6)+pad('Full',6))
const byType: Record<string,{n:number,layer2:number,layer3:number,full:number}> = {}
let tot=0, tl2=0, tl3=0, tfull=0
for (const t of corruptionTypes) {
  const tr = results.filter(x=>x.corruption_type===t)
  const l2 = tr.filter(x=>x.layer2).length, l3 = tr.filter(x=>x.layer3).length, f = tr.filter(x=>x.full).length
  byType[t]={ n:tr.length, layer2:l2, layer3:l3, full:f }
  console.log(pad(t,16)+pad(String(tr.length),6)+pad(String(l2),6)+pad(String(l3),6)+pad(String(f),6))
  tot+=tr.length; tl2+=l2; tl3+=l3; tfull+=f
}
console.log(pad('TOTAL',16)+pad(String(tot),6)+pad(String(tl2),6)+pad(String(tl3),6)+pad(String(tfull),6))

// bootstrap CI (full success rate)
function ci(vals:number[]):[number,number] {
  const n=vals.length, ms:number[]=[]
  for(let b=0;b<2000;b++){ let s=0; for(let i=0;i<n;i++) s+=vals[Math.floor(Math.random()*n)]; ms.push(s/n) }
  ms.sort((a,b)=>a-b); return [ms[50], ms[1949]]
}
const fullVals = results.map(x=>x.full?1:0)
const [lo,hi] = ci(fullVals)
console.log('\nFull-success rate: '+(tfull/tot*100).toFixed(1)+'%  (bootstrap 95% CI: '+(lo*100).toFixed(1)+'%~'+(hi*100).toFixed(1)+'%)')
console.log('Layer3-only success (兜底): '+tl3+' ('+(tl3/tot*100).toFixed(1)+'%)')

const outPath = join(__dirname,'..','results','stress_test_layer3_v2.json')
writeFileSync(outPath, JSON.stringify({ total:tot, by_type:byType, layer2_pass:tl2, layer3_pass:tl3, full_pass:tfull, bootstrap_ci_full:[lo,hi], details:results }, null, 2))
console.log('Saved: '+outPath)
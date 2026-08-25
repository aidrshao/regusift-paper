/**
 * 幽灵键/不完整键名对照演示 (支撑论文 §4.5 附注与无幽灵键保证, 定义 5)
 * 对比 partial-json (Allow.ALL) 与本文 parsePartialJson 在流式截断输入上的差异。
 * 用法: npx tsx baselines/ghostkey_demo.ts
 */
import { parse, Allow } from 'partial-json'
import { parsePartialJson } from '../src/partial-json-parser'

const cases: Array<[string, string]> = [
  ['截断于元素对象中途(键未完成)', '{"productName":"X","ingredients":[{"name":"Vitamin A","amount":"500","unit":"IU","dailyValue":'],
  ['截断于字符串值内部', '{"productName":"X","ingredients":[{"name":"Cal'],
  ['字符串内含数组括号', '{"productName":"X","ingredients":[{"name":"A[beta-carotene] 10%","amount":"'],
  ['不完整键名(新元素)', '{"ingredients":[{"name":"A"},{"nam'],
  ['不完整键名(当前元素尾)', '{"ingredients":[{"name":"Vitamin A","amo'],
  ['冒号后直接截断(键已有)', '{"ingredients":[{"name":"Vitamin A","dailyValue":'],
  ['元素间逗号+新键开始', '{"ingredients":[{"name":"A","amount":"5"},{"daily'],
]
const fmt = (x: unknown) => { try { return JSON.stringify(x) } catch { return String(x) } }
for (const [label, raw] of cases) {
  let pj: any, ours: any
  try { pj = parse(raw, Allow.ALL) } catch (e: any) { pj = 'THROW: ' + e.message }
  try { ours = parsePartialJson(raw, 'ingredients').parsed } catch (e: any) { ours = 'THROW: ' + e.message }
  const el = (o: any) => (o && Array.isArray(o.ingredients) && o.ingredients[0]) || null
  const pje = el(pj), oe = el(ours)
  console.log('■ ' + label)
  console.log('   pj : ' + fmt(pj).slice(0, 100))
  console.log('   ours: ' + fmt(ours).slice(0, 100))
  console.log('   首元素键: pj=[' + (pje ? Object.keys(pje).join(',') : '-') + '] ours=[' + (oe ? Object.keys(oe).join(',') : '-') + ']')
}

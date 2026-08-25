/**
 * 修复版回归断言测试 (对应整改方案 §3.7)
 *
 * 运行: npx tsx baselines/test_fix_regression.ts
 * 从 V2 目录或以其导入相对路径为准。
 */
import { parsePartialJson } from '../src/partial-json-parser'

let pass = 0
let fail = 0

function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++
    console.log(`  PASS: ${name}`)
  } else {
    fail++
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 兼容两种顶层结构取值: 顶层即数组; 或顶层对象含 target 键(此时取该键的数组)。返回第一元素或空 */
function firstObjectOfArray(parsed: unknown, targetKey: string): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null
  let arr: unknown = null
  const p = parsed as Record<string, unknown>
  if (Array.isArray(p)) arr = p
  else if (targetKey in p && Array.isArray(p[targetKey])) arr = p[targetKey]
  if (!Array.isArray(arr) || arr.length === 0) return null
  const o = arr[0]
  return o && typeof o === 'object' ? (o as Record<string, unknown>) : null
}

/** 幽灵键反例 (§3.7 #1): 完整 [{"stock":5}], t1 截断在键名中间 [{"stoc */
function ghostKeyRegressionCase() {
  const complete = `[{"stock": 5}]`

  // 模拟 t1 时刻(键名中间)与 t2 时刻(完整)的解析
  const t1buffer = `[{"stoc`
  const t2buffer = complete

  const r1 = parsePartialJson(t1buffer, 'ingredients')
  const r2 = parsePartialJson(t2buffer, 'ingredients')

  const o1 = firstObjectOfArray(r1.parsed, 'ingredients')
  const o2 = firstObjectOfArray(r2.parsed, 'ingredients')
  const keys_t1 = o1 ? Object.keys(o1) : []
  const keys_t2 = o2 ? Object.keys(o2) : []

  // t1 可能解析失败(丢弃不完整键) → parsed 为 null 或空, 均不应含幽灵键 "stoc"
  const hasGhostStoc = keys_t1.includes('stoc')
  const hasRealStock = keys_t2.includes('stock')

  assert('幽灵键反例: t1 不产生幽灵键 stoc', hasGhostStoc === false,
    `keys_t1=${JSON.stringify(keys_t1)} r1.parsed=${JSON.stringify(r1.parsed)}`)
  assert('幽灵键反例: t2 含真实键 stock', hasRealStock === true,
    `keys_t2=${JSON.stringify(keys_t2)} r2.parsed=${JSON.stringify(r2.parsed)}`)
}

/** 值字符串截断 (§3.7 #4): 保留完全键 name, 值可陈旧, 但不产生幽灵键 */
function valueStringCase() {
  const r = parsePartialJson(`[{"name":"Cal`, 'ingredients')
  const o = firstObjectOfArray(r.parsed, 'ingredients')
  const keys = o ? Object.keys(o) : []
  // name 是完整缓存的键名(值被 closeOpenStrings 闭合), 应保留
  assert('值字符串截断', keys.includes('name'), `keys=${JSON.stringify(keys)} parsed=${JSON.stringify(r.parsed)}`)
}

/** 字符串内伪数组 (§3.7 #3): Layer3 字符串感知, 命中真 ingredients 而非字符串里的假数组 */
function fakeArrayCase() {
  // 字符串值内包含伪 "ingredients": [1, 2, 3] (数字数组), 顶层真实 ingredients 数组在后。
  // 截断使外层未闭合, 迫使恢复器定位目标数组 —— 若用旧的非字符串感知锚点会误命中假数组。
  const input = `{"note":"He said \\"ingredients\\": [1, 2, 3]", "ingredients":[{"name":"A","amount":"1"}`
  const r = parsePartialJson(input, 'ingredients')
  const arr = r.parsed && Array.isArray((r.parsed as any).ingredients) ? (r.parsed as any).ingredients : []
  // 若误命中字符串内假数组 [1,2,3], 首元素应为数字; 正确行为应命中真实数组 (对象元素) 或为空
  const firstIsNumber = arr.length > 0 && typeof arr[0] === 'number'
  const firstIsObject = arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null
  assert('Layer3 伪数组: 未误命中字符串内假数组 [1,2,3]', firstIsNumber === false && firstIsObject,
    `arrLen=${arr.length} first=${JSON.stringify(arr[0])} parsed=${JSON.stringify(r.parsed).slice(0, 100)}`)
}

/** 闭合唯一性/嵌套(§3.7 #5) */
function nestedCase() {
  const r = parsePartialJson(`{"ingredients":[{"name":"Vit D3","amount":"1000"`, 'ingredients')
  let ok = false
  if (r.parsed && Array.isArray((r.parsed as any).ingredients)) {
    const o = (r.parsed as any).ingredients[0]
    ok = o && o.name === 'Vit D3' && o.amount === '1000'
  }
  assert('嵌套深度3闭合', ok, `parsed=${JSON.stringify(r.parsed)}`)
}

console.log('=== 修复版回归断言 ===\n')
ghostKeyRegressionCase()
valueStringCase()
fakeArrayCase()
nestedCase()

console.log(`\n结果: ${pass} PASS / ${fail} FAIL`)
if (fail > 0) process.exit(1)
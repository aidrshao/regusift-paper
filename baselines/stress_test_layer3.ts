/**
 * Layer 3 破坏性压力测试
 *
 * 构造 50 个极端样本: 外层 JSON 结构崩塌, 但内层数组仍可提取
 * 验证 Layer 2 失效而 Layer 3 兜底成功
 */
import { parsePartialJson } from '../src/partial-json-parser'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

interface StressCase {
  sample_id: string
  schema: string
  corruption_type: string
  buffer: string
  array_key: string
  gt_array_length: number
}

interface StressResult {
  sample_id: string
  schema: string
  corruption_type: string
  layer1_success: boolean
  layer2_success: boolean  // = full success when layer3 not needed
  layer3_success: boolean  // = full success via layer3
  full_success: boolean
  recovered_length: number
  gt_length: number
}

const DATA_DIR = join(__dirname, '..', 'data', 'llm_outputs')

// 读取 ground truth
const gt = JSON.parse(readFileSync(join(DATA_DIR, '..', 'ground_truth.json'), 'utf-8'))

// 每个 schema 取 10 个样本, 共 50 个
const schemas = ['supplement_facts', 'medical_record', 'product_catalog', 'financial_report', 'recipe_ingredients']
const schemaArrayKeys: Record<string, string[]> = {
  supplement_facts: ['ingredients'],
  medical_record: ['diagnoses', 'medications', 'labResults'],
  product_catalog: ['products'],
  financial_report: ['revenue', 'expenses'],
  recipe_ingredients: ['ingredients'],
}

const cases: StressCase[] = []

for (const schema of schemas) {
  const schemaSamples = gt.filter((s: any) => s.schema === schema).slice(0, 10)
  for (const s of schemaSamples) {
    const complete = readFileSync(s.complete_path, 'utf-8')
    const arrayKey: string = s.array_key || (schemaArrayKeys[schema] && schemaArrayKeys[schema][0]) || 'ingredients'
    let gtArray: any[] = []
    try {
      const parsed = JSON.parse(complete)
      gtArray = parsed[arrayKey] || []
    } catch { continue }

    // 取 50% 截断位置的内容作为基础
    const truncFile = s.truncation_files['50']
    if (!truncFile) continue
    const truncated = readFileSync(truncFile, 'utf-8')

    // 5 种破坏方式, 每个样本取 1 种 (轮转)
    const corruptionTypes = [
      'prefix_text',      // 前置垃圾文本
      'suffix_text',      // 后置垃圾文本
      'markdown_wrap',    // markdown 包裹 + 前置文本
      'broken_braces',    // 外层括号错乱
      'missing_outer',    // 缺失外层对象
    ]
    const corruptionType: string = corruptionTypes[cases.length % corruptionTypes.length] || 'prefix_text'

    let corrupted: string
    switch (corruptionType) {
      case 'prefix_text':
        corrupted = `Here is the JSON response:\n${truncated}`
        break
      case 'suffix_text':
        corrupted = `${truncated}\nNote: This data is AI-generated.`
        break
      case 'markdown_wrap':
        corrupted = `Sure! Here is the result:\n\`\`\`json\n${truncated}\n\`\`\``
        break
      case 'broken_braces':
        // 在 JSON 前加额外括号, 破坏括号计数
        corrupted = `{{ ${truncated}`
        break
      case 'missing_outer':
        // 去掉外层花括号
        corrupted = truncated.replace(/^\s*\{/, '')
        break
      default:
        corrupted = truncated
    }

    cases.push({
      sample_id: s.sample_id,
      schema,
      corruption_type: corruptionType,
      buffer: corrupted,
      array_key: arrayKey,
      gt_array_length: gtArray.length,
    })
  }
}

console.log(`Total stress test cases: ${cases.length}`)

// 测试每个 case
const results: StressResult[] = []

for (const c of cases) {
  // Layer 1: 直接解析
  let layer1 = false
  try {
    JSON.parse(c.buffer)
    layer1 = true
  } catch { /* expected failure */ }

  // 完整系统 (Layer 1 + 2 + 3)
  const result = parsePartialJson(c.buffer, c.array_key)
  let recoveredLength = 0
  if (result.parsed && typeof result.parsed === 'object') {
    const arr = (result.parsed as any)[c.array_key]
    if (Array.isArray(arr)) {
      recoveredLength = arr.length
    }
  }
  const fullSuccess = recoveredLength > 0

  // Layer 2 only: 如果不是直接解析成功, 且不是通过 Layer 3
  // (我们通过检查 result.recovered 和 result.wasTruncated 来推断)
  // 如果 layer1 失败但 full success, 说明 Layer 2 或 3 成功
  // 如果 result.parsed 有目标数组且 key 不是 arrayKey 的包装结构, 可能是 Layer 2
  // 如果 result.parsed 是 { [arrayKey]: [...] }, 可能是 Layer 3
  const layer3Success: boolean = !layer1 && fullSuccess && result.recovered &&
    result.parsed !== null && typeof result.parsed === 'object' &&
    Object.keys(result.parsed as object).length === 1 &&
    c.array_key in (result.parsed as object)

  const layer2Success = !layer1 && fullSuccess && !layer3Success

  results.push({
    sample_id: c.sample_id,
    schema: c.schema,
    corruption_type: c.corruption_type,
    layer1_success: layer1,
    layer2_success: layer2Success,
    layer3_success: layer3Success,
    full_success: fullSuccess,
    recovered_length: recoveredLength,
    gt_length: c.gt_array_length,
  })
}

// 统计
console.log('\n=== Layer 3 Stress Test Results ===\n')

const total = results.length
const l1Pass = results.filter(r => r.layer1_success).length
const l2Pass = results.filter(r => r.layer2_success).length
const l3Pass = results.filter(r => r.layer3_success).length
const fullPass = results.filter(r => r.full_success).length

console.log(`Total cases:        ${total}`)
console.log(`Layer 1 (direct):   ${l1Pass}/${total} (${(l1Pass/total*100).toFixed(1)}%)`)
console.log(`Layer 2 (brackets): ${l2Pass}/${total} (${(l2Pass/total*100).toFixed(1)}%)`)
console.log(`Layer 3 (array):    ${l3Pass}/${total} (${(l3Pass/total*100).toFixed(1)}%)`)
console.log(`Full system:        ${fullPass}/${total} (${(fullPass/total*100).toFixed(1)}%)`)

// 按破坏类型统计
console.log('\n=== By Corruption Type ===\n')
const types = ['prefix_text', 'suffix_text', 'markdown_wrap', 'broken_braces', 'missing_outer']
for (const t of types) {
  const typeResults = results.filter(r => r.corruption_type === t)
  const typeFull = typeResults.filter(r => r.full_success).length
  const typeL2 = typeResults.filter(r => r.layer2_success).length
  const typeL3 = typeResults.filter(r => r.layer3_success).length
  console.log(`${t.padEnd(20)}: L2=${typeL2}/${typeResults.length}, L3=${typeL3}/${typeResults.length}, Full=${typeFull}/${typeResults.length}`)
}

// 保存结果
const outputPath = join(__dirname, '..', 'results', 'stress_test_layer3.json')
writeFileSync(outputPath, JSON.stringify({
  total,
  layer1_pass: l1Pass,
  layer2_pass: l2Pass,
  layer3_pass: l3Pass,
  full_pass: fullPass,
  by_corruption_type: types.map(t => {
    const tr = results.filter(r => r.corruption_type === t)
    return {
      type: t,
      total: tr.length,
      layer2_pass: tr.filter(r => r.layer2_success).length,
      layer3_pass: tr.filter(r => r.layer3_success).length,
      full_pass: tr.filter(r => r.full_success).length,
    }
  }),
  details: results,
}, null, 2))

console.log(`\nResults saved to: ${outputPath}`)

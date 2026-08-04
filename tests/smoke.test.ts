/**
 * 冒烟测试 (Smoke Test) — 验证核心算法可运行
 *
 * 覆盖:
 *   §3.2 三层渐进截断恢复 (parsePartialJson: Layer 1/2/3)
 *   §3.3 ICover 协议 (reduceStream 覆盖更新) vs Delta 模式 (reduceStreamDelta)
 *
 * 运行: npm test   (tsx tests/smoke.test.ts)
 */
import assert from 'node:assert/strict'
import { parsePartialJson } from '../src/partial-json-parser'
import { reduceStream, reduceStreamDelta } from '../src/icover-protocol'

let passed = 0
async function ok(name: string, fn: () => void | Promise<void>) {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

async function* gen(chunks: string[]) {
  for (const c of chunks) yield c
}

async function main() {
  // ── Layer 1: 完整 JSON 直接解析 ──
  await ok('L1 完整 JSON 直接解析', () => {
    const r = parsePartialJson('{"ingredients":[{"name":"Calcium"}]}')
    assert.equal(r.wasTruncated, false)
    assert.deepEqual(r.parsed, { ingredients: [{ name: 'Calcium' }] })
  })

  // ── Layer 2: 截断尾部 5 步预处理 + 枚举闭合 ──
  await ok('L2 未闭合字符串截断恢复', () => {
    const r = parsePartialJson('{"ingredients":[{"name":"Vitamin C')
    assert.equal(r.wasTruncated, true)
    assert.equal(r.recovered, true)
    assert.deepEqual(r.parsed, { ingredients: [{ name: 'Vitamin C' }] })
  })

  await ok('L2 尾随逗号截断恢复', () => {
    const r = parsePartialJson('{"ingredients":[{"name":"A","amount":900},')
    assert.equal(r.recovered, true)
    assert.deepEqual(r.parsed, { ingredients: [{ name: 'A', amount: 900 }] })
  })

  await ok('L2 嵌套对象截断恢复', () => {
    const r = parsePartialJson('{"ingredients":[{"name":"Vit D3","amount":"1000"')
    assert.equal(r.recovered, true)
    assert.deepEqual(r.parsed, { ingredients: [{ name: 'Vit D3', amount: '1000' }] })
  })

  // ── Layer 3: 动态 arrayKey 定向提取 ──
  await ok('L3 动态 arrayKey 定向提取', () => {
    const r = parsePartialJson('{"products":[{"id":1},{"id":2', 'products')
    assert.equal(r.recovered, true)
    assert.deepEqual(r.parsed, { products: [{ id: 1 }, { id: 2 }] })
  })

  // ── markdown 代码围栏剥离 ──
  await ok('markdown code fence 剥离', () => {
    const r = parsePartialJson('```json\n{"ingredients":[{"name":"A"}]}\n```')
    assert.equal(r.wasTruncated, false)
    assert.deepEqual(r.parsed, { ingredients: [{ name: 'A' }] })
  })

  // ── ICover 协议: 覆盖更新, 终态收敛到真值; 值非单调 (Cal → Calcium) ──
  await ok('ICover 覆盖更新 终态收敛', async () => {
    // 流式 chunk 是续接片段, 逐块拼接成完整 JSON
    const chunks = [
      '{"ingredients":[{"name":"Cal',
      'cium","amount":"100',
      '0","unit":"mg"}]}',
    ]
    const emitted: unknown[][] = []
    const final = await reduceStream(
      gen(chunks),
      'ingredients',
      (arr) => {
        emitted.push(arr)
        return arr
      },
    )
    // ICover 每个 chunk 后 emit 完整数组; 最后一次完整解析拿到真值
    const last = emitted[emitted.length - 1] as Array<Record<string, unknown>>
    assert.equal(last[0].name, 'Calcium')
    assert.equal(last[0].amount, '1000')
    assert.equal(last[0].unit, 'mg')
    // 最终返回与最后一次 emit 一致
    assert.deepEqual(final, last)
  })

  // ── Delta 模式: 仅 emit 新增切片 ──
  await ok('Delta 仅 emit 新增切片', async () => {
    // 流式 chunk 是续接片段, 逐块拼接成完整 JSON
    const chunks = [
      '{"ingredients":[{"name":"Cal',
      'cium","amount":"1000',
    ]
    const emitted: unknown[][] = []
    await reduceStreamDelta(
      gen(chunks),
      'ingredients',
      (delta) => {
        emitted.push(delta)
        return delta
      },
    )
    // Delta 每次只发新增行; 第一波 emit 1 行
    assert.ok(emitted.length >= 1)
    const last = emitted[emitted.length - 1] as Array<Record<string, unknown>>
    // Delta 每次只返回增量, 最后一次增量包含剩余的字符拼接后得到完整元素
    assert.equal(last.length, 1)
  })

  console.log(`\n全部 ${passed} 项冒烟测试通过 ✓`)
}

main().catch((e) => {
  console.error('\n测试失败:', e)
  process.exit(1)
})
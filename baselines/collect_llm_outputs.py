#!/usr/bin/env python3
"""
LLM 流式输出数据采集 (异步并发版)
==================================
论文模块: §5.2 数据集

对 5 种 JSON Schema 各请求 LLM 生成 SAMPLES_PER_SCHEMA 次完整 JSON,
在 5 个截断位置截断, 共 5000 个样本。

★ 安全机制: 第一个 schema 前 50 个样本完成后暂停, 等待用户确认。

用法:
  python baselines/collect_llm_outputs.py --model gpt-4o --schemas all
  python baselines/collect_llm_outputs.py --model gpt-4o --schemas supplement_facts --samples 50
  python baselines/collect_llm_outputs.py --model gpt-4o --schemas all --concurrency 5

环境变量:
  OPENAI_API_KEY=sk-xxx
  OPENAI_BASE_URL=https://api.openai.com/v1   (可选, 默认官方端点)
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

# ── 5 种 JSON Schema 定义 (论文表 4) ──

SCHEMAS = {
    "supplement_facts": {
        "description": "FDA Supplement Facts 标签",
        "nesting_depth": 3,
        "array_length_range": (5, 30),
        "string_complexity": "medium",
        "array_key": "ingredients",
        "prompt": """You are a nutrition label generator. Generate a realistic FDA Supplement Facts label as JSON.
Include 8-15 supplement ingredients with name, amount, unit, and %DV.
Also include meta fields: productName, servingSize, servingsPerContainer.
Return ONLY valid JSON, no markdown fences.

Schema:
{
  "productName": string,
  "servingSize": string,
  "servingsPerContainer": number,
  "ingredients": [
    {"name": string, "amount": string, "unit": string, "dailyValue": string}
  ]
}""",
    },
    "medical_record": {
        "description": "电子病历摘要",
        "nesting_depth": 4,
        "array_length_range": (3, 10),
        "string_complexity": "high",
        "array_key": "medications",
        "prompt": """Generate a realistic electronic medical record summary as JSON.
Include patient info, diagnoses array, medications array, and lab results array.
Return ONLY valid JSON, no markdown fences.

Schema:
{
  "patient": {"name": string, "age": number, "gender": string},
  "diagnoses": [{"code": string, "description": string}],
  "medications": [{"name": string, "dosage": string, "frequency": string}],
  "labResults": [{"test": string, "value": string, "unit": string, "referenceRange": string}]
}""",
    },
    "product_catalog": {
        "description": "电商产品目录",
        "nesting_depth": 3,
        "array_length_range": (10, 50),
        "string_complexity": "low",
        "array_key": "products",
        "prompt": """Generate a realistic e-commerce product catalog as JSON.
Include 15-30 products with name, price, category, and stock.
Return ONLY valid JSON, no markdown fences.

Schema:
{
  "catalogId": string,
  "lastUpdated": string,
  "products": [
    {"id": string, "name": string, "price": number, "category": string, "stock": number}
  ]
}""",
    },
    "financial_report": {
        "description": "季度财务报表",
        "nesting_depth": 4,
        "array_length_range": (5, 20),
        "string_complexity": "low",
        "array_key": "revenue",
        "prompt": """Generate a realistic quarterly financial report as JSON.
Include company info, quarter, revenue breakdown, and expenses breakdown.
Return ONLY valid JSON, no markdown fences.

Schema:
{
  "company": string,
  "quarter": string,
  "revenue": [{"category": string, "amount": number, "yoyChange": number}],
  "expenses": [{"category": string, "amount": number, "budgetVariance": number}]
}""",
    },
    "recipe_ingredients": {
        "description": "食谱配料表",
        "nesting_depth": 2,
        "array_length_range": (5, 15),
        "string_complexity": "medium",
        "array_key": "ingredients",
        "prompt": """Generate a realistic recipe with ingredients list as JSON.
Include recipe name, servings, prep time, and ingredients.
Return ONLY valid JSON, no markdown fences.

Schema:
{
  "recipeName": string,
  "servings": number,
  "prepTimeMinutes": number,
  "ingredients": [
    {"name": string, "amount": string, "unit": string}
  ]
}""",
    },
}

TRUNCATION_POSITIONS = [0.10, 0.25, 0.50, 0.75, 0.90]
SAMPLES_PER_SCHEMA = 200
DEFAULT_MODEL = os.getenv("EXP_MODEL", "gpt-4o")
DATA_DIR = Path(__file__).parent.parent / "data"
LLM_OUTPUTS_DIR = DATA_DIR / "llm_outputs"

for d in [DATA_DIR, LLM_OUTPUTS_DIR]:
    d.mkdir(parents=True, exist_ok=True)


async def call_llm_streaming(
    model: str, prompt: str, api_key: str, base_url: str,
    semaphore: asyncio.Semaphore
) -> tuple[str, list[dict]]:
    """异步调用 LLM 流式 API, 返回 (完整文本, chunk时间线)."""
    import httpx

    async with semaphore:
        url = f"{base_url}/chat/completions"
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        body = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": True,
            "temperature": 0.7,
        }

        chunks_timeline = []
        full_text = ""
        start_time = time.time()

        async with httpx.AsyncClient(timeout=300.0) as client:
            async with client.stream("POST", url, headers=headers, json=body) as resp:
                if resp.status_code != 200:
                    body_text = await resp.aread()
                    raise RuntimeError(f"HTTP {resp.status_code}: {body_text[:200]}")

                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                        delta = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
                        if delta:
                            full_text += delta
                            chunks_timeline.append({
                                "t_ms": int((time.time() - start_time) * 1000),
                                "len": len(delta),
                                "cumulative_len": len(full_text),
                            })
                    except json.JSONDecodeError:
                        continue

        return full_text, chunks_timeline


def truncate_at(text: str, position: float) -> str:
    """在指定位置截断文本 (position ∈ (0, 1))"""
    idx = int(len(text) * position)
    return text[:idx]


async def collect_schema(
    schema_id: str, schema: dict, model: str, api_key: str, base_url: str,
    samples: int, concurrency: int
):
    """采集一个 Schema 的所有样本"""
    schema_dir = LLM_OUTPUTS_DIR / schema_id
    schema_dir.mkdir(parents=True, exist_ok=True)

    semaphore = asyncio.Semaphore(concurrency)

    async def collect_one(idx: int):
        output_path = schema_dir / f"sample_{idx:04d}.json"
        if output_path.exists():
            print(f"  [{schema_id}] sample {idx} 已存在, 跳过")
            return

        try:
            full_text, timeline = await call_llm_streaming(
                model, schema["prompt"], api_key, base_url, semaphore
            )

            # 验证完整 JSON 可解析
            try:
                json.loads(full_text)
            except json.JSONDecodeError as e:
                print(f"  [{schema_id}] sample {idx} JSON 无效: {e}")
                return

            # 保存完整输出
            output = {
                "sample_id": f"{schema_id}_{idx:04d}",
                "schema": schema_id,
                "model": model,
                "complete_text": full_text,
                "timeline": timeline,
                "array_key": schema["array_key"],
            }
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(output, f, ensure_ascii=False)

            # 生成截断样本
            for pos in TRUNCATION_POSITIONS:
                truncated = truncate_at(full_text, pos)
                trunc_path = schema_dir / f"sample_{idx:04d}_trunc_{int(pos*100):03d}.json"
                with open(trunc_path, "w", encoding="utf-8") as f:
                    json.dump({
                        "sample_id": f"{schema_id}_{idx:04d}",
                        "schema": schema_id,
                        "truncation_pct": pos,
                        "buffer": truncated,
                        "complete_path": str(output_path),
                        "array_key": schema["array_key"],
                    }, f, ensure_ascii=False)

            print(f"  [{schema_id}] sample {idx} 完成 (len={len(full_text)})")
        except Exception as e:
            print(f"  [{schema_id}] sample {idx} 失败: {e}")

    # 安全机制: 第一个 schema 前 50 个样本完成后暂停
    if schema_id == "supplement_facts" and samples >= 50:
        print(f"\n[{schema_id}] 先采集 50 个样本, 完成后等待用户确认...")
        await asyncio.gather(*[collect_one(i) for i in range(50)])
        print(f"\n[{schema_id}] 前 50 个样本完成。检查数据质量后,")
        print(f"重新运行此命令并加上 --skip-confirm 以继续采集剩余 {samples - 50} 个样本。")
        if "--skip-confirm" not in sys.argv:
            return

    tasks = [collect_one(i) for i in range(samples)]
    await asyncio.gather(*tasks)


async def main():
    parser = argparse.ArgumentParser(description="LLM 流式输出数据采集")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"LLM 模型 (默认: {DEFAULT_MODEL})")
    parser.add_argument("--schemas", default="all", help="逗号分隔的 schema ID, 或 'all'")
    parser.add_argument("--samples", type=int, default=SAMPLES_PER_SCHEMA,
                        help=f"每个 schema 的样本数 (默认: {SAMPLES_PER_SCHEMA})")
    parser.add_argument("--concurrency", type=int, default=3, help="并发请求数 (默认: 3)")
    args = parser.parse_args()

    api_key = os.getenv("OPENAI_API_KEY", "")
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")

    if not api_key:
        print("ERROR: OPENAI_API_KEY 环境变量未设置")
        sys.exit(1)

    if args.schemas == "all":
        schema_ids = list(SCHEMAS.keys())
    else:
        schema_ids = [s.strip() for s in args.schemas.split(",")]

    print(f"\n{'='*60}")
    print(f"LLM Output Collection")
    print(f"Model: {args.model}")
    print(f"Base URL: {base_url}")
    print(f"Schemas: {schema_ids}")
    print(f"Samples per schema: {args.samples}")
    print(f"Truncation positions: {TRUNCATION_POSITIONS}")
    print(f"Total samples: {len(schema_ids) * args.samples * len(TRUNCATION_POSITIONS)}")
    print(f"Concurrency: {args.concurrency}")
    print(f"{'='*60}\n")

    for schema_id in schema_ids:
        if schema_id not in SCHEMAS:
            print(f"WARNING: 未知 schema '{schema_id}', 跳过")
            continue
        print(f"\n采集 {schema_id}...")
        await collect_schema(
            schema_id, SCHEMAS[schema_id], args.model, api_key, base_url,
            args.samples, args.concurrency
        )

    print(f"\n采集完成。数据保存至: {LLM_OUTPUTS_DIR}")


if __name__ == "__main__":
    asyncio.run(main())

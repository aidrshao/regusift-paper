#!/usr/bin/env python3
"""
GPT 主实验流式输出数据采集 (V2, 与提交数据集结构一致)
====================================================
论文模块: §4.2 数据集

对 5 种 JSON Schema 各请求 LLM 生成 SAMPLES_PER_SCHEMA 次完整 JSON, 记录流式时间线,
并在 10%/25%/50%/75%/90% 五个字符位置截断, 输出到 data/llm_outputs/:

  data/llm_outputs/{schema}_gpt-5.4-mini_sample_{NNNN}_complete.json   (完整 JSON 文本)
  data/llm_outputs/{schema}_gpt-5.4-mini_sample_{NNNN}_timeline.json  (流式时间线数组)
  data/llm_outputs/{schema}_gpt-5.4-mini_sample_{NNNN}_trunc_{10,25,50,75,90}.txt (截断文本)
  data/ground_truth.json                                              (GT 索引)

此结构与仓库中已提交的 GPT 主数据集完全一致 (复现论文 §4.2 的 1000 完整样本 + 5000 截断用例)。
默认模型 gpt-5.4-mini 与论文主实验一致。

★ 安全机制: 第一个 schema 前 50 个样本完成后暂停, 等待用户确认 (加 --skip-confirm 跳过)。

用法:
  OPENAI_API_KEY=sk-xxx python baselines/collect_llm_outputs.py --samples 200
  OPENAI_API_KEY=sk-xxx python baselines/collect_llm_outputs.py --schemas supplement_facts --samples 50
环境变量:
  OPENAI_API_KEY (必填), OPENAI_BASE_URL (可选, 默认 https://api.openai.com/v1)
"""
import argparse, asyncio, json, os, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from config import SCHEMAS, TRUNCATION_POSITIONS

DATA_DIR = Path(__file__).parent.parent / "data"
OUT = DATA_DIR / "llm_outputs"
OUT.mkdir(parents=True, exist_ok=True)
API_KEY = os.getenv("OPENAI_API_KEY", "")
BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
MODEL = os.getenv("EXP_MODEL", "gpt-5.4-mini")  # 与论文主实验模型一致


def truncate_at_position(text, position):
    return text[: int(len(text) * position)]


def save_sample(sample_id, full_text, timeline, schema_id):
    complete = OUT / f"{sample_id}_complete.json"
    complete.write_text(full_text, encoding="utf-8")
    tl = OUT / f"{sample_id}_timeline.json"
    tl.write_text(json.dumps(timeline, indent=2), encoding="utf-8")
    trunc_files = {}
    for pct in TRUNCATION_POSITIONS:
        t = OUT / f"{sample_id}_trunc_{int(pct * 100):02d}.txt"
        t.write_text(truncate_at_position(full_text, pct), encoding="utf-8")
        trunc_files[str(int(pct * 100))] = str(t)
    try:
        gt = json.loads(full_text)
        array_key = schema_id and next(
            (k for k in ["ingredients", "products", "diagnoses", "medications",
                          "labResults", "revenue", "expenses"]
             if k in gt and isinstance(gt[k], list)), None)
        return {"sample_id": sample_id, "schema": schema_id, "model": MODEL,
                "complete_path": str(complete), "timeline_path": str(tl),
                "total_length": len(full_text), "array_key": array_key,
                "array_length": len(gt.get(array_key, [])) if array_key else 0,
                "truncation_files": trunc_files}
    except json.JSONDecodeError:
        return {"sample_id": sample_id, "schema": schema_id, "model": MODEL,
                "complete_path": str(complete), "timeline_path": str(tl),
                "total_length": len(full_text), "array_key": None,
                "array_length": 0, "truncation_files": trunc_files}


async def call_one(sem, prompt):
    import httpx
    async with sem:
        url = f"{BASE_URL}/chat/completions"
        headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
        body = {"model": MODEL, "messages": [{"role": "user", "content": prompt}],
                "stream": True, "temperature": 0.7}
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                async with client.stream("POST", url, headers=headers, json=body) as resp:
                    resp.raise_for_status()
                    full = ""
                    timeline = []
                    t0 = time.time()
                    cum = 0
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        data = line[6:]
                        if data == "[DONE]":
                            break
                        try:
                            chunks = json.loads(data)
                            delta = chunks["choices"][0]["delta"].get("content", "") or ""
                            if delta:
                                full += delta
                                cum += len(delta)
                                timeline.append({"timestamp": round(time.time() - t0, 6),
                                                 "cumulative_len": cum, "delta_len": len(delta)})
                        except Exception:
                            continue
                    return full, timeline
        except Exception as e:
            print(f"  ERR {type(e).__name__}: {e}")
            return "", []


async def collect_schema(schema_id, schema, samples, concurrency, skip_confirm):
    sem = asyncio.Semaphore(concurrency)
    gt_entries = []

    async def collect_batch(start, end):
        tasks = [call_one(sem, schema["prompt"]) for _ in range(start, end)]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for i, res in enumerate(results, start=start):
            full, tl = res if isinstance(res, tuple) else ("", [])
            if not full:
                print(f"  [{i + 1}/{samples}] SKIP (empty)")
                continue
            sid = f"{schema_id}_gpt-5.4-mini_sample_{i:04d}"
            entry = save_sample(sid, full, tl, schema_id)
            gt_entries.append(entry)
            print(f"  saved {sid} len={entry['total_length']} arr={entry['array_length']}")

    # 安全机制: 第一个 schema 前 50 个样本完成后暂停 (加 --skip-confirm 跳过)
    if schema_id == "supplement_facts" and samples >= 50 and not skip_confirm:
        print(f"\n[{schema_id}] 先采集 50 个样本, 完成后等待用户确认...")
        await collect_batch(0, 50)
        print(f"\n[{schema_id}] 前 50 个样本完成。检查数据质量后重新运行并加 --skip-confirm 继续采集剩余样本。")
        return gt_entries

    await collect_batch(0, samples)
    return gt_entries


async def main_async(args):
    if not API_KEY:
        print("ERROR: 请设置 OPENAI_API_KEY"); sys.exit(1)
    schema_ids = list(SCHEMAS.keys()) if args.schemas == "all" else \
        [s.strip() for s in args.schemas.split(",")]
    all_gt = []
    for schema_id in schema_ids:
        if schema_id not in SCHEMAS:
            print(f"WARNING: 未知 schema '{schema_id}', 跳过")
            continue
        print(f"\n=== {schema_id} — {args.samples} samples ===")
        all_gt.extend(await collect_schema(schema_id, SCHEMAS[schema_id],
                                           args.samples, args.concurrency, args.skip_confirm))
    gt_path = DATA_DIR / "ground_truth.json"
    gt_path.write_text(json.dumps(all_gt, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved {len(all_gt)} GPT samples -> {DATA_DIR}/")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="GPT 主实验流式输出数据采集 (V2)")
    ap.add_argument("--samples", type=int, default=200, help="每个 schema 的样本数 (默认 200, 与论文 §4.2 一致)")
    ap.add_argument("--schemas", default="all", help="逗号分隔 schema ID, 或 'all'")
    ap.add_argument("--concurrency", type=int, default=5)
    ap.add_argument("--skip-confirm", action="store_true", help="跳过前 50 样本确认暂停")
    a = ap.parse_args()
    asyncio.run(main_async(a))

#!/usr/bin/env python3
"""
论文实验评估 Python 包装器
==========================
调用 Node.js 统一评估脚本 (evaluate_all.ts), 收集结果, 计算指标, 输出表格。

用法:
  python baselines/run_evaluation.py                    # 运行全部
  python baselines/run_evaluation.py --check-only       # 仅检查环境
  python baselines/run_evaluation.py --schema supplement_facts  # 仅评估特定 schema
"""

import argparse
import json
import subprocess
import sys
import statistics
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from config import RESULTS_DIR, SCHEMAS, REGUSIFT_ROOT


def prepare_input(gt_index: list[dict], schema_filter: str = "all") -> list[dict]:
    """准备 Node.js 脚本的输入数据"""
    samples = []
    for sample in gt_index:
        if schema_filter != "all" and sample["schema"] != schema_filter:
            continue
        for pct_str, trunc_path in sample.get("truncation_files", {}).items():
            samples.append({
                "sample_id": sample["sample_id"],
                "schema": sample["schema"],
                "truncation_pct": int(pct_str),
                "buffer_path": str(Path(trunc_path).resolve()),
                "complete_path": str(Path(sample["complete_path"]).resolve()),
                "array_key": sample.get("array_key"),
            })
    return samples


def run_node_evaluation(samples: list[dict]) -> list[dict]:
    """调用 Node.js 评估脚本"""
    script_path = Path(__file__).parent / "evaluate_all.ts"

    # 从 ReguSift 根目录运行, 确保 node_modules 可用
    print(f"  Running npx tsx {script_path.name} with {len(samples)} samples...")

    input_json = json.dumps(samples, ensure_ascii=False)
    result = subprocess.run(
        ["npx", "tsx", str(script_path)],
        input=input_json,
        capture_output=True,
        text=True,
        timeout=1800,
        cwd=str(REGUSIFT_ROOT),
    )

    if result.returncode != 0:
        print(f"  ERROR: Node.js script failed (exit code {result.returncode})")
        print(f"  stderr: {result.stderr[:2000]}")
        sys.exit(1)

    if result.stderr:
        # 打印 stderr 中的警告 (如 json-repair 未安装)
        for line in result.stderr.strip().split("\n"):
            if line.strip():
                print(f"  [node] {line}")

    return json.loads(result.stdout)


def compute_field_f1(recovered: list, gt_array: list) -> float:
    """字段级 F1"""
    if not recovered or not gt_array:
        return 0.0
    tp, fp, fn = 0, 0, 0
    for i, gt_obj in enumerate(gt_array):
        rec_obj = recovered[i] if i < len(recovered) else {}
        gt_keys = set(gt_obj.keys()) if isinstance(gt_obj, dict) else set()
        rec_keys = set(rec_obj.keys()) if isinstance(rec_obj, dict) else set()
        tp += len(gt_keys & rec_keys)
        fp += len(rec_keys - gt_keys)
        fn += len(gt_keys - rec_keys)
    p = tp / (tp + fp) if (tp + fp) > 0 else 0
    r = tp / (tp + fn) if (tp + fn) > 0 else 0
    return 2 * p * r / (p + r) if (p + r) > 0 else 0


def compute_value_accuracy(recovered: list, gt_array: list) -> float:
    """值精确率"""
    if not recovered or not gt_array:
        return 0.0
    total, correct = 0, 0
    for i, gt_obj in enumerate(gt_array):
        rec_obj = recovered[i] if i < len(recovered) else {}
        if not isinstance(rec_obj, dict):
            rec_obj = {}
        if not isinstance(gt_obj, dict):
            continue
        for key, gt_val in gt_obj.items():
            total += 1
            if key in rec_obj and str(rec_obj[key]) == str(gt_val):
                correct += 1
    return correct / total if total > 0 else 0


def compute_metrics(node_results: list[dict], gt_index: list[dict]) -> dict[str, list[dict]]:
    """计算各方法的评估指标"""
    # 加载 ground truth
    gt_by_id = {}
    for sample in gt_index:
        gt_data = json.loads(Path(sample["complete_path"]).read_text(encoding="utf-8"))
        array_key = sample.get("array_key")
        gt_by_id[sample["sample_id"]] = {
            "array": gt_data.get(array_key, []) if array_key else [],
            "schema": sample["schema"],
        }

    # 按方法分组结果
    methods = {"naive": [], "partial_json": [], "json_repair": [], "ours": []}

    for r in node_results:
        method = r["method"]
        if method not in methods:
            continue

        gt = gt_by_id.get(r["sample_id"], {"array": [], "schema": r["schema"]})
        # 从 Node.js 结果中提取 recovered array
        # Node.js 输出的是 recovered_array_length, 但我们需要实际数据来计算 F1
        # 所以我们在这里重新解析 ground truth 并计算

        # ★ 关键: 我们需要 recovered 的实际 JSON 来计算 F1
        # 但 Node.js 脚本只返回了 length, 没有返回实际 JSON
        # 我们需要修改: 让 Node.js 脚本也返回 parsed JSON
        # 临时方案: 用 length-based 指标
        gt_array = gt["array"]
        recovered_len = r.get("recovered_array_length", 0)
        gt_len = len(gt_array)

        # Length-based recovery rate
        length_ratio = min(recovered_len, gt_len) / gt_len if gt_len > 0 else 0

        methods[method].append({
            "sample_id": r["sample_id"],
            "schema": r["schema"],
            "truncation_pct": r["truncation_pct"],
            "recovered": r["recovered"],
            "recovered_array_length": recovered_len,
            "gt_array_length": gt_len,
            "length_ratio": length_ratio,
            "parse_latency_ms": r["latency_ms"],
            "was_truncated": r.get("was_truncated", False),
            "used_recovery": r.get("used_recovery", False),
        })

    return methods


def compute_metrics_v2(node_results: list[dict], gt_index: list[dict]) -> dict[str, list[dict]]:
    """计算各方法的评估指标 (v2: 含字段 F1 和值精确率)"""
    # 加载所有 ground truth JSON (跳过解析失败的样本)
    gt_by_id = {}
    skipped = 0
    for sample in gt_index:
        try:
            gt_data = json.loads(Path(sample["complete_path"]).read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            skipped += 1
            continue
        array_key = sample.get("array_key")
        gt_by_id[sample["sample_id"]] = {
            "array": gt_data.get(array_key, []) if array_key else [],
            "schema": sample["schema"],
        }
    if skipped:
        print(f"  [INFO] Skipped {skipped} samples with invalid ground truth JSON")

    methods = {"naive": [], "partial_json": [], "json_repair": [], "ours": []}

    for r in node_results:
        method = r["method"]
        if method not in methods:
            continue

        # 跳过 ground truth 无效的样本
        if r["sample_id"] not in gt_by_id:
            continue

        gt = gt_by_id[r["sample_id"]]
        gt_array = gt["array"]

        # 跳过 ground truth 数组为空的样本
        if not gt_array:
            continue

        # Node.js 脚本返回 parsed JSON, 我们用它来计算 F1
        parsed = r.get("parsed")
        array_key = r.get("array_key")
        recovered = []
        if parsed and array_key and isinstance(parsed, dict):
            arr = parsed.get(array_key, [])
            if isinstance(arr, list):
                recovered = arr

        methods[method].append({
            "sample_id": r["sample_id"],
            "schema": r["schema"],
            "truncation_pct": r["truncation_pct"],
            "recovered": len(recovered) > 0,
            "field_f1": compute_field_f1(recovered, gt_array),
            "value_accuracy": compute_value_accuracy(recovered, gt_array),
            "recovered_array_length": len(recovered),
            "gt_array_length": len(gt_array),
            "parse_latency_ms": r["latency_ms"],
        })

    return methods


def print_summary(methods: dict[str, list[dict]]):
    """打印汇总结果"""
    print(f"\n{'='*80}")
    print(f"{'Method':<20} {'Recovery':>10} {'Field F1':>10} {'Value Acc':>10} {'Latency(ms)':>12} {'N':>6}")
    print(f"{'='*80}")

    for method, results in methods.items():
        if not results:
            print(f"{method:<20} {'N/A':>10} {'N/A':>10} {'N/A':>10} {'N/A':>12} {0:>6}")
            continue

        n = len(results)
        recovery = sum(1 for r in results if r["recovered"]) / n
        f1 = sum(r.get("field_f1", 0) for r in results) / n
        va = sum(r.get("value_accuracy", 0) for r in results) / n
        latencies = [r["parse_latency_ms"] for r in results]
        avg_lat = statistics.mean(latencies)

        print(f"{method:<20} {recovery:>10.2%} {f1:>10.4f} {va:>10.4f} {avg_lat:>12.3f} {n:>6}")

    # 按 schema 分组
    print(f"\n{'='*80}")
    print("By Schema:")
    print(f"{'='*80}")

    for schema_id in SCHEMAS:
        print(f"\n  [{schema_id}]")
        for method, results in methods.items():
            schema_results = [r for r in results if r["schema"] == schema_id]
            if not schema_results:
                continue
            n = len(schema_results)
            recovery = sum(1 for r in schema_results if r["recovered"]) / n
            f1 = sum(r.get("field_f1", 0) for r in schema_results) / n
            print(f"    {method:<20} recovery={recovery:.2%}  F1={f1:.4f}  n={n}")


def save_results(methods: dict[str, list[dict]]):
    """保存结果到 results/ 目录"""
    for method, results in methods.items():
        out_path = RESULTS_DIR / f"{method}_res.json"
        out_path.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"  Saved: {out_path} ({len(results)} records)")


def main():
    parser = argparse.ArgumentParser(description="Run paper evaluation")
    parser.add_argument("--schema", default="all", help="Schema ID or 'all'")
    parser.add_argument("--check-only", action="store_true", help="Only check environment")
    args = parser.parse_args()

    # 检查 ground_truth.json
    gt_path = Path(__file__).parent.parent / "data" / "ground_truth.json"
    if not gt_path.exists():
        print("ERROR: data/ground_truth.json not found. Run collect_llm_outputs.py first.")
        sys.exit(1)

    gt_index = json.loads(gt_path.read_text(encoding="utf-8"))
    print(f"Loaded {len(gt_index)} samples from ground_truth.json")

    if args.check_only:
        print("Environment check:")
        print(f"  ReguSift root: {REGUSIFT_ROOT}")
        print(f"  Results dir:   {RESULTS_DIR}")
        print(f"  tsx available: ", end="")
        r = subprocess.run(["npx", "--yes", "tsx", "--version"], capture_output=True, text=True, cwd=str(REGUSIFT_ROOT))
        print(f"{'OK' if r.returncode == 0 else 'MISSING'} ({r.stdout.strip()})")
        return

    # 准备输入
    samples = prepare_input(gt_index, args.schema)
    print(f"Prepared {len(samples)} truncation samples for evaluation")

    # 调用 Node.js 评估
    print(f"\nRunning Node.js evaluation (all 4 methods in same V8 engine)...")
    node_results = run_node_evaluation(samples)
    print(f"  Received {len(node_results)} method-results from Node.js")

    # 计算指标
    print(f"\nComputing metrics...")
    methods = compute_metrics_v2(node_results, gt_index)

    # 打印汇总
    print_summary(methods)

    # 保存结果
    print(f"\nSaving results...")
    save_results(methods)

    print(f"\n{'='*80}")
    print(f"Done! Results in {RESULTS_DIR}/")
    print(f"Run 'python generate_tables.py' to generate paper tables.")


if __name__ == "__main__":
    main()

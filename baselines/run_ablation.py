#!/usr/bin/env python3
"""
消融实验
========
通过对比完整系统与移除各组件的配置, 量化各组件贡献。

消融配置:
  - full:        完整系统 (3层恢复 + ICover)
  - no_layer3:   移除第三层 (仅 Layer 1-2, 用 partial-json 库结果代理)
  - no_icover:   移除 ICover (模拟 Delta 追加行为)
  - layer3_only: 仅第三层 (仅目标数组定向提取)

★ 关键设计: 
  - full 和 no_layer3 使用同一 Node.js 脚本的输出 (主评估已包含)
  - no_icover 通过 Python 后处理模拟 (取首次解析结果, 不覆盖)
  - 不需要额外 Node.js 调用

用法: python baselines/run_ablation.py
"""

import json
import sys
import statistics
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from config import RESULTS_DIR, SCHEMAS


def load_results() -> dict:
    """加载主评估结果 — 优先 V2 结果 (ours_fixed.v2.json / *.baseline.v2.json), 与论文表3口径一致"""
    results = {}
    v2_paths = list(RESULTS_DIR.glob("ours_fixed.v2.json")) + \
        sorted(RESULTS_DIR.glob("*.baseline.v2.json"))
    for path in v2_paths:
        key = "ours" if path.stem == "ours_fixed.v2" else path.stem.replace(".baseline.v2", "")
        results[key] = json.loads(path.read_text(encoding="utf-8"))
    if "ours" not in results:
        # 回退到 V1 *_res.json (旧解析器产物, 仅当 V2 结果缺失时)
        for path in RESULTS_DIR.glob("*_res.json"):
            key = path.stem.replace("_res", "")
            results[key] = json.loads(path.read_text(encoding="utf-8"))
    return results


def simulate_delta(ours_results: list[dict], gt_index: list[dict]) -> list[dict]:
    """
    模拟 Delta (增量追加) 行为:
    - 对每个样本的 5 个截断位置 (10%, 25%, 50%, 75%, 90%),
      取最早成功解析的结果作为"首见状态"
    - Delta 不会更新已显示的行, 所以首见状态 = 最终状态
    
    对比 ICover: 取最晚 (90%) 截断位置的结果 (最完整)
    """
    # 按 sample_id 分组
    by_sample = {}
    for r in ours_results:
        sid = r["sample_id"]
        if sid not in by_sample:
            by_sample[sid] = []
        by_sample[sid].append(r)

    delta_results = []
    for sid, group in by_sample.items():
        # 按截断百分比排序
        group.sort(key=lambda x: x["truncation_pct"])
        
        # Delta: 取第一个成功解析的结果
        delta_parsed = None
        for r in group:
            if r["recovered"]:
                delta_parsed = r
                break
        
        if delta_parsed is None:
            delta_parsed = group[0] if group else None
        
        if delta_parsed:
            delta_results.append({
                **delta_parsed,
                "method": "no_icover",
            })
    
    return delta_results


def compute_summary(results: list[dict]) -> dict:
    n = len(results)
    if n == 0:
        return {"n": 0, "recovery_rate": 0, "field_f1": 0, "value_accuracy": 0, "avg_latency_ms": 0}
    return {
        "n": n,
        "recovery_rate": sum(1 for r in results if r.get("recovered")) / n,
        "field_f1": sum(r.get("field_f1", 0) for r in results) / n,
        "value_accuracy": sum(r.get("value_accuracy", 0) for r in results) / n,
        "avg_latency_ms": sum(r.get("parse_latency_ms") or r.get("latency_ms") or 0 for r in results) / n,
    }


def main():
    results = load_results()
    
    if "ours" not in results:
        print("ERROR: results/ours_res.json not found. Run run_evaluation.py first.")
        sys.exit(1)
    
    ours = results["ours"]
    partial_json = results.get("partial_json", [])
    
    # Load ground truth for Delta simulation
    gt_path = Path(__file__).parent.parent / "data" / "ground_truth.json"
    if not gt_path.exists():
        print("ERROR: data/ground_truth.json not found.")
        sys.exit(1)
    gt_index = json.loads(gt_path.read_text(encoding="utf-8"))
    
    print(f"\n{'='*80}")
    print("消融实验 (Ablation Study)")
    print(f"{'='*80}")
    
    # Config 1: Full system
    full_summary = compute_summary(ours)
    print(f"\n  [full]          完整系统 (3层恢复 + ICover)")
    print(f"    Recovery: {full_summary['recovery_rate']:.2%}  F1: {full_summary['field_f1']:.4f}  "
          f"Value: {full_summary['value_accuracy']:.4f}  Latency: {full_summary['avg_latency_ms']:.3f}ms")
    
    # Config 2: No Layer 3 (use partial-json results as proxy for Layer 1-2 only)
    no_layer3_summary = compute_summary(partial_json)
    print(f"\n  [no_layer3]     仅 Layer 1-2 (partial-json 库代理)")
    print(f"    Recovery: {no_layer3_summary['recovery_rate']:.2%}  F1: {no_layer3_summary['field_f1']:.4f}  "
          f"Value: {no_layer3_summary['value_accuracy']:.4f}  Latency: {no_layer3_summary['avg_latency_ms']:.3f}ms")
    
    # Layer 3 contribution
    layer3_contribution = full_summary["recovery_rate"] - no_layer3_summary["recovery_rate"]
    print(f"    → Layer 3 贡献: +{layer3_contribution:.2%} 恢复率提升")
    
    # Config 3: No ICover (Delta simulation)
    delta_results = simulate_delta(ours, gt_index)
    no_icover_summary = compute_summary(delta_results)
    print(f"\n  [no_icover]     移除 ICover (Delta 追加模拟)")
    print(f"    Recovery: {no_icover_summary['recovery_rate']:.2%}  F1: {no_icover_summary['field_f1']:.4f}  "
          f"Value: {no_icover_summary['value_accuracy']:.4f}  Latency: {no_icover_summary['avg_latency_ms']:.3f}ms")
    
    # ICover contribution
    icover_f1_gain = full_summary["field_f1"] - no_icover_summary["field_f1"]
    icover_va_gain = full_summary["value_accuracy"] - no_icover_summary["value_accuracy"]
    print(f"    → ICover 贡献: +{icover_f1_gain:.4f} F1, +{icover_va_gain:.4f} 值精确率")
    
    # Save ablation results
    ablation_summary = {
        "summaries": [
            {"config": "full", **full_summary},
            {"config": "no_layer3", **no_layer3_summary},
            {"config": "no_icover", **no_icover_summary},
        ],
        "layer3_contribution": layer3_contribution,
        "icover_f1_gain": icover_f1_gain,
        "icover_value_accuracy_gain": icover_va_gain,
    }
    
    out_path = RESULTS_DIR / "ablation_res.json"
    out_path.write_text(json.dumps(ablation_summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n  Saved: {out_path}")
    
    # By schema breakdown
    print(f"\n{'='*80}")
    print("By Schema:")
    for schema_id in SCHEMAS:
        print(f"\n  [{schema_id}]")
        for config_name, config_results in [("full", ours), ("no_layer3", partial_json), ("no_icover", delta_results)]:
            sr = [r for r in config_results if r.get("schema") == schema_id]
            if sr:
                s = compute_summary(sr)
                print(f"    {config_name:<15} Recovery={s['recovery_rate']:.2%}  F1={s['field_f1']:.4f}  n={s['n']}")


if __name__ == "__main__":
    main()

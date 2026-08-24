#!/usr/bin/env python3
"""
完整评估 (V2 修复版)
====================
调用 baselines/evaluate_fixed.ts (解析器取 V2 修复版, 消除幽灵键+Layer3 字符串感知),
计算各方法 恢复率 / 字段 F1 / 值精确率 / 延迟。

用法:
  python baselines/run_evaluation_fixed.py
"""
import json
import subprocess
import sys
import statistics
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from config import SCHEMAS, RESULTS_DIR

GT = Path(__file__).parent.parent / "data" / "ground_truth.v2.json"
SCRIPT = Path(__file__).parent / "evaluate_fixed.ts"


def prepare_input(gt_index):
    samples = []
    for sample in gt_index:
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


def run_node(samples):
    input_json = json.dumps(samples, ensure_ascii=False)
    r = subprocess.run(
        ["npx", "--yes", "tsx", str(SCRIPT)],
        input=input_json, capture_output=True, text=True, timeout=3600,
    )
    if r.returncode != 0:
        print("  ERROR:", r.stderr[:1500]); sys.exit(1)
    if r.stderr:
        for line in r.stderr.strip().split("\n"):
            if line.strip() and 'WARN' in line:
                print(f"  [node] {line}")
    return json.loads(r.stdout)


def compute_field_f1(recovered, gt_array):
    if not recovered or not gt_array:
        return 0.0
    tp = fp = fn = 0
    for i, gt_obj in enumerate(gt_array):
        rec_obj = recovered[i] if i < len(recovered) else {}
        gk = set(gt_obj.keys()) if isinstance(gt_obj, dict) else set()
        rk = set(rec_obj.keys()) if isinstance(rec_obj, dict) else set()
        tp += len(gk & rk); fp += len(rk - gk); fn += len(gk - rk)
    p = tp / (tp + fp) if (tp + fp) else 0
    r = tp / (tp + fn) if (tp + fn) else 0
    return 2 * p * r / (p + r) if (p + r) else 0


def compute_value_accuracy(recovered, gt_array):
    if not recovered or not gt_array:
        return 0.0
    total = correct = 0
    for i, gt_obj in enumerate(gt_array):
        rec_obj = recovered[i] if i < len(recovered) else {}
        if not isinstance(rec_obj, dict): rec_obj = {}
        if not isinstance(gt_obj, dict): continue
        for key, gv in gt_obj.items():
            total += 1
            if key in rec_obj and str(rec_obj[key]) == str(gv):
                correct += 1
    return correct / total if total else 0


def main():
    gt_index = json.load(open(GT, encoding="utf-8"))
    gt_by_id = {}
    skipped = 0
    for s in gt_index:
        try:
            d = json.load(open(s["complete_path"], encoding="utf-8"))
        except json.JSONDecodeError:
            skipped += 1; continue
        ak = s.get("array_key")
        gt_by_id[s["sample_id"]] = {"array": d.get(ak, []) if ak else [], "schema": s["schema"]}
    print(f"Loaded {len(gt_index)} samples; skipped invalid GT: {skipped}")

    samples = prepare_input(gt_index)
    print(f"Prepared {len(samples)} truncation samples; calling evaluate_fixed.ts...")
    node_results = run_node(samples)
    print(f"  received {len(node_results)} method-results")

    methods = {"naive": [], "partial_json": [], "json_repair": [], "ours_fixed": []}
    usable = 0
    for r in node_results:
        # 统一到 ours_fixed 键 (全部由修复版评估脚本产生, 其 'ours' 即修复版)
        method = "ours_fixed" if r["method"] == "ours" else r["method"]
        if method not in methods: continue
        if r["sample_id"] not in gt_by_id: continue
        gt = gt_by_id[r["sample_id"]]
        arr = gt["array"]
        if not arr: continue
        parsed = r.get("parsed"); ak = r.get("array_key")
        recovered = []
        if parsed and ak and isinstance(parsed, dict) and isinstance(parsed.get(ak), list):
            recovered = parsed[ak]
        methods[method].append({
            "sample_id": r["sample_id"], "schema": r["schema"], "truncation_pct": r["truncation_pct"],
            "recovered": len(recovered) > 0,
            "field_f1": compute_field_f1(recovered, arr),
            "value_accuracy": compute_value_accuracy(recovered, arr),
            "recovered_array_length": len(recovered), "gt_array_length": len(arr),
            "parse_latency_ms": r["latency_ms"],
        })
        usable += 1

    print(f"\n{'='*78}")
    print(f"{'Method':<14}{'Recovery':>10}{'Field F1':>10}{'Val Acc':>9}{'Latency':>10}{'N':>7}")
    print("="*78)
    for m, res in methods.items():
        if not res:
            print(f"{m:<14}{'N/A':>10}{'N/A':>10}{'N/A':>9}{'N/A':>10}{0:>7}"); continue
        n = len(res)
        rec = sum(1 for x in res if x["recovered"]) / n
        f1 = sum(x["field_f1"] for x in res) / n
        va = sum(x["value_accuracy"] for x in res) / n
        lat = statistics.mean([x["parse_latency_ms"] for x in res])
        print(f"{m:<14}{rec:>10.2%}{f1:>10.4f}{va:>9.4f}{lat:>10.3f}{n:>7}")

    # By schema
    print(f"\nBy Schema:")
    for sid in SCHEMAS:
        print(f"  [{sid}]")
        for m, res in methods.items():
            sr = [x for x in res if x["schema"] == sid]
            if not sr: continue
            n = len(sr)
            rec = sum(1 for x in sr if x["recovered"]) / n
            f1 = sum(x["field_f1"] for x in sr) / n
            print(f"    {m:<14} rec={rec:.2%}  F1={f1:.4f}  n={n}")

    # 保存
    out = {}
    for m, res in methods.items():
        out[m] = res
        (RESULTS_DIR / f"{m}.v2.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved per-method v2 results to {RESULTS_DIR}/")


if __name__ == "__main__":
    main()
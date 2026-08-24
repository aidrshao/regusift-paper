#!/usr/bin/env python3
"""
时序指标 (T7) 驱动 — time-to-correct-value & stale-value rate
=============================================================
对三份数据 (主GPT / DeepSeek / gemma4) 跑 temporal_metrics.ts,
汇总三种更新语义的时序指标, 判断 ICover 覆盖 vs 诚实重发是否时序等价。
输出: results/temporal_metrics_{model}.json + 汇总
"""
import json, subprocess, sys, statistics, argparse
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

ROOT = Path(__file__).parent.parent
SCRIPT = ROOT / "baselines" / "temporal_metrics.ts"
RESULTS = ROOT / "results"

# (输入GT, 输出名, 模型标签)
DATASETS = [
    ("data/ground_truth.v2.json", "temporal_metrics_gpt.json", "GPT-5.4-mini"),
    ("data/deepseek/ground_truth.json", "temporal_metrics_deepseek.json", "DeepSeek"),
    ("data/gemma4/ground_truth.json", "temporal_metrics_gemma4.json", "gemma4"),
]

def run_one(gt_path: Path) -> list:
    gt = json.load(open(gt_path, encoding="utf-8"))
    inputs = []
    for s in gt:
        tl = s.get("timeline_path")
        if tl and Path(tl).exists():
            inputs.append({"sample_id": s["sample_id"], "schema": s["schema"],
                           "complete_path": s["complete_path"], "timeline_path": tl,
                           "array_key": s.get("array_key")})
    print(f"  [{gt_path.name}] {len(inputs)} timeline samples")
    if not inputs:
        return []
    r = subprocess.run(["npx", "--yes", "tsx", str(SCRIPT)],
                       input=json.dumps(inputs, ensure_ascii=False),
                       capture_output=True, text=True, timeout=7200)
    if r.returncode != 0:
        print("NODE ERR:", r.stderr[:1500]); sys.exit(1)
    return json.loads(r.stdout)

def agg(res: list, filter_sem=None, filter_schema=None):
    """聚合时序指标: 返回 {sem: {ttct, stale, n}}"""
    rows = {}
    for x in res:
        if filter_sem and x["semantics"] != filter_sem: continue
        if filter_schema and x["schema"] != filter_schema: continue
        rows.setdefault(x["semantics"], []).append(x)
    out = {}
    for sem, rs in rows.items():
        n = len(rs)
        # deltaF 的 ttct=0 无意义(从未正确), 单独标记
        if sem == "deltaF":
            never = sum(1 for x in rs if x["ttct_obj_s"] == 0)
            out[sem] = {"n": n, "stale_ratio": sum(x["stale_ratio"] for x in rs)/n,
                        "ttct_obj_s": sum(x["ttct_obj_s"] for x in rs)/n,
                        "never_correct_pct": 100*never/n,
                        "first_ts_s": statistics.mean(x["first_ts_s"] for x in rs)}
        else:
            out[sem] = {"n": n, "stale_ratio": sum(x["stale_ratio"] for x in rs)/n,
                        "ttct_obj_s": sum(x["ttct_obj_s"] for x in rs)/n,
                        "first_ts_s": statistics.mean(x["first_ts_s"] for x in rs)}
    return out

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=int, default=None, help="只跑某个数据集 0/1/2")
    parser.add_argument("--schema", type=str, default=None, help="只聚合某个schema")
    a = parser.parse_args()

    datasets = DATASETS if a.dataset is None else [DATASETS[a.dataset]]
    for gt_rel, out_name, label in datasets:
        gt_path = ROOT / gt_rel
        res = run_one(gt_path)
        if not res:
            print(f"[{label}] 无线程样本, 跳过")
            continue
        (RESULTS / out_name).write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n=== {label} 时序指标 (results/{out_name}) ===")
        agg_map = agg(res, filter_schema=a.schema)
        print(f"{'语义':<8}{'time-to-correct/s':>18}{'stale比例':>11}{'首字段时刻/s':>13}{'从末正确%':>11}{'N':>8}")
        hint = f"schema={a.schema}" if a.schema else "总体"
        for sem in ["icover", "deltaR", "jsonPatch", "crdt", "deltaF"]:
            if sem not in agg_map: continue
            d = agg_map[sem]
            nvc = f"{d.get('never_correct_pct',0):.1f}%" if sem=="deltaF" else "  — "
            print(f"{sem:<8}{d['ttct_obj_s']:>10.3f}{' '*6}{d['stale_ratio']:>9.1%}{' '*2}{d['first_ts_s']:>10.3f}{' '*3}{nvc:>10}{d['n']:>9}")
        # 关键对比: icover vs deltaR
        if "icover" in agg_map and "deltaR" in agg_map:
            i, d = agg_map["icover"], agg_map["deltaR"]
            dttct = abs(i["ttct_obj_s"] - d["ttct_obj_s"])
            dstage = abs(i["stale_ratio"] - d["stale_ratio"])
            print(f"  → ICover vs deltaR: |Δttct|={dttct:.4f}s, |Δstale|={dstage:.4f} ({hint})")
        if "deltaF" in agg_map:
            f = agg_map["deltaF"]
            print(f"  → deltaF 陈旧占比 {f['stale_ratio']:.1%}, 从未正确的对象占比 {f.get('never_correct_pct',0):.1f}% ({hint})")

if __name__ == "__main__":
    main()
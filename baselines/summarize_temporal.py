#!/usr/bin/env python3
"""T7 时序指标汇总 — 生成论文可用的总体+分Schema表 (results/temporal_summary.json)"""
import json, statistics
from collections import defaultdict
from pathlib import Path

RESULTS = Path(__file__).parent.parent / "results"

FILES = ["temporal_metrics_gpt.json", "temporal_metrics_deepseek.json", "temporal_metrics_gemma4.json"]
LABELS = ["GPT-5.4-mini", "DeepSeek", "gemma4"]

def mean(xs): return sum(xs)/len(xs) if xs else 0.0

summary = {}
for fname, label in zip(FILES, LABELS):
    res = json.load(open(RESULTS/fname))
    by = defaultdict(lambda: defaultdict(list))  # schema -> sem -> [rec]
    for x in res:
        by[x["schema"]][x["semantics"]].append(x)

    def metrics(sem):
        recs = [r for r in res if r["semantics"] == sem]
        n = len(recs)
        ttct = mean([r["ttct_obj_s"] for r in recs])
        stale = mean([r["stale_ratio"] for r in recs])
        never = 100*sum(1 for r in recs if r["ttct_obj_s"] == 0)/max(1, n)
        return {"n": n, "ttct_s": round(ttct,4), "stale_ratio": round(stale,4), "never_correct_pct": round(never,1)}

    entry = {"label": label}
    entry["overall"] = {sem: metrics(sem) for sem in ["icover", "deltaR", "jsonPatch", "crdt", "deltaF"]}
    entry["by_schema"] = {}
    for s in sorted(by):
        entry["by_schema"][s] = {}
        for sem in ["icover", "deltaR", "jsonPatch", "crdt", "deltaF"]:
            if sem not in by[s]: continue
            recs = by[s][sem]
            ttct = mean([r["ttct_obj_s"] for r in recs])
            stale = mean([r["stale_ratio"] for r in recs])
            entry["by_schema"][s][sem] = {"n": len(recs), "ttct_s": round(ttct,4), "stale_ratio": round(stale,4)}
    summary[label] = entry

out = RESULTS / "temporal_summary.json"
out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

print(f"=== 时序指标汇总 (results/temporal_summary.json) ===\n")
print(f"{'模型':<14}{'语义':<8}{'ttct/s':>8}{'stale%':>10}{'未正确%':>10}{'N':>7}")
for label in LABELS:
    o = summary[label]["overall"]
    for sem in ["icover", "deltaR", "jsonPatch", "crdt", "deltaF"]:
        d = o[sem]
        print(f"{label:<14}{sem:<8}{d['ttct_s']:>8.3f}{100*d['stale_ratio']:>9.1f}%{d['never_correct_pct']:>9.1f}%{d['n']:>8}")
    print()
# 关键结论
print("=== 关键对比 ===")
for label in LABELS:
    o = summary[label]["overall"]
    i, d = o["icover"], o["deltaR"]
    print(f"{label}: ICover vs deltaR — Δttct={abs(i['ttct_s']-d['ttct_s']):.4f}s, Δstale={abs(i['stale_ratio']-d['stale_ratio']):.4f}  (等效?)")
    print(f"     deltaF stale={100*o['deltaF']['stale_ratio']:.1f}%")
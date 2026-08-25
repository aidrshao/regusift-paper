#!/usr/bin/env python3
"""
幽灵键实测 (V2, 封闭"幽灵键代价未实测"争议)
========================================
在真实 4965 有效截断用例上, 对 7 种方法逐一统计:
  - ghost_fields      : 恢复数组元素中"存在但不属于 GT 元素"的字段数 (幽灵键)
  - ghost_per_element : ghost_fields / 被比对元素数 (每元素幽灵键数)
  - empty_or_null_elem: 恢复数组中为空对象 {} 或 null 的元素数 (partial-json 的部分补造现象, 非幽灵键)
按方法 + 按 Schema 聚合, 输出 results/ghost_key_count.json。

用法: python3 baselines/measure_ghost_keys.py
"""
import json, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

ROOT = Path(__file__).parent.parent
GT = ROOT / "data" / "ground_truth.json"
SCRIPT = ROOT / "baselines" / "evaluate_baselines.ts"
METHODS = ["naive", "partial_json", "json_repair", "json_completer", "best_effort", "tolerant_repair", "ours"]

def prepare(gt_index):
    samples = []
    for s in gt_index:
        for pct, tr in s.get("truncation_files", {}).items():
            samples.append({"sample_id": s["sample_id"], "schema": s["schema"], "truncation_pct": int(pct),
                            "buffer_path": str(Path(tr).resolve()), "complete_path": str(Path(s["complete_path"]).resolve()),
                            "array_key": s.get("array_key")})
    return samples

def run_node(samples):
    r = subprocess.run(["npx", "--yes", "tsx", str(SCRIPT)], input=json.dumps(samples, ensure_ascii=False),
                       capture_output=True, text=True, timeout=7200)
    if r.returncode != 0:
        print("NODE ERR:", r.stderr[:1200]); sys.exit(1)
    return json.loads(r.stdout)

def main():
    gt_index = json.load(open(GT, encoding="utf-8"))
    gt_by_id = {}
    for s in gt_index:
        try:
            d = json.load(open(s["complete_path"], encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        ak = s.get("array_key")
        gt_by_id[s["sample_id"]] = {"array": d.get(ak, []) if ak else [], "schema": s["schema"]}

    samples = prepare(gt_index)
    print(f"Prepared {len(samples)} samples; running evaluate_baselines.ts...")
    nr = run_node(samples)
    print(f"  got {len(nr)} results")

    # 逐方法累计
    stat = {m: {"n_samples": 0, "n_recovered": 0, "n_elements": 0, "ghost_fields": 0,
                "empty_or_null_elem": 0, "by_schema": {}} for m in METHODS}
    for r in nr:
        m = "ours" if r["method"] == "ours" else r["method"]
        if m not in stat:
            continue
        if r["sample_id"] not in gt_by_id:
            continue
        g = gt_by_id[r["sample_id"]]
        gt_arr = g["array"]
        if not gt_arr:
            continue
        stat[m]["n_samples"] += 1
        p = r.get("parsed"); ak = r.get("array_key")
        rec = p[ak] if (p and ak and isinstance(p, dict) and isinstance(p.get(ak), list)) else []
        sid = g["schema"]
        if sid not in stat[m]["by_schema"]:
            stat[m]["by_schema"][sid] = {"n_recovered": 0, "n_elements": 0, "ghost_fields": 0, "empty_or_null_elem": 0}
        if not rec:
            continue
        stat[m]["n_recovered"] += 1
        stat[m]["by_schema"][sid]["n_recovered"] += 1
        for i, go in enumerate(gt_arr):
            ro = rec[i] if i < len(rec) else None
            if ro is None:
                stat[m]["empty_or_null_elem"] += 1
                stat[m]["by_schema"][sid]["empty_or_null_elem"] += 1
                continue
            if not isinstance(ro, dict):
                stat[m]["empty_or_null_elem"] += 1
                stat[m]["by_schema"][sid]["empty_or_null_elem"] += 1
                continue
            if not isinstance(go, dict):
                continue
            stat[m]["n_elements"] += 1
            stat[m]["by_schema"][sid]["n_elements"] += 1
            ghost = set(ro.keys()) - set(go.keys())
            stat[m]["ghost_fields"] += len(ghost)
            stat[m]["by_schema"][sid]["ghost_fields"] += len(ghost)
            # 空对象元素 (有 GT 键但恢复为空对象) — partial-json 的部分补造现象
            if len(ro) == 0 and len(go) > 0:
                stat[m]["empty_or_null_elem"] += 1
                stat[m]["by_schema"][sid]["empty_or_null_elem"] += 1

    print(f"\n{'Method':<18}{'N':>7}{'Recovered':>10}{'GhostFields':>12}{'Ghost/Elem':>11}{'EmptyOrNull':>12}")
    summary = {}
    for m in METHODS:
        s = stat[m]
        gpe = s["ghost_fields"] / s["n_elements"] if s["n_elements"] else 0
        summary[m] = {"n_samples": s["n_samples"], "n_recovered": s["n_recovered"],
                      "n_elements": s["n_elements"], "ghost_fields": s["ghost_fields"],
                      "ghost_per_element": round(gpe, 4), "empty_or_null_elem": s["empty_or_null_elem"],
                      "by_schema": s["by_schema"]}
        print(f"{m:<18}{s['n_samples']:>7}{s['n_recovered']:>10}{s['ghost_fields']:>12}{gpe:>11.4f}{s['empty_or_null_elem']:>12}")

    print("\nBy Schema (Ghost/Elem):")
    for m in METHODS:
        line = [f"{m:<16}"]
        for sid, v in stat[m]["by_schema"].items():
            gpe = v["ghost_fields"] / v["n_elements"] if v["n_elements"] else 0
            line.append(f"{sid}:{gpe:.4f}")
        print("  " + "  ".join(line))

    out = ROOT / "results" / "ghost_key_count.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved {out}")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
消融实验驱动 (V2)：全系统 vs 去 Layer3 vs 去字符串感知 vs 去 ICover
=====
分两块:
  A) 更新语义消融 (三种语义 icover/deltaR/deltaF) — 基于真实 timeline
  B) 组件消融 (为基线对比中 ours 的 F1 提供 Layer3/字符串感知 贡献)
本脚本先跑 A(语义消融), B 通过重跑解析器开关实现。
"""
import json, subprocess, sys, statistics, argparse
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import RESULTS_DIR, SCHEMAS

GT = Path(__file__).parent.parent / "data" / "ground_truth.v2.json"
SCRIPT = Path(__file__).parent / "ablation_v2.ts"

def main():
    gt = json.load(open(GT, encoding="utf-8"))
    # 只取有 timeline 的样本 (消融需要完整流时间线)
    inputs=[]
    for s in gt:
        tl = s.get("timeline_path")
        if tl and Path(tl).exists():
            inputs.append({"sample_id":s["sample_id"],"schema":s["schema"],
                           "complete_path":s["complete_path"],"timeline_path":tl,"array_key":s.get("array_key")})
    print(f"Loaded {len(inputs)} timeline samples")
    # 冒烟: 默认全部跑 (可 --limit 调试)
    parser=argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=len(inputs))
    a=parser.parse_args()
    use = inputs[:a.limit]
    r = subprocess.run(["npx","--yes","tsx",str(SCRIPT)], input=json.dumps(use,ensure_ascii=False),
                       capture_output=True, text=True, timeout=7200)
    if r.returncode!=0: print("NODE ERR:", r.stderr[:1500]); sys.exit(1)
    res=json.loads(r.stdout)
    print(f"got {len(res)} results ({len(use)} samples x 3 semantics)")

    rows={k:[] for k in ["icover","deltaR","deltaF"]}
    for x in res: rows[x["semantics"]].append(x)

    print(f"\n{'='*84}\n{'Semantics':<10}{'FieldF1':>10}{'ValAcc':>9}{'Conv%':>8}{'KeyPres%':>9}{'lenR':>7}{'N':>7}\n{'='*84}")
    for sem in ["icover","deltaR","deltaF"]:
        rs=rows[sem]
        if not rs: print(f"{sem:<10}{'N/A':>10}"); continue
        n=len(rs)
        f1=sum(x["field_f1"] for x in rs)/n
        va=sum(x["value_accuracy"] for x in rs)/n
        conv=sum(1 for x in rs if x["converged"])/n
        kp=sum(1 for x in rs if x["key_preserved"]>=1 and x["semantics"]=="icover")/max(1,n)
        lens=statistics.mean(x["final_len"] for x in rs)
        print(f"{sem:<10}{f1:>10.4f}{va:>9.4f}{conv:>8.2%}{kp:>9.2%}{lens:>7.1f}{n:>7}")

    # By schema (FieldF1)
    print(f"\nBy Schema (FieldF1):")
    for sid in SCHEMAS:
        print(f"  [{sid}]")
        for sem in ["icover","deltaR","deltaF"]:
            sr=[x for x in rows[sem] if x["schema"]==sid]
            if not sr: continue
            n=len(sr)
            f1=sum(x["field_f1"] for x in sr)/n
            va=sum(x["value_accuracy"] for x in sr)/n
            print(f"    {sem:<10} F1={f1:.4f} ValAcc={va:.4f} n={n}")

    # Save
    (RESULTS_DIR/"ablation_v2_semantics.json").write_text(json.dumps(res,ensure_ascii=False,indent=2),encoding="utf-8")
    summary={}
    for sem in ["icover","deltaR","deltaF"]:
        rs=rows[sem]
        if rs:
            summary[sem]={"n":len(rs),"field_f1":sum(x["field_f1"] for x in rs)/len(rs),
                          "value_accuracy":sum(x["value_accuracy"] for x in rs)/len(rs),
                          "converged_rate":sum(1 for x in rs if x["converged"])/len(rs)}
    (RESULTS_DIR/"ablation_v2_semantics_summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"\nSaved to {RESULTS_DIR}/ablation_v2_semantics*.json")

if __name__=="__main__": main()
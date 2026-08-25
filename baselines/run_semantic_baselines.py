#!/usr/bin/env python3
"""语义层基线对比驱动 (V2): icover / jsonpatch / crdt_lww / buffered"""
import json, subprocess, sys, statistics, argparse
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import RESULTS_DIR, SCHEMAS

GT = Path(__file__).parent.parent / "data" / "ground_truth.json"
SCRIPT = Path(__file__).parent / "semantic_baselines.ts"

def main():
    gt = json.load(open(GT, encoding="utf-8"))
    inputs=[]
    for s in gt:
        tl = s.get("timeline_path")
        if tl and Path(tl).exists():
            inputs.append({"sample_id":s["sample_id"],"schema":s["schema"],
                           "complete_path":s["complete_path"],"timeline_path":tl,"array_key":s.get("array_key")})
    parser=argparse.ArgumentParser(); parser.add_argument("--limit",type=int,default=len(inputs))
    a=parser.parse_args(); use=inputs[:a.limit]
    print(f"timeline samples: {len(use)}")
    r=subprocess.run(["npx","--yes","tsx",str(SCRIPT)],input=json.dumps(use,ensure_ascii=False),
                     capture_output=True,text=True,timeout=7200)
    if r.returncode!=0: print("NODE ERR:",r.stderr[:1500]); sys.exit(1)
    res=json.loads(r.stdout)
    rows={k:[] for k in ["icover","jsonpatch","crdt_lww","buffered"]}
    for x in res: rows[x["method"]].append(x)
    print(f"got {len(res)} results")

    print(f"\n{'='*86}\n{'Method':<12}{'FieldF1':>10}{'ValAcc':>9}{'Conv%':>8}{'KeyPres%':>10}{'N':>7}\n{'='*86}")
    for m in ["icover","jsonpatch","crdt_lww","buffered"]:
        rs=rows[m]; 
        if not rs: print(f"{m:<12}{'N/A':>10}"); continue
        n=len(rs); f1=sum(x["field_f1"] for x in rs)/n; va=sum(x["value_accuracy"] for x in rs)/n
        conv=sum(1 for x in rs if x["converged"])/n
        kp=sum(1 for x in rs if x["key_preserved"]>=1)/n if m=="icover" else -1
        print(f"{m:<12}{f1:>10.4f}{va:>9.4f}{conv:>8.2%}{('%.2f%%'%(kp*100)) if kp>=0 else '-':>10}{n:>7}")

    print(f"\nBy Schema (FieldF1):")
    for sid in SCHEMAS:
        print(f"  [{sid}]")
        for m in ["icover","jsonpatch","crdt_lww","buffered"]:
            sr=[x for x in rows[m] if x["schema"]==sid]
            if not sr: continue
            n=len(sr); f1=sum(x["field_f1"] for x in sr)/n; va=sum(x["value_accuracy"] for x in sr)/n
            print(f"    {m:<12} F1={f1:.4f} ValAcc={va:.4f} n={n}")

    (RESULTS_DIR/"semantic_baselines.json").write_text(json.dumps(res,ensure_ascii=False,indent=2),encoding="utf-8")
    summary={}
    for m in ["icover","jsonpatch","crdt_lww","buffered"]:
        rs=rows[m]
        if rs: summary[m]={"n":len(rs),"field_f1":sum(x["field_f1"] for x in rs)/len(rs),
                          "value_accuracy":sum(x["value_accuracy"] for x in rs)/len(rs),
                          "converged_rate":sum(1 for x in rs if x["converged"])/len(rs)}
    (RESULTS_DIR/"semantic_baselines_summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"\nSaved to {RESULTS_DIR}/semantic_baselines*.json")

if __name__=="__main__": main()
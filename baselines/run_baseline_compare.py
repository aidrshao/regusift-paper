#!/usr/bin/env python3
"""
基线对比驱动 (V2 修复版 vs 外部基线)
调用 evaluate_baselines.ts (6 个外部基线 + Ours 修复版),
输出统一的 Recovery / Field F1 / Val Acc / Latency 汇总。
"""
import json, subprocess, sys, statistics, shutil
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import SCHEMAS, RESULTS_DIR

GT = Path(__file__).parent.parent / "data" / "ground_truth.json"
SCRIPT = Path(__file__).parent / "evaluate_baselines.ts"

def prepare(gt_index):
    samples=[]
    for s in gt_index:
        for pct,tr in s.get("truncation_files",{}).items():
            samples.append({"sample_id":s["sample_id"],"schema":s["schema"],"truncation_pct":int(pct),
                            "buffer_path":str(Path(tr).resolve()),"complete_path":str(Path(s["complete_path"]).resolve()),"array_key":s.get("array_key")})
    return samples

def run_node(samples):
    r = subprocess.run(["npx","--yes","tsx",str(SCRIPT)], input=json.dumps(samples,ensure_ascii=False),
                       capture_output=True, text=True, timeout=7200)
    if r.returncode!=0: print("ERR:",r.stderr[:1500]); sys.exit(1)
    return json.loads(r.stdout)

def ff1(rec, gt):
    if not rec or not gt: return 0.0
    tp=fp=fn=0
    for i,go in enumerate(gt):
        ro=rec[i] if i<len(rec) else {}
        if go is None: go={}
        if ro is None: ro={}
        gk=set(go.keys()); rk=set(ro.keys())
        tp+=len(gk&rk); fp+=len(rk-gk); fn+=len(gk-rk)
    p=tp/(tp+fp) if tp+fp else 0; r=tp/(tp+fn) if tp+fn else 0
    return 2*p*r/(p+r) if p+r else 0

def vacc(rec, gt):
    if not rec or not gt: return 0.0
    tot=c=0
    for i,go in enumerate(gt):
        ro=rec[i] if i<len(rec) else {}
        if go is None: continue
        if ro is None: ro={}
        if not isinstance(ro,dict): ro={}
        if not isinstance(go,dict): continue
        for k,gv in go.items():
            tot+=1
            if k in ro and str(ro[k])==str(gv): c+=1
    return c/tot if tot else 0

METHOD_LABEL = {"naive":"B1 naive","partial_json":"B2 partial-json","json_repair":"B3 json-repair",
                "json_completer":"B4 JsonCompleter","best_effort":"B5 best-effort","tolerant_repair":"B6 tolerant-repair","ours":"Ours(修复版)"}
ORDER = ["naive","partial_json","json_repair","json_completer","best_effort","tolerant_repair","ours"]

def main():
    gt_index=json.load(open(GT,encoding="utf-8"))
    gt_by_id={}; skipped=0
    for s in gt_index:
        try: d=json.load(open(s["complete_path"],encoding="utf-8"))
        except json.JSONDecodeError: skipped+=1; continue
        ak=s.get("array_key"); gt_by_id[s["sample_id"]]={"array": d.get(ak,[]) if ak else [],"schema":s["schema"]}
    print(f"Loaded {len(gt_index)} samples; skipped invalid GT:{skipped}")
    samples=prepare(gt_index)
    print(f"Prepared {len(samples)} samples; running evaluate_baselines.ts...")
    nr=run_node(samples)
    print(f"  got {len(nr)} results")

    methods={k:[] for k in ORDER}
    for r in nr:
        m="ours" if r["method"]=="ours" else r["method"]
        if m not in methods: continue
        if r["sample_id"] not in gt_by_id: continue
        g=gt_by_id[r["sample_id"]]; arr=g["array"]
        if not arr: continue
        rec=[]
        p=r.get("parsed"); ak=r.get("array_key")
        if p and ak and isinstance(p,dict) and isinstance(p.get(ak),list): rec=p[ak]
        methods[m].append({"sample_id":r.get("sample_id"),"schema":r["schema"],"truncation_pct":r.get("truncation_pct"),
                           "recovered":len(rec)>0,"field_f1":ff1(rec,arr),
                           "value_accuracy":vacc(rec,arr),"latency_ms":r["latency_ms"]})

    print(f"\n{'='*80}\n{'Method':<18}{'Recovery':>10}{'FieldF1':>9}{'ValAcc':>9}{'Lat(ms)':>9}{'N':>7}\n{'='*80}")
    for m in ORDER:
        res=methods[m]
        if not res: print(f"{METHOD_LABEL[m]:<18}{'N/A':>10}{'N/A':>9}{'N/A':>9}{'N/A':>9}{0:>7}"); continue
        n=len(res); rec=sum(x["recovered"] for x in res)/n
        f1=sum(x["field_f1"] for x in res)/n; va=sum(x["value_accuracy"] for x in res)/n
        lat=statistics.mean(x["latency_ms"] for x in res)
        print(f"{METHOD_LABEL[m]:<18}{rec:>10.2%}{f1:>9.4f}{va:>9.4f}{lat:>9.3f}{n:>7}")

    # By schema
    print(f"\nBy Schema (FieldF1):")
    for sid in SCHEMAS:
        print(f"  [{sid}]")
        for m in ORDER:
            sr=[x for x in methods[m] if x["schema"]==sid]
            if not sr: continue
            n=len(sr); f1=sum(x["field_f1"] for x in sr)/n; rec=sum(x["recovered"] for x in sr)/n
            print(f"    {METHOD_LABEL[m]:<18} rec={rec:.2%} F1={f1:.4f} n={n}")

    for m in ORDER:
        (RESULTS_DIR/f"{m}.baseline.v2.json").write_text(json.dumps(methods[m],ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"\nSaved to {RESULTS_DIR}/ <method>.baseline.v2.json")

    # 也复制一份基线汇总便于后续表生成
    summary={}
    for m in ORDER:
        res=methods[m]
        if res:
            summary[m]={"n":len(res),"recovery":sum(x["recovered"] for x in res)/len(res),
                        "field_f1":sum(x["field_f1"] for x in res)/len(res),
                        "value_accuracy":sum(x["value_accuracy"] for x in res)/len(res),
                        "latency_ms":statistics.mean(x["latency_ms"] for x in res)}
    (RESULTS_DIR/"baseline_compare_summary.v2.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")

if __name__=="__main__": main()
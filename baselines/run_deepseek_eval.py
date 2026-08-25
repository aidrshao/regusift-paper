#!/usr/bin/env python3
"""
DeepSeek 数据评估 (V2, P6)
=========================
对 deepseek 采集的 500 样本, 用 evaluate_baselines.ts 跑 7 方法, 输出恢复率/F1/值精确率。
结果与 GPT-5.4-mini 主数据对比, 验证架构无关性。
"""
import json, subprocess, sys, statistics
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import SCHEMAS
from reproducibility.log_experiment import record

ROOT = Path(__file__).parent.parent
GT = ROOT/"data"/"deepseek"/"ground_truth.json"
SCRIPT = ROOT/"baselines"/"evaluate_baselines.ts"
NOS = {s:0 for s in SCHEMAS}  # 每种schema前N个样本

def prepare(gt, n_per_schema):
    picked = {s:0 for s in SCHEMAS}
    samples=[]
    for s in gt:
        sid=s["schema"]
        if n_per_schema and picked[sid]>=n_per_schema: continue
        picked[sid]+=1
        for pct,tr in s.get("truncation_files",{}).items():
            samples.append({"sample_id":s["sample_id"],"schema":sid,"truncation_pct":int(pct),
                            "buffer_path":str(Path(tr).resolve()),"complete_path":str(Path(s["complete_path"]).resolve()),"array_key":s.get("array_key")})
    return samples

def run_node(samples):
    r=subprocess.run(["npx","--yes","tsx",str(SCRIPT)],input=json.dumps(samples,ensure_ascii=False),
                     capture_output=True,text=True,timeout=7200)
    if r.returncode!=0: print("NODE ERR:",r.stderr[:1200]); sys.exit(1)
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
    tot=0; c=0
    for i,go in enumerate(gt):
        ro=rec[i] if i<len(rec) else {}
        if go is None: continue
        if ro is None: ro={}
        for k,gv in go.items():
            tot+=1
            if k in ro and str(ro[k])==str(gv): c+=1
    return c/tot if tot else 0

def main():
    import argparse
    ap=argparse.ArgumentParser(); ap.add_argument("--n_per_schema",type=int,default=100)
    a=ap.parse_args()
    gt=json.load(open(GT,encoding="utf-8"))
    # 加载 gt 数组
    gt_by_id={}
    for s in gt:
        try: d=json.load(open(s["complete_path"],encoding="utf-8"))
        except: continue
        ak=s.get("array_key")
        gt_by_id[s["sample_id"]]={"array": d.get(ak,[]) if ak else [],"schema":s["schema"]}
    samples=prepare(gt,a.n_per_schema)
    print(f"DeepSeek samples: {len(gt)} gt, {len(samples)} trunc samples")
    nr=run_node(samples)
    print(f"got {len(nr)} results")

    methods={k:[] for k in ["naive","partial_json","json_repair","json_completer","best_effort","tolerant_repair","ours"]}
    for r in nr:
        m="ours" if r["method"]=="ours" else r["method"]
        if m not in methods: continue
        if r["sample_id"] not in gt_by_id: continue
        g=gt_by_id[r["sample_id"]]; arr=g["array"]
        if not arr: continue
        rec=[]
        p=r.get("parsed"); ak=r.get("array_key")
        if p and ak and isinstance(p,dict) and isinstance(p.get(ak),list): rec=p[ak]
        methods[m].append({"schema":r["schema"],"recovered":len(rec)>0,"field_f1":ff1(rec,arr),
                           "value_accuracy":vacc(rec,arr)})
    print(f"\n{'Method':<18}{'Recovery':>10}{'FieldF1':>9}{'ValAcc':>9}{'N':>6}")
    for m in ["naive","partial_json","json_repair","json_completer","best_effort","tolerant_repair","ours"]:
        res=methods[m]
        if not res: print(f"{m:<18}{'N/A':>10}"); continue
        n=len(res); rec=sum(x["recovered"] for x in res)/n; f1=sum(x["field_f1"] for x in res)/n; va=sum(x["value_accuracy"] for x in res)/n
        print(f"{m:<18}{rec:>10.2%}{f1:>9.4f}{va:>9.4f}{n:>6}")
    print("\nBy Schema (Ours):")
    for sid in SCHEMAS:
        sr=[x for x in methods["ours"] if x["schema"]==sid]
        if not sr: continue
        n=len(sr); rec=sum(x["recovered"] for x in sr)/n; f1=sum(x["field_f1"] for x in sr)/n
        print(f"  {sid:<20} rec={rec:.2%} F1={f1:.4f} n={n}")
    # 记录
    summary={}
    for m in methods:
        res=methods[m]
        if res: summary[m]={"recovery":sum(x["recovered"] for x in res)/len(res),"field_f1":sum(x["field_f1"] for x in res)/len(res),"n":len(res)}
    outpath=ROOT/"results"/"deepseek_eval.json"
    outpath.write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"\nSaved {outpath}")
    # 日志
    record("deepseek_eval", params={"model":"deepseek-chat","n_per_schema":a.n_per_schema,"parser":"fixed"},
           inputs={"gt_json":str(GT),"script":str(SCRIPT)}, outputs={f.name:"" for f in [outpath]},
           metrics=summary, notes="500 deepseek samples, 同V8沙箱, 架构无关性验证")

if __name__=="__main__": main()
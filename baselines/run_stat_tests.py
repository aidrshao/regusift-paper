#!/usr/bin/env python3
"""
统计检验 (V2, 对应 P8)
=======================
重新调用 evaluate_baselines.ts 获得带 sample_id 的样本级结果, 计算:
  1) 各方法 恢复率 / 字段F1 的 bootstrap 95% CI (按样本重采样)
  2) Ours(修复版) vs 各基线 的 配对显著性检验:
     - 字段F1: 样品级配对差值 ~ 配对t + bootstrap差异CI + 符号检验(Wilcoxon)
     - 恢复率: 样品级正确/错误二值 ~ McNemar 检验
输出: results/stat_tests_v2.json + 表格
"""
import json, subprocess, sys, statistics, random
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import RESULTS_DIR

GT = Path(__file__).parent.parent/"data"/"ground_truth.v2.json"
SCRIPT = Path(__file__).parent/"evaluate_baselines.ts"
random.seed(42)

def prepare(gt_index):
    samples=[]
    for s in gt_index:
        for pct,tr in s.get("truncation_files",{}).items():
            samples.append({"sample_id":s["sample_id"],"schema":s["schema"],"truncation_pct":int(pct),
                            "buffer_path":str(Path(tr).resolve()),"complete_path":str(Path(s["complete_path"]).resolve()),"array_key":s.get("array_key")})
    return samples

def run_node(samples):
    r=subprocess.run(["npx","--yes","tsx",str(SCRIPT)],input=json.dumps(samples,ensure_ascii=False),
                     capture_output=True,text=True,timeout=7200)
    if r.returncode!=0: print("ERR:",r.stderr[:1200]); sys.exit(1)
    return json.loads(r.stdout)

def ff1(rec, gt):
    if not rec or not gt: return 0.0
    tp=fp=fn=0
    for i,go in enumerate(gt):
        ro=rec[i] if i<len(rec) else {}
        gk=set(go.keys()) if isinstance(go,dict) else set(); rk=set(ro.keys()) if isinstance(ro,dict) else set()
        tp+=len(gk&rk); fp+=len(rk-gk); fn+=len(gk-rk)
    p=tp/(tp+fp) if tp+fp else 0; r=tp/(tp+fn) if tp+fn else 0
    return 2*p*r/(p+r) if p+r else 0

def bootstrap_ci(vals, metric_fn, n_boot=2000, alpha=0.05):
    """对每个样本一个标量(如 F1 or 0/1), 求总体均值的 bootstrap CI"""
    lo=alpha/2*100; hi=(1-alpha/2)*100
    means=[]
    n=len(vals)
    for _ in range(n_boot):
        s=random.choices(vals,k=n)
        means.append(statistics.mean(s))
    means.sort()
    return means[int(lo/100*n_boot)], statistics.mean(vals), means[int(hi/100*n_boot)-1]

def main():
    gt=json.load(open(GT,encoding="utf-8"))
    # 建 GT 索引
    gt_by_id={}; 
    for s in gt:
        try: d=json.load(open(s["complete_path"],encoding="utf-8"))
        except: continue
        ak=s.get("array_key")
        gt_by_id[s["sample_id"]]={"array": d.get(ak,[]) if ak else [],"schema":s["schema"]}
    samples=prepare(gt)
    print(f"calling evaluate_baselines.ts ({len(samples)} samples)...")
    nr=run_node(samples)
    print(f"got {len(nr)} results")

    # 组织 per (sample_id,truncation_pct) method -> f1, recovered
    from collections import defaultdict
    data=defaultdict(dict)  # (sid,pct) -> {method:{f1,rec}}
    for r in nr:
        sid=r["sample_id"]; import re
        pct=r.get("truncation_pct")
        if sid not in gt_by_id: continue
        g=gt_by_id[sid]; arr=g["array"]
        if not arr: continue
        rec=[]
        p=r.get("parsed"); ak=r.get("array_key")
        if p and ak and isinstance(p,dict) and isinstance(p.get(ak),list): rec=p[ak]
        key=(sid,pct)
        data[key][("ours" if r["method"]=="ours" else r["method"])]={"f1":ff1(rec,arr),"rec":len(rec)>0}

    methods=["naive","partial_json","json_repair","json_completer","best_effort","tolerant_repair","ours"]
    # 各方法 bootstrap CI (对每个(key)取其F1)
    rows={m:[] for m in methods}
    for key in data:
        for m in methods:
            if m in data[key]: rows[m].append(data[key][m]["f1"])
    print(f"\n{'Method':<16}{'MeanF1':>9}{'95%CI_low':>12}{'CI_high':>10}{'N':>6}")
    cis={}
    for m in methods:
        v=rows[m]
        if not v: print(f"{m:<16}{'N/A':>9}"); continue
        lo,mean,hi=bootstrap_ci(v, lambda x:x)
        cis[m]=(lo,mean,hi)
        print(f"{m:<16}{mean:>9.4f}{lo:>12.4f}{hi:>10.4f}{len(v):>6}")

    # 配对: Ours vs 各基线 (按 key 配对)
    print(f"\n配对显著性 (Ours修复版 vs 基线, 同 sample 配对):")
    print(f"{'Pair':<30}{'ΔF1':>8}{'p(t)':>8}{'DiffCI90':>14}{'p(wilc)':>8}{'McNemar p(recovery)':>20}")
    pairs={}
    for base in ["partial_json","json_repair","json_completer","best_effort","tolerant_repair"]:
        diffs=[]; rec_pairs=[]
        for key in data:
            if "ours" in data[key] and base in data[key]:
                diffs.append(data[key]["ours"]["f1"]-data[key][base]["f1"])
                rec_pairs.append((data[key]["ours"]["rec"],data[key][base]["rec"]))
        if not diffs: continue
        # 配对t
        import math
        dmean=statistics.mean(diffs)
        nsq=len(diffs)
        sd=statistics.stdev(diffs) if len(diffs)>1 else 0
        se=sd/math.sqrt(nsq) if nsq>1 else 0
        t_stat=dmean/se if se else 0
        # p(t) 近似正态双尾
        p_t=2*(1-normal_cdf(abs(t_stat)))
        # bootstrap Diff CI (90%)
        diff_means=[]
        for _ in range(2000):
            ds=random.choices(diffs,k=len(diffs)); diff_means.append(statistics.mean(ds))
        diff_means.sort()
        ci90=(diff_means[50],diff_means[-51])
        # wilcoxon 符号秩近似 (用 z = (W+ - npairs(n+1)/4)/sqrt(n(n+1)(2n+1)/24))
        from itertools import combinations
        # 简化: 用符号检验 (二项)
        npos=sum(1 for d in diffs if d>0); nneg=sum(1 for d in diffs if d<0)
        p_sym=2*binom_tail(npos,nneg)
        # McNemar recovery
        b=c=0
        for o,p in rec_pairs:
            if o and not p: c+=1
            elif (not o) and p: b+=1
        p_mcnemar=mcnemar(b,c)
        pairs[base]={"mean_delta_f1":dmean,"p_t":p_t,"ci90_f1":ci90,"p_sign":p_sym,"p_mcnemar":p_mcnemar,"n":len(diffs)}
        pm = f"{p_mcnemar:.4f}" if isinstance(p_mcnemar,float) else "NaN"
        print(f"Ours vs {base:<15}{dmean:>8.4f}{p_t:>8.4f}{ci90[0]:>7.4f}~{ci90[1]:<6.4f}{p_sym:>8.4f}{pm:>20}")

    # 保存
    out={"bootstrap_f1_ci":cis,"paired_tests":pairs}
    (RESULTS_DIR/"stat_tests_v2.json").write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"\nSaved {RESULTS_DIR}/stat_tests_v2.json")

def normal_cdf(x):
    import math
    return 0.5*(1+math.erf(x/math.sqrt(2)))
def binom_tail(npos,nneg):
    import math
    n=npos+nneg
    if n==0: return 1.0
    from math import comb
    k=min(npos,nneg)
    # P(X<=k) 在 n 次对称二项
    s=sum(comb(n,i)*0.5**n for i in range(k+1))
    return min(1.0,2*s)
def mcnemar(b,c):
    import math
    from math import comb
    n=b+c
    if n==0: return 1.0
    # 精确双侧
    s=sum(comb(n,i)*0.5**n for i in range(0,min(b,c)+1))
    return min(1.0,2*s)

if __name__=="__main__": main()
#!/usr/bin/env python3
"""
gemma4 本地采集 (V2, P6 第三开源模型)
====================================
用本机 ollama 运行 gemma4, 每 schema N 样本, 输出 data/gemma4/ 隔离目录。
含 thinking 剥离 (ollama 流式如带思考标签则剥除)。
用法: python baselines/collect_gemma.py --samples 50
"""
import argparse, json, os, re, sys, time, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import SCHEMAS, TRUNCATION_POSITIONS

OUT = Path(__file__).parent.parent/"data"/"gemma4"/"llm_outputs"
OUT.mkdir(parents=True, exist_ok=True)
OLLAMA = "http://localhost:11434/api/chat"
MODEL = "gemma4"

def call_gemma(prompt):
    body = json.dumps({"model":MODEL,"messages":[{"role":"user","content":prompt}],"stream":True,"options":{"temperature":0.7}}).encode()
    req = urllib.request.Request(OLLAMA, data=body, headers={"Content-Type":"application/json"})
    full=""; timeline=[]; t0=time.time(); cum=0
    with urllib.request.urlopen(req, timeout=600) as resp:
        for line in resp:
            line=line.decode().strip()
            if not line: continue
            try: j=json.loads(line)
            except: continue
            delta = j.get("message",{}).get("content") or ""
            if delta:
                full+=delta; cum+=len(delta)
                timeline.append({"timestamp":round(time.time()-t0,6),"cumulative_len":cum,"delta_len":len(delta)})
                if j.get("done"): break
    # 剥离 thinking (如有)
    stripped=re.sub(r"<thinking>.*?</thinking>","",full,flags=re.S)
    return stripped, timeline

def truncate_at(text,pos): return text[:int(len(text)*pos)]

def save(sample_id, text, timeline, schema_id):
    (OUT/f"{sample_id}_complete.json").write_text(text,encoding="utf-8")
    (OUT/f"{sample_id}_timeline.json").write_text(json.dumps(timeline),encoding="utf-8")
    tf={}
    for pct in TRUNCATION_POSITIONS:
        p=OUT/f"{sample_id}_trunc_{int(pct*100):02d}.txt"; p.write_text(truncate_at(text,pct),encoding="utf-8")
        tf[str(int(pct*100))]=str(p)
    try:
        gt=json.loads(text); ak=None
        for k in ["ingredients","products","diagnoses","medications","labResults","revenue","expenses"]:
            if k in gt and isinstance(gt[k],list): ak=k; break
        return {"sample_id":sample_id,"schema":schema_id,"model":MODEL,"complete_path":str(OUT/f"{sample_id}_complete.json"),
                "timeline_path":str(OUT/f"{sample_id}_timeline.json"),"total_length":len(text),"array_key":ak,
                "array_length":len(gt.get(ak,[])) if ak else 0,"truncation_files":tf}
    except json.JSONDecodeError:
        return {"sample_id":sample_id,"schema":schema_id,"model":MODEL,"complete_path":str(OUT/f"{sample_id}_complete.json"),
                "timeline_path":str(OUT/f"{sample_id}_timeline.json"),"total_length":len(text),"array_key":None,"array_length":0,"truncation_files":tf}

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--samples",type=int,default=50); a=ap.parse_args()
    all_gt=[]
    for schema_id,sconf in SCHEMAS.items():
        print(f"\n=== {schema_id} — {a.samples} samples (gemma4 local) ===")
        for i in range(a.samples):
            t0=time.time()
            text,tl=call_gemma(sconf["prompt"])
            if not text.strip():
                print(f"  [{i+1}] SKIP empty"); continue
            sid=f"gemma4_{schema_id}_sample_{i:04d}"
            e=save(sid,text,tl,schema_id)
            all_gt.append(e)
            ok="✓" if e["array_key"] else "✗(no array)"
            print(f"  [{i+1}/{a.samples}] {sid} len={e['total_length']} arr={e['array_length']} {ok} {time.time()-t0:.0f}s")
    gt_path=Path(__file__).parent.parent/"data"/"gemma4"/"ground_truth.json"
    gt_path.parent.mkdir(parents=True,exist_ok=True)
    gt_path.write_text(json.dumps(all_gt,ensure_ascii=False,indent=2),encoding="utf-8")
    nvalid=sum(1 for e in all_gt if e["array_key"])
    print(f"\nSaved {len(all_gt)} gemma4 samples ({nvalid} with array) to data/gemma4/")

if __name__=="__main__": main()
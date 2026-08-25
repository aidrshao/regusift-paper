#!/usr/bin/env python3
"""
DeepSeek 隔离采集 (V2, P6)
=========================
每 schema 采样 N 个, 输出到 data/deepseek/ 隔离目录(不污染 GPT 主数据集)。
复用 config 的 schema prompt 与截断逻辑。
用法: DEEPSEEK_API_KEY=sk-xxx python baselines/collect_deepseek.py --samples 100
"""
import argparse, asyncio, json, os, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import SCHEMAS, TRUNCATION_POSITIONS

BASE = Path(__file__).parent.parent / "data" / "deepseek"
OUT = BASE / "llm_outputs"
OUT.mkdir(parents=True, exist_ok=True)
API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
BASE_URL = "https://api.deepseek.com"
MODEL = "deepseek-v4-flash"  # 固定版本 ID (deepseek-chat 为滚动别名, 不可复现)

def truncate_at_position(text, position):
    return text[:int(len(text)*position)]

def save_sample(sample_id, full_text, timeline, schema_id):
    complete = OUT / f"{sample_id}_complete.json"
    complete.write_text(full_text, encoding="utf-8")
    tl = OUT / f"{sample_id}_timeline.json"
    tl.write_text(json.dumps(timeline, indent=2), encoding="utf-8")
    trunc_files = {}
    for pct in TRUNCATION_POSITIONS:
        t = OUT / f"{sample_id}_trunc_{int(pct*100):02d}.txt"
        t.write_text(truncate_at_position(full_text, pct), encoding="utf-8")
        trunc_files[str(int(pct*100))] = str(t)
    try:
        gt = json.loads(full_text)
        array_key = None
        for k in ["ingredients","products","diagnoses","medications","labResults","revenue","expenses"]:
            if k in gt and isinstance(gt[k], list): array_key=k; break
        return {"sample_id":sample_id,"schema":schema_id,"model":"deepseek-chat","complete_path":str(complete),
                "timeline_path":str(tl),"total_length":len(full_text),"array_key":array_key,
                "array_length":len(gt.get(array_key,[])) if array_key else 0,"truncation_files":trunc_files}
    except json.JSONDecodeError:
        return {"sample_id":sample_id,"schema":schema_id,"model":"deepseek-chat","complete_path":str(complete),
                "timeline_path":str(tl),"total_length":len(full_text),"array_key":None,"array_length":0,"truncation_files":trunc_files}

async def call_one(sem, prompt):
    import httpx
    async with sem:
        url=f"{BASE_URL}/chat/completions"
        headers={"Authorization":f"Bearer {API_KEY}","Content-Type":"application/json"}
        body={"model":MODEL,"messages":[{"role":"user","content":prompt}],"stream":True,"temperature":0.7}
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                async with client.stream("POST",url,headers=headers,json=body) as resp:
                    resp.raise_for_status()
                    full=""; timeline=[]
                    t0=time.time(); cum=0
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data: "): continue
                        data=line[6:]
                        if data=="[DONE]": break
                        try:
                            chunks = json.loads(data)
                            delta = chunks["choices"][0]["delta"].get("content","") or ""
                            if delta:
                                full += delta; cum += len(delta)
                                timeline.append({"timestamp":round(time.time()-t0,6),"cumulative_len":cum,"delta_len":len(delta)})
                        except: continue
                    return full, timeline
        except Exception as e:
            print(f"  ERR {type(e).__name__}: {e}")
            return "",[]

async def main_async(args):
    if not API_KEY:
        print("ERROR: set DEEPSEEK_API_KEY"); sys.exit(1)
    sem=asyncio.Semaphore(args.concurrency)
    all_gt=[]
    for schema_id, schema in SCHEMAS.items():
        print(f"\n=== {schema_id} — {args.samples} samples ===")
        tasks=[call_one(sem, schema["prompt"]) for _ in range(args.samples)]
        results=[]
        results=await asyncio.gather(*tasks, return_exceptions=True)
        gt_entries=[]
        for i,res in enumerate(results):
            full,tl = res if isinstance(res,tuple) else ("",[])
            if not full:
                print(f"  [{i+1}/{args.samples}] SKIP (empty)"); continue
            sid=f"deepseek_{schema_id}_sample_{i:04d}"
            entry=save_sample(sid,full,tl,schema_id)
            gt_entries.append(entry)
            print(f"  saved {sid} len={entry['total_length']} arr={entry['array_length']}")
        all_gt.extend(gt_entries)
    gt_path=BASE/"ground_truth.json"
    gt_path.write_text(json.dumps(all_gt,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"\nSaved {len(all_gt)} DeepSeek samples to {BASE}/")

if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("--samples",type=int,default=100)
    ap.add_argument("--concurrency",type=int,default=5)
    a=ap.parse_args()
    asyncio.run(main_async(a))
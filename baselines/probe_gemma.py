#!/usr/bin/env python3
"""gemma4 小批量探测: 验证本地 open 模型能否产出贴合论文 schema, 以及 thinking 处理"""
import json, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import SCHEMAS

def call_gemma(prompt, timeout=240):
    body = json.dumps({"model":"gemma4","messages":[{"role":"user","content":prompt}],"stream":False,"options":{"temperature":0.7}}).encode()
    import urllib.request
    req = urllib.request.Request("http://localhost:11434/api/chat", data=body, headers={"Content-Type":"application/json"})
    t0=time.time()
    r = json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    content = r.get("message",{}).get("content","")
    return content, time.time()-t0

TARGET_KEYS={"supplement_facts":"ingredients","medical_record":"diagnoses","product_catalog":"products","financial_report":"revenue","recipe_ingredients":"ingredients"}

for schema,sconf in SCHEMAS.items():
    content,t=call_gemma(sconf["prompt"])
    has_thinking="<thinking>" in content
    # 去 thinking + 去 markdown fence
    import re
    clean=content
    clean=re.sub(r"<thinking>.*?</thinking>","",clean,flags=re.S)
    clean=re.sub(r"^```(?:json)?\s*","",clean); clean=re.sub(r"\s*```\s*$","",clean).strip()
    try:
        parsed=json.loads(clean)
        tk=TARGET_KEYS.get(schema)
        has_target = isinstance(parsed.get(tk),list) if tk else False
        top_keys=list(parsed.keys())[:6]
        print(f"{schema:<18} time={t:.1f}s thinking={has_thinking} parse_ok=True has[{tk}]={has_target} top_keys={top_keys}")
    except Exception as e:
        print(f"{schema:<18} time={t:.1f}s thinking={has_thinking} parse_FAIL={str(e)[:60]}")
    # 冷却
    time.sleep(1)
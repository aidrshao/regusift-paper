#!/usr/bin/env python3
"""
T8 TTPF 双对照实验 — 记录 + 汇总 + 回填 (可复现管道)
====================================================
职责:
  1. 找到 measure_ttpf.ts 生成的最新 raw/slim 结果文件
  2. 调用 reproducibility.log_experiment.record() 记录完整元数据:
     - env 快照 / 工具版本 / 参数 / 输入(代码+parser+env)哈希 / 输出(结果文件)哈希 / 时间戳
  3. 汇总每模式 均值/标准差/95%CI 并打印
  4. 生成论文表11 回填所需的 JSON 结构 (供后续写入 .tex)
用法:
  python baselines/run_ttft_experiment.py [--results-dir results/ttft]
"""
import argparse, glob, json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from reproducibility.log_experiment import record, file_sha256

ROOT = Path(__file__).parent.parent

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results-dir", default=str(ROOT/"results"/"ttft"))
    a = ap.parse_args()
    resdir = Path(a.results_dir)
    raw_files = sorted(resdir.glob("*_raw.json"))
    if not raw_files:
        print("ERROR: 未找到 *_raw.json (确认 measure_ttpf.ts 已跑完)")
        sys.exit(1)
    raw_path = raw_files[-1]  # 最新一次
    slim_path = Path(str(raw_path).replace("_raw.json", "_slim.json"))
    print(f"最新 raw: {raw_path}")

    raw = json.load(open(raw_path))
    model = raw["model"]; summary = raw["summary"]; iterations = raw["iterations"]

    # 汇总成论文可用结构
    table = {}
    labels = {
        "mode1a_buffered": "非流式（缓冲到结束解析）",
        "mode1b_stream_buffered": "流式（缓冲到结束才解析）",
        "mode2_partialjson": "流式+partial-json 逐块",
        "mode3_ours": "流式+本文三层恢复",
    }
    for mid, s in summary.items():
        if s.get("ttft") is None: continue
        t = s["ttft"]; tot = s["total"]
        table[mid] = {
            "label": labels.get(mid, mid),
            "ttft_mean_ms": t["mean"], "ttft_std_ms": t["std"],
            "ttft_ci95": [t["ci95_low"], t["ci95_high"]],
            "ttft_p50_ms": t["p50"], "ttft_p95_ms": t["p95"], "n": t["n"],
            "total_mean_ms": tot["mean"],
        }
    # 双对照结论
    concl = {}
    if "mode1a_buffered" in table and "mode3_ours" in table:
        m1a = table["mode1a_buffered"]["ttft_mean_ms"]; m3 = table["mode3_ours"]["ttft_mean_ms"]
        concl["ours_vs_nonstream_x"] = round(m1a / m3, 2) if m3 else None
    if "mode2_partialjson" in table and "mode3_ours" in table:
        m2 = table["mode2_partialjson"]["ttft_mean_ms"]; m3 = table["mode3_ours"]["ttft_mean_ms"]
        concl["ours_vs_partialjson_x"] = round(m2 / m3, 2) if m3 else None
        if m2 and m3:
            concl["ours_speedup_rel_partialjson"] = "faster" if m3 < m2 else "slower_or_equal"

    # 记录实验 (完整可复现元数据)
    rec = record(
        exp_name="T8_ttft_dual_contrast",
        params={"model": model, "iterations": iterations, "modes": list(labels.keys()),
                "prompt_schema": "supplement_facts"},
        inputs={
            "measure_ttpf.ts": file_sha256(str(ROOT/"baselines"/"measure_ttpf.ts")),
            "partial_json_parser_fixed.ts": file_sha256(str(ROOT/"code"/"partial-json-parser.fixed.ts")),
        },
        outputs={
            "raw_results": file_sha256(str(raw_path)),
            "slim_results": file_sha256(str(slim_path)) if slim_path.exists() else "MISSING",
        },
        metrics={"table": table, "conclusions": concl},
        notes=f"DeepSeek {model} 4模式×{iterations}次 TTPF 双对照实测; 原始逐块时间线+全文+sha256 完整保存; 冒烟已清理。",
    )

    # 打印
    print(f"\n=== T8 TTPF 双对照汇总 (model={model}) ===")
    for mid, t in table.items():
        print(f"{t['label']:<22} TTPF均值={t['ttft_mean_ms']}ms  SD={t['ttft_std_ms']}  95%CI={t['ttft_ci95']}  P50={t['ttft_p50_ms']}  P95={t['ttft_p95_ms']}  n={t['n']}")
    print("\n结论:", concl)

    # 写入可回填 JSON
    out = ROOT/"results"/"ttft_dual_contrast.json"
    out.write_text(json.dumps({"model": model, "iterations": iterations,
                               "recorded_at": rec["timestamp"], "exp_id": rec["exp_id"],
                               "table": table, "conclusions": concl,
                               "raw_file": raw_path.name, "raw_sha256": file_sha256(str(raw_path))},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"回填数据已写: {out}")

if __name__ == "__main__":
    main()
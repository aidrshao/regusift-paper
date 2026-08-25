#!/usr/bin/env python3
"""
TTPF 双对照实验 — 记录 + 汇总 (可复现管道)
=========================================
读取 results/ttft/ 中"四模式"原始实测 (含 mode1a/mode1b/mode2/mode3 且 summary 带 ttft 子对象的那次),
从逐迭代时间线重算 均值/标准差/95%CI(Student t)/P50/P95, 记录完整元数据, 写入 results/ttft_dual_contrast.json。

说明:
  - 论文表9 的权威数据源为 results/ttpf_full_v2.json (由 baselines/aggregate_ttpf_full.py 生成,
    汇总 ref+extra 两次会话); 本脚本产出的 ttft_dual_contrast.json 为早期四模式会话的补充对照。
  - 95%CI 采用 Student t (df=n-1, t_{19,0.975}=2.093), 与论文"基于 Student t 分布计算"的声明一致。

用法:
  python baselines/run_ttft_experiment.py [--results-dir results/ttft]
"""
import argparse, glob, json, math, statistics, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from reproducibility.log_experiment import record, file_sha256

ROOT = Path(__file__).parent.parent
TCRIT = {20: 2.093}  # df=19, 95% 双侧


def summarize(vals):
    n = len(vals)
    mean = statistics.mean(vals)
    sd = statistics.stdev(vals) if n > 1 else 0.0
    half = TCRIT[n] * sd / math.sqrt(n) if n > 1 else 0.0
    s = sorted(vals)
    return {
        "n": n,
        "mean": round(mean, 1),
        "std": round(sd, 1),
        "ci95_low": round(mean - half, 1),
        "ci95_high": round(mean + half, 1),
        "p50": round(s[9]),   # n=20: sorted[9]
        "p95": round(s[18]),  # n=20: sorted[18]
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results-dir", default=str(ROOT / "results" / "ttft"))
    a = ap.parse_args()
    resdir = Path(a.results_dir)

    # 选择含 ttft 子对象的四模式 raw (早期会话, 含 mode1a/1b/2/3)
    candidates = []
    for raw_path in sorted(resdir.glob("*_raw.json")):
        raw = json.load(open(raw_path, encoding="utf-8"))
        s = raw.get("summary", {})
        if all(k in s for k in ("mode1a_buffered", "mode1b_stream_buffered",
                                "mode2_partialjson", "mode3_ours")) and \
           any(isinstance(v, dict) and "ttft" in v for v in s.values()):
            candidates.append((raw_path, raw))
    if not candidates:
        print("ERROR: 未找到含 ttft 子对象的四模式 *_raw.json (确认 measure_ttpf_extra.ts 已跑完)")
        sys.exit(1)
    raw_path, raw = candidates[-1]  # 最新一次四模式会话
    model = raw.get("model", "unknown")
    iterations = raw.get("iterations", 20)
    print(f"使用 raw: {raw_path}")

    results = raw.get("results", {})
    labels = {
        "mode1a_buffered": "非流式（缓冲到结束解析）",
        "mode1b_stream_buffered": "流式（缓冲到结束才解析）",
        "mode2_partialjson": "流式+partial-json 逐块",
        "mode3_ours": "流式+本文三层恢复",
    }
    table = {}
    for mid, label in labels.items():
        if mid not in results:
            continue
        t = summarize([x["ttft_ms"] for x in results[mid]])
        total = summarize([x["total_ms"] for x in results[mid]])
        table[mid] = {
            "label": label,
            "ttft_mean_ms": t["mean"], "ttft_std_ms": t["std"],
            "ttft_ci95": [t["ci95_low"], t["ci95_high"]],
            "ttft_p50_ms": t["p50"], "ttft_p95_ms": t["p95"], "n": t["n"],
            "total_mean_ms": total["mean"],
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

    # 记录实验 (完整可复现元数据); record() 返回 exp_id 字符串
    exp_id = record(
        exp_name="T8_ttft_dual_contrast",
        params={"model": model, "iterations": iterations, "modes": list(labels.keys()),
                "prompt_schema": "supplement_facts"},
        inputs={
            "measure_ttpf_extra.ts": file_sha256(str(ROOT / "baselines" / "measure_ttpf_extra.ts")),
            "partial_json_parser.ts": file_sha256(str(ROOT / "src" / "partial-json-parser.ts")),
        },
        outputs={
            "raw_results": file_sha256(str(raw_path)),
        },
        metrics={"table": table, "conclusions": concl},
        notes=f"DeepSeek {model} 4模式×{iterations}次 TTPF 双对照实测 (早期独立会话); 95%CI 用 Student t (t=2.093); "
               f"论文表9 权威数据见 results/ttpf_full_v2.json (aggregate_ttpf_full.py 聚合 ref+extra 两次会话)。",
    )

    # 打印
    print(f"\n=== TTPF 双对照汇总 (model={model}, 早期独立会话) ===")
    for mid, t in table.items():
        print(f"{t['label']:<22} TTPF均值={t['ttft_mean_ms']}ms  SD={t['ttft_std_ms']}  "
              f"95%CI={t['ttft_ci95']}  P50={t['ttft_p50_ms']}  P95={t['ttft_p95_ms']}  n={t['n']}")
    print("\n结论:", concl)

    # 写入
    out = ROOT / "results" / "ttft_dual_contrast.json"
    out.write_text(json.dumps({"model": model, "iterations": iterations,
                               "recorded_at": time.strftime("%Y-%m-%d %H:%M:%S %z"),
                               "exp_id": exp_id,
                               "table": table, "conclusions": concl,
                               "raw_file": raw_path.name, "raw_sha256": file_sha256(str(raw_path)),
                               "ci_method": "Student t (df=19, t=2.093)"},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已写入: {out}")


if __name__ == "__main__":
    main()

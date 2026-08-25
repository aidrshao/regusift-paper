#!/usr/bin/env python3
"""
聚合 TTPF 归因双对照的完整结果 → results/ttpf_full_v2.json (论文表9 数据源)
============================================================================
表9 由两次独立实测会话聚合而成:
  - *_ref_*_raw.json   (deepseek_v4_flash_ref_2026-08-22T23-49-25): mode1a 非流式 / mode1b 流式(缓冲)
  - *_extra_*_raw.json (deepseek_v4_flash_extra_2026-08-22T23-41-30): mode2 partial-json / mode2b best-effort
                                                                    / mode2c llm-json-repair / mode3 本文三层恢复

本脚本从逐迭代原始时间线 (results/<mode>[*].ttft_ms) 重算所有统计量 (而非复制 raw 的 summary),
口径与 baselines/measure_ttpf_ref.ts / measure_ttpf_extra.ts 完全一致:
  - mean  = round(mean, 1)
  - p50   = sorted[9]   (n=20, nearest-rank floor(0.5n))
  - p95   = sorted[18]  (n=20, nearest-rank floor(0.95(n-1)))
  - 95%CI = mean ± t_{19,0.975}=2.093 * sd / sqrt(n)   (Student t, 与论文声明一致)
  - ratios: modeX.mean / mode1a.mean (round 2)
  - paired_vs_ours: 各模式与 mode3 的逐迭代配对检验 (paired t + Wilcoxon)
  - mode3_vs_mode1a_ratio = round(mode1a.mean / mode3.mean, 2)

另附: 早期独立会话 (2026-08-21T09-22) 的 mode1a/mode3 = 1.61× (paired t p≈0.005),
支撑论文"另次独立会话测得模式3 相对非流式 1.61×"的说法, 一并写入 legacy_session 字段。

用法:
  python3 baselines/aggregate_ttpf_full.py
  # -> results/ttpf_full_v2.json (覆盖, 内容应与 committed 逐位一致)
"""
import glob, json, math, statistics, sys
from pathlib import Path
import scipy.stats as st

ROOT = Path(__file__).parent.parent
RESULTS_DIR = ROOT / "results"
TTFT_DIR = RESULTS_DIR / "ttft"

TCRIT = 2.093  # df=19, 95% 双侧


def summarize(vals):
    """与 measure_ttpf_ref.ts / measure_ttpf_extra.ts 口径一致的汇总"""
    n = len(vals)
    mean = statistics.mean(vals)
    sd = statistics.stdev(vals) if n > 1 else 0.0
    half = TCRIT * sd / math.sqrt(n) if n > 1 else 0.0
    s = sorted(vals)
    return {
        "mean": round(mean, 1),
        "ci": [round(mean - half, 1), round(mean + half, 1)],
        "p50": round(s[9]),   # n=20: sorted[9]
        "p95": round(s[18]),  # n=20: sorted[18]
        "n": n,
    }


def paired_stats(x, y):
    """x、y 为逐迭代 ttft_ms; 返回 (mean_delta_ms, paired_t_p, wilcoxon_p)
    mean_delta_ms = mean(y - x)   (y 为基准/对照, 负数表示 y 更快)"""
    delta = [yi - xi for xi, yi in zip(x, y)]
    md = statistics.mean(delta)
    sd = statistics.stdev(delta)
    n = len(delta)
    t = md / (sd / math.sqrt(n))
    paired_t_p = float(st.t.sf(abs(t), n - 1) * 2)
    try:
        wilcoxon_p = float(st.wilcoxon(x, y).pvalue)
    except ValueError:
        wilcoxon_p = None  # 全零差值时无法计算
    return round(md, 1), paired_t_p, wilcoxon_p


def find_raw(kind: str):
    files = sorted(TTFT_DIR.glob(f"*_{kind}_*_raw.json"))
    if not files:
        files = sorted(TTFT_DIR.glob(f"*{kind}*_raw.json"))
    if not files:
        print(f"ERROR: 未找到 {kind} raw 文件 (results/ttft/)")
        sys.exit(1)
    return json.load(open(files[-1], encoding="utf-8"))


def main():
    ref = find_raw("ref")
    extra = find_raw("extra")

    # 1. 各模式逐迭代 ttft_ms
    per_iter = {
        "mode1a_buffered": [x["ttft_ms"] for x in ref["results"]["mode1a_buffered"]],
        "mode1b_stream_buffered": [x["ttft_ms"] for x in ref["results"]["mode1b_stream_buffered"]],
    }
    for m in ["mode2_partialjson", "mode2b_best_effort", "mode2c_llmjsonrepair", "mode3_ours"]:
        per_iter[m] = [x["ttft_ms"] for x in extra["results"][m]]

    order = ["mode1a_buffered", "mode1b_stream_buffered", "mode2_partialjson",
             "mode2b_best_effort", "mode2c_llmjsonrepair", "mode3_ours"]

    # 2. summary
    summary = {m: summarize(per_iter[m]) for m in order}

    # 3. ratios (相对 mode1a 均值)
    m1a = summary["mode1a_buffered"]["mean"]
    ratios = {m: round(summary[m]["mean"] / m1a, 2) for m in order}

    # 4. paired_vs_ours: mode2/2b/2c vs mode3 (逐迭代配对)
    paired = {}
    for m in ["mode2_partialjson", "mode2b_best_effort", "mode2c_llmjsonrepair"]:
        md, pt_p, wx_p = paired_stats(per_iter[m], per_iter["mode3_ours"])
        paired[m] = {"mean_delta_ms": md, "paired_t_p": pt_p, "wilcoxon_p": wx_p}

    # 5. mode3 vs mode1a 比值 (mode1a.mean / mode3.mean)
    m3 = summary["mode3_ours"]["mean"]
    mode3_vs_mode1a_ratio = round(m1a / m3, 2)

    # 6. 早期独立会话 (2026-08-21T09-22) 支撑"另次独立会话 1.61× (p≈0.005)"
    legacy = {}
    for f in sorted(TTFT_DIR.glob("*_raw.json")):
        d = json.load(open(f, encoding="utf-8"))
        s = d.get("summary", {})
        m1a_v = s.get("mode1a_buffered")
        m3_v = s.get("mode3_ours")
        if not m1a_v or not m3_v:
            continue
        m1a_mean = (m1a_v.get("ttft") or m1a_v).get("mean")
        m3_mean = (m3_v.get("ttft") or m3_v).get("mean")
        if m1a_mean and m3_mean and abs(m1a_mean / m3_mean - 1.61) < 0.01:
            r = d.get("results", {})
            try:
                x = [i["ttft_ms"] for i in r["mode1a_buffered"]]
                y = [i["ttft_ms"] for i in r["mode3_ours"]]
                md, pt_p, wx_p = paired_stats(x, y)
                legacy = {
                    "raw_file": Path(f).name,
                    "mode1a_mean_ms": m1a_mean,
                    "mode3_mean_ms": m3_mean,
                    "mode1a_over_mode3": round(m1a_mean / m3_mean, 2),
                    "paired_t_p": pt_p,
                    "wilcoxon_p": wx_p,
                }
            except Exception:
                legacy = {"raw_file": Path(f).name,
                          "mode1a_over_mode3": round(m1a_mean / m3_mean, 2)}
            break

    out = {
        "summary": summary,
        "ratios": ratios,
        "paired_vs_ours": paired,
        "mode3_vs_mode1a_ratio": mode3_vs_mode1a_ratio,
        "legacy_session": legacy,
    }

    dst = RESULTS_DIR / "ttpf_full_v2.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"已写入: {dst}")

    # 打印核对
    print("\n=== 表9 汇总 ===")
    for m in order:
        s = summary[m]
        print(f"{m:<24} mean={s['mean']:>8.1f}  P50={s['p50']:>6}  P95={s['p95']:>6}  95%CI={s['ci']}  ratio={ratios[m]}")
    print("paired_vs_ours:", json.dumps(paired, ensure_ascii=False))
    print("mode3_vs_mode1a_ratio:", mode3_vs_mode1a_ratio)
    print("legacy_session(1.61x):", json.dumps(legacy, ensure_ascii=False))


if __name__ == "__main__":
    main()

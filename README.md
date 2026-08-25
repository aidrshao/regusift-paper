# regusift-paper

> **Academic artifact for:** 面向大语言模型流式输出的增量式结构化数据解析方法
> (Incremental Structured Data Parsing Method for Large Language Model Streaming Output)
>
> **Author:** SHAO Jun (Artificial Intelligence Laboratory, Shenzhen Zhenshi Zhiyuan Technology Co., Ltd.)
> **Contact:** shaojun@zhenshizhiyuan.com
> **License:** MIT

This repository is a **physically isolated academic-independent repository** that contains the
algorithmic core, evaluation code, pre-collected datasets, and **all** experimental result files
directly related to the paper. It does **not** include any business modules, UI components,
database schemas, or proprietary code of the parent industrial system (ReguSift).

**Every file path referenced in the paper exists in this repository.** All experimental numbers in
the paper's tables are auditable from the `results/` JSON files, and regenerable from the
pre-collected datasets + scripts below.

---

## 📊 Dataset Overview

Pre-collected LLM streaming outputs are included for **offline reproduction (no API key needed)**.
For every sample there are 7 files: `*_complete.json` (final output), `*_timeline.json` (streaming
timeline), and `*_trunc_{10,25,50,75,90}.txt` (truncated variants at 5 positions).

| Model | Location | Complete | Timeline | Truncated | Total |
|---|---|---|---|---|---|
| GPT-5.4-mini (main) | `data/llm_outputs/` | 1000 | 1000 | 5000 | 7000 |
| DeepSeek (`deepseek-chat`) | `data/deepseek/llm_outputs/` | 500 | 500 | 2500 | 3500 |
| gemma4 (local, ollama) | `data/gemma4/llm_outputs/` | 250 | 250 | 1250 | 1750 |

- 5 schemas × 200 samples (GPT, main experiment) = 1000 complete samples; after excluding 7 invalid
  samples (35 truncation cases), **4965 valid truncation cases** (matches paper §4.2).
- 5 schemas × 100 samples (DeepSeek) and 5 schemas × 50 samples (gemma4) for the cross-model
  generalization study (paper §4.7).
- Ground truth: `data/ground_truth.json` (GPT), `data/deepseek/ground_truth.json`,
  `data/gemma4/ground_truth.json`.

---

## 🚀 Quick Start (Offline, Zero API)

```bash
git clone https://github.com/aidrshao/regusift-paper.git
cd regusift-paper
npm install          # installs TS deps (partial-json, jsonrepair, best-effort-json-parser, ...)
npm test             # 8 smoke tests: L1/L2/L3 recovery + ICover convergence (should all pass)

# Replicate the FULL 7-method recovery table (Table 3) from pre-collected GPT outputs:
npx tsx baselines/evaluate_baselines.ts < data/samples.json > results/evaluation.json
# (4-method pipeline + ablation: python3 baselines/run_evaluation.py -> results/*_res.json -> run_ablation.py)
```

---

## 📑 Paper Section → Repository Mapping

| Paper Section | Table | File(s) in This Repo | Description |
|---|---|---|---|
| §3.2, Alg.1/2 | — | [`src/partial-json-parser.ts`](src/partial-json-parser.ts) | Core: three-layer truncation recovery (`parsePartialJson`, `preprocessTruncated`, `countBrackets`, `buildClosingStrategies`) — **V2 fixed version** (ghost-key + false-array fixes) |
| §3.3 | — | [`src/icover-protocol.ts`](src/icover-protocol.ts) | ICover (Incremental Cover) protocol |
| §3.5 | — | [`src/stream-ticker.ts`](src/stream-ticker.ts) | Frontend row-by-row rendering (50 ms ticker) |
| §4.2 | Table 2 (schemas) | `data/ground_truth.json` + `config.py` | 5 JSON schemas & ground truth |
| §4.5 | Table 3 (recovery, 7 methods) | [`baselines/evaluate_baselines.ts`](baselines/evaluate_baselines.ts) + [`baselines/run_baseline_compare.py`](baselines/run_baseline_compare.py) + `results/{naive,partial_json,json_repair,json_completer,best_effort,tolerant_repair}.baseline.v2.json` + `results/ours_fixed.v2.json` + `results/baseline_compare_summary.v2.json` | Recovery rate / field F1 / value accuracy for B1–B6 + Ours (ours_fixed.v2.json = paper's "修复版", F1 0.6300; 表3 的"单次延迟/ms"列由 `baseline_compare_summary.v2.json` 的 latency_ms 均值支撑; **B4 JsonCompleter 为按文献[9]语义复现的参考实现**, 见 `evaluate_baselines.ts` 的 `method_json_completer`) |
| §4.5 | Table 3 (statistics) | [`baselines/run_stat_tests.py`](baselines/run_stat_tests.py) + `results/stat_tests_v2.json` | Bootstrap 95% CI, paired t-test, McNemar (p=1.0) |
| §4.6 | Table 4 (ablation) | [`baselines/run_ablation.py`](baselines/run_ablation.py) + `results/ablation_res.json`, `results/ablation_v2_semantics.json`, `results/semantic_baselines_summary.json` | Semantic-layer sync/update ablation (表4 以 ablation_v2_semantics + semantic_baselines 为准) |
| §4.6 | Table 5 (Layer 3 stress) | [`baselines/stress_test_layer3_v2.ts`](baselines/stress_test_layer3_v2.ts) + `results/stress_test_layer3_v2.json` | Layer 3 stress test (250 样本, 200/250 兜底) |
| §4.6 | Table 6 (temporal) | [`baselines/run_temporal_metrics.py`](baselines/run_temporal_metrics.py) + `baselines/temporal_metrics.ts` + `baselines/summarize_temporal.py` + `results/temporal_metrics_{gpt,deepseek,gemma4}.json` + `results/temporal_summary.json` | tc / stale metrics across GPT/DeepSeek/gemma4 (5 种语义) |
| §4.6 | Table 7 (ghost-key robustness) | [`baselines/nonmonotonic_robustness.ts`](baselines/nonmonotonic_robustness.ts) + `results/nonmonotonic_robustness.json` | Ghost-key injection: ICover / no-delete diff / delete-handling diff (993 样本; ICover 与含删除 diff 残留 0、收敛 100%, 无删除 diff 残留约 567%、收敛 0%) |
| §4.7 | Table 8 (cross-model) | `data/deepseek/`, `data/gemma4/` + [`baselines/run_deepseek_eval.py`](baselines/run_deepseek_eval.py), [`baselines/run_gemma4_eval.py`](baselines/run_gemma4_eval.py) + `results/deepseek_eval.json`, `results/gemma4_eval.json` | Cross-model generalization |
| §4.8 | Table 9 (TTPF prod.) | [`baselines/measure_ttpf.ts`](baselines/measure_ttpf.ts) + `results/ttpf_measurement.json` | Production TTPF before/after (100 runs each, 配对 t p=1.4e-18) |
| §4.8 | Table 10 (TTPF attribution) | [`baselines/measure_ttpf_kimi.ts`](baselines/measure_ttpf_kimi.ts) + `results/ttft/moonshot_v1_32k_attribution_*_raw.json` | 表10 数据源: Kimi moonshot-v1-32k 官方直连 4 模式各 40 次归因 (模式3 vs 模式1b 逐块解析 12.1×, 配对 t p=2.8e-23); 早期 GPT 中转/DeepSeek 归因会话仍存于 `results/ttft/` 供对照 |

All `results/*.json` files are the **exact artifacts that produced the paper's tables** — every number
in the paper is directly verifiable from them (e.g., Table 3's 95.57%/0.6300, Table 10's
模式3 1528 ms / 12.1×, Table 6's 0.113 s / 23.8% stale).

---

## 🔧 Reproducing Each Table

### Table 3 (Recovery / F1 / value accuracy, 7 methods)
```bash
# (a) Full offline evaluation on the 4965 valid cases — 7 methods, same V8 engine:
#     生成 results/*.baseline.v2.json 与 results/baseline_compare_summary.v2.json:
python3 baselines/run_baseline_compare.py
#     (或直接看标准输入管道: npx tsx baselines/evaluate_baselines.ts < data/samples.json > results/evaluation.json)

# (b) Statistical significance (bootstrap CI, paired t, McNemar):
python3 baselines/run_stat_tests.py
#    -> results/stat_tests_v2.json
```

### Tables 4 & 6 (Ablation & temporal)
```bash
python3 baselines/run_ablation.py            # -> results/ablation_res.json (组件消融, 表4 语义消融以 ablation_v2 为准)
python3 baselines/run_ablation_v2.py         # -> results/ablation_v2_semantics*.json (表4)
python3 baselines/run_semantic_baselines.py  # -> results/semantic_baselines*.json (表4)
python3 baselines/run_temporal_metrics.py    # -> results/temporal_metrics_{gpt,deepseek,gemma4}.json (表6)
python3 baselines/summarize_temporal.py      # -> results/temporal_summary.json (表6, 5 种语义)
```

### Table 5 (Layer 3 stress test)
```bash
npx tsx baselines/stress_test_layer3_v2.ts   # -> results/stress_test_layer3_v2.json (250 样本, 对应论文表5)
```

### Table 7 (Ghost-key robustness)
```bash
npx tsx baselines/nonmonotonic_robustness.ts --samples 200 --chunk 8
# -> results/nonmonotonic_robustness.json (993 有效样本, 对应论文表7)
```

### Table 8 (Cross-model, requires API access to re-collect; results already included)
```bash
python3 baselines/collect_deepseek.py        # DeepSeek samples (needs DEEPSEEK API key)
python3 baselines/collect_gemma.py           # gemma4 samples (needs local ollama + gemma4)
python3 baselines/run_deepseek_eval.py
python3 baselines/run_gemma4_eval.py
```

### Tables 9 & 10 (TTPF, requires API access; raw results already included)
```bash
npx tsx baselines/measure_ttpf.ts --iterations 20   # production before/after -> results/ttpf_measurement.json (表9)
npx tsx baselines/measure_ttpf_kimi.ts --iter=40     # Kimi official attribution -> results/ttft/moonshot_v1_32k_attribution_*_raw.json (表10)
npx tsx baselines/measure_ttpf_ref.ts               # mode1a/1b 参考模式 -> results/ttft/*_ref_*_raw.json
npx tsx baselines/measure_ttpf_extra.ts             # mode2/2b/2c/3 逐块模式 -> results/ttft/*_extra_*_raw.json
python3 baselines/aggregate_ttpf_full.py            # 聚合 ref+extra -> results/ttpf_full_v2.json (早期 GPT 归因权威数据源, 供对照)
python3 baselines/run_ttft_experiment.py            # 早期四模式会话 -> results/ttft_dual_contrast.json (补充对照)
```

---

## 🧠 Algorithm Overview

### Three-Layer Progressive Truncation Recovery (`parsePartialJson`)
```
Layer 1: Direct Parse
  └─ Try JSON.parse(buffer). If success, return.
Layer 2: Truncation Tail Preprocessing + Bracket Closing
  ├─ preprocessTruncated(text): 5-step tail repair
  │   1. Close unterminated strings (append ")
  │   2. Remove trailing comma
  │   3. Fix missing value after colon (append null)
  │   4. Drop incomplete trailing key (V2 fix: no ghost key)
  │   5. Fix truncated decimal point
  ├─ countBrackets(text): string-aware bracket counter (O(n))
  └─ buildClosingStrategies(text): enumerate 5 closing orders
Layer 3: Targeted Array Extraction (string-aware anchor, V2 fix)
  └─ locate "arrayKey": [... ] via top-level key scan (dynamic arrayKey)
```

### ICover Protocol
```
Delta mode (traditional):  emit [o_{k+1}, ..., o_n]  → consumer appends
ICover mode (proposed):    emit [o_1, ..., o_n]       → consumer overwrites
```
In streaming JSON the same object undergoes progressive field completion:
`{"name":"Cal"}` → `{"name":"Cal","amount":"45"}` → `{"name":"Cal","amount":"45","unit":"kcal"}`.
Delta mode locks the frontend to stale values; ICover overwrites on each emit, guaranteeing
convergence to the true value as the stream completes.

---

## 📁 Repository Structure
```
regusift-paper/
├── src/
│   ├── partial-json-parser.ts   # Core: three-layer recovery (V2 fixed, §3.2)
│   ├── icover-protocol.ts       # Core: ICover protocol (§3.3)
│   └── stream-ticker.ts         # Frontend rendering (§3.5)
├── baselines/                   # All evaluation / collection / stat-test scripts
├── figures/                     # 论文图 1/2 (fig1_architecture, fig3_f1_curve) — generate_figures.py 可重新生成
├── data/
│   ├── llm_outputs/             # GPT-5.4-mini: 7000 files (main experiment)
│   ├── deepseek/llm_outputs/    # DeepSeek: 3500 files (§4.7)
│   ├── gemma4/llm_outputs/      # gemma4: 1750 files (§4.7)
│   ├── ground_truth.json        # GPT ground truth (相对路径, 自包含)
│   ├── deepseek/ground_truth.json
│   └── gemma4/ground_truth.json
├── results/                     # Pre-computed logs for EVERY paper table (auditable)
│   └── ttft/                    # TTPF 归因实验原始逐块时间线 (*_raw.json)
├── reproducibility/             # Experiment logging helpers
├── tests/smoke.test.ts          # 8 smoke tests (L1/L2/L3 + ICover)
├── config.py
├── generate_figures.py          # 重新生成论文图表
├── package.json
└── tsconfig.json
```

---

## 🔬 Reproducibility Notes
1. **GPT-5.4-mini**: raw LLM outputs preserved in `data/llm_outputs/`; evaluation is purely local
   (`JSON.parse` + string ops on pre-collected buffers), so API transport does not affect results.
2. **Same V8 engine**: `evaluate_all.ts` / `evaluate_baselines.ts` import the production TypeScript
   via `tsx`; all 7 methods run in the same V8 engine, eliminating cross-language bias.
3. **Node.js native bridge**: scripts import `src/partial-json-parser.ts` directly — no re-implementation.
4. **Cross-model data**: DeepSeek and gemma4 samples are included under `data/deepseek/` and
   `data/gemma4/`; re-collection requires API/ollama access (see Table 8 section), but the paper's
   Table 8 numbers are already contained in `results/deepseek_eval.json` / `results/gemma4_eval.json`.
5. **统计口径**: 表3 的"单次延迟/ms"列来自 `results/baseline_compare_summary.v2.json` 的 `latency_ms`
   均值 (如 Ours 0.0489≈0.049); 恢复率/字段 F1/值精确率来自 `*.baseline.v2.json` 与
   `ours_fixed.v2.json` (其中 `ours_fixed.v2.json` 与 `ours_res.json` 均为 V2 修复版结果, 内容相同)。
6. **表6 时序等效是构造性保证**: 单生产者流式下, icover/deltaR/jsonPatch/crdt 均按"最新已解析数组"
   更新 store, 故其 tc/stale 逐样本一致 (差异 <1e-6); 论文表6 所列"诚实增量(重发/JSON Patch/CRDT)"
   的等效正是这一构造的实证结果, 真正有区分度的是 append-only (deltaF)。
7. **表5 "恢复成功"口径**: 指成功提取到目标数组的**非空前缀** (实测恢复长度 5–7 / 完整长度 10–15,
   约半长), 并非全长重建 (论文表5注已披露)。
8. **TTPF 命名**: 本仓库 `measure_ttpf*.ts` 与 `aggregate_ttpf_full.py` 实测/统计的均为 TTPF
   (Time To First **Parsable** Field, 首个 `ingredients[0].name` 可解析时刻), 与论文表9/10 一致;
   raw 数据内的 `ttft_ms` 字段名仅为历史命名, 含义同为 TTPF。
9. **figures**: 论文图 1/2 对应 `figures/fig1_architecture.*` 与 `figures/fig3_f1_curve.pdf`;
   运行 `python3 generate_figures.py` 可重新生成图 2 (fig3_f1_curve) 等全部图表。
10. **表9 脚本与 API 通道**: `baselines/measure_ttpf.ts` 即论文表 9 的 before/after 生产实测脚本
   (N=100, 输出 `results/ttpf_measurement.json`); 该文件 `base_url` 为第三方兼容中转通道
   `dmxapi.cn` (gpt-5.4-mini), 论文已如实标注。after 模式的 `final_ingredient_count` 由
   `parsePartialJson` 真实恢复管线 (stripMarkdownJsonFence + 三层恢复) 统计, 与生产行为一致;
   实测终态成功 93/100 (93\%), 与论文静态截断恢复率 95.57\% 同量级。
11. **定理1 穷举验证**: `baselines/verify_theorem1.py` 为论文定理 1 的 8 种栈形态穷举验证脚本
   (d≤3, 0 失败), 与论文 §3.1 证明一一对应。

---

## 📄 License
MIT License — see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments
This work was supported by Shenzhen Zhenshi Zhiyuan Technology Co., Ltd. The industrial deployment
was conducted in the ReguSift FDA dietary supplement label generation system.

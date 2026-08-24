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
| §4.5 | Table 3 (recovery, 7 methods) | [`baselines/evaluate_baselines.ts`](baselines/evaluate_baselines.ts) + [`baselines/run_evaluation.py`](baselines/run_evaluation.py) + `results/{naive,partial_json,json_repair,json_completer,best_effort,tolerant_repair}.baseline.v2.json` + `results/ours_fixed.v2.json` | Recovery rate / field F1 / value accuracy for B1–B6 + Ours (ours_fixed.v2.json = paper's "修复版", F1 0.6300) |
| §4.5 | Table 3 (statistics) | [`baselines/run_stat_tests.py`](baselines/run_stat_tests.py) + `results/stat_tests_v2.json` | Bootstrap 95% CI, paired t-test, McNemar (p=1.0) |
| §4.6 | Table 4 (ablation) | [`baselines/run_ablation.py`](baselines/run_ablation.py) + `results/ablation_res.json`, `results/ablation_v2_semantics.json` | Semantic-layer sync/update ablation |
| §4.6 | Table 5 (Layer 3 stress) | [`baselines/stress_test_layer3.ts`](baselines/stress_test_layer3.ts) + `results/stress_test_layer3.json`, `results/stress_test_layer3_v2.json` | Layer 3 stress test (200/250 兜底) |
| §4.6 | Table 6 (temporal) | [`baselines/run_temporal_metrics.py`](baselines/run_temporal_metrics.py) + `baselines/temporal_metrics.ts` + `baselines/summarize_temporal.py` + `results/temporal_summary.json` | tc / stale metrics across GPT/DeepSeek/gemma4 |
| §4.7 | Table 7 (cross-model) | `data/deepseek/`, `data/gemma4/` + [`baselines/run_deepseek_eval.py`](baselines/run_deepseek_eval.py), [`baselines/run_gemma4_eval.py`](baselines/run_gemma4_eval.py) + `results/deepseek_eval.json`, `results/gemma4_eval.json` | Cross-model generalization |
| §4.8 | Table 8 (TTPF prod.) | [`baselines/measure_ttpf.ts`](baselines/measure_ttpf.ts) + `results/ttpf_measurement.json` | Production TTPF before/after (20 runs) |
| §4.8 | Table 9 (TTPF attribution) | [`baselines/run_ttft_experiment.py`](baselines/run_ttft_experiment.py) + `results/ttpf_full_v2.json`, `results/ttft_dual_contrast.json`, `results/ttft_paired_tests.json` | 6-mode TTPF attribution + 95% CI + paired tests |

All `results/*.json` files are the **exact artifacts that produced the paper's tables** — every number
in the paper is directly verifiable from them (e.g., Table 3's 95.57%/0.6300, Table 9's
7260.1 ms / CI, Table 6's 0.113 s / 23.8% stale).

---

## 🔧 Reproducing Each Table

### Table 3 (Recovery / F1 / value accuracy, 7 methods)
```bash
# (a) Full offline evaluation on the 4965 valid cases — 7 methods, same V8 engine:
npx tsx baselines/evaluate_baselines.ts < data/samples.json > results/evaluation.json
#    (or the 4-method baseline script: npx tsx baselines/evaluate_all.ts < data/samples.json)

# (b) Statistical significance (bootstrap CI, paired t, McNemar):
python3 baselines/run_stat_tests.py
#    -> results/stat_tests_v2.json
```

### Tables 4 & 6 (Ablation & temporal)
```bash
python3 baselines/run_ablation.py            # -> results/ablation_res.json
python3 baselines/run_semantic_baselines.py  # -> results/semantic_baselines.json
python3 baselines/run_temporal_metrics.py    # -> results/temporal_metrics_{gpt,deepseek,gemma4}.json
python3 baselines/summarize_temporal.py      # -> results/temporal_summary.json
```

### Table 5 (Layer 3 stress test)
```bash
npx tsx baselines/stress_test_layer3.ts      # -> results/stress_test_layer3.json
```

### Table 7 (Cross-model, requires API access to re-collect; results already included)
```bash
python3 baselines/collect_deepseek.py        # DeepSeek samples (needs DEEPSEEK API key)
python3 baselines/collect_gemma.py           # gemma4 samples (needs local ollama + gemma4)
python3 baselines/run_deepseek_eval.py
python3 baselines/run_gemma4_eval.py
```

### Tables 8 & 9 (TTPF, requires API access; results already included)
```bash
npx tsx baselines/measure_ttpf.ts --iterations 20   # production before/after
npx tsx baselines/measure_ttft_extra.ts             # 6-mode attribution
python3 baselines/run_ttft_experiment.py            # -> results/ttpf_full_v2.json, ttft_dual_contrast.json
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
├── data/
│   ├── llm_outputs/             # GPT-5.4-mini: 7000 files (main experiment)
│   ├── deepseek/llm_outputs/    # DeepSeek: 3500 files (§4.7)
│   ├── gemma4/llm_outputs/      # gemma4: 1750 files (§4.7)
│   ├── ground_truth.json        # GPT ground truth
│   ├── deepseek/ground_truth.json
│   └── gemma4/ground_truth.json
├── results/                     # Pre-computed logs for EVERY paper table (auditable)
├── reproducibility/             # Experiment logging helpers
├── tests/smoke.test.ts          # 8 smoke tests
├── config.py
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
   `data/gemma4/`; re-collection requires API/ollama access (see Table 7 section), but the paper's
   Table 7 numbers are already contained in `results/deepseek_eval.json` / `results/gemma4_eval.json`.

---

## 📄 License
MIT License — see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments
This work was supported by Shenzhen Zhenshi Zhiyuan Technology Co., Ltd. The industrial deployment
was conducted in the ReguSift FDA dietary supplement label generation system.

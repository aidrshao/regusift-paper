# regusift-paper

> **Academic artifact for:** Incremental Structured Data Parsing Method for Large Language Model Streaming Output
>
> **Author:** SHAO Jun (Artificial Intelligence Laboratory, Shenzhen Zhenshi Zhiyuan Technology Co., Ltd.)
> **Contact:** shaojun@zhenshizhiyuan.com
> **License:** MIT

This repository is a **physically isolated academic-independent repository** that contains only the algorithmic core, evaluation code, and minimal runnable examples directly related to the experiments in the paper. It does **not** include any business modules, UI components, database schemas, or proprietary code of the parent industrial system (ReguSift).

---

## 📑 Paper Correspondence

| Paper Section | File in This Repo | Description |
|---|---|---|
| §3.2, Algorithm 1/2 | [`src/partial-json-parser.ts`](src/partial-json-parser.ts) | Three-layer progressive truncation recovery (`parsePartialJson`, `preprocessTruncated`, `countBrackets`, `buildClosingStrategies`) |
| §3.3 | [`src/icover-protocol.ts`](src/icover-protocol.ts) | ICover (Incremental Cover) protocol implementation |
| §3.5 | [`src/stream-ticker.ts`](src/stream-ticker.ts) | Frontend row-by-row rendering with 50 ms ticker |
| §5 (Table 5, Table 6) | [`baselines/evaluate_all.ts`](baselines/evaluate_all.ts) | 4-method comparison (B1 Naive / B2 partial-json / B3 json-repair / Ours) |
| §5.7 (Table 8) | [`baselines/measure_ttft.ts`](baselines/measure_ttft.ts) | End-to-end TTFT measurement (20 iterations, supplement_facts scenario) |
| §5.1 | [`baselines/collect_llm_outputs.py`](baselines/collect_llm_outputs.py) | LLM output collection script (Python) |

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 20.0.0 (tested on Node.js v26.0.0)
- **Python** ≥ 3.9 (only for `collect_llm_outputs.py`)
- **OpenAI API key** (or compatible LLM API key) — only required for `measure_ttft.ts` and `collect_llm_outputs.py`

### Installation

```bash
git clone https://github.com/aidrshao/regusift-paper.git
cd regusift-paper
npm install
```

### Run Evaluation (§5 Experiment Reproduction)

The evaluation script runs all 4 methods (B1/B2/B3/Ours) on pre-collected LLM outputs and outputs recovery rate, field F1, and value accuracy.

```bash
# Input: JSON array of samples (sample_id, buffer_path, array_key)
# Output: JSON array of results (sample_id, method, recovered, parsed, latency_ms)
npx tsx baselines/evaluate_all.ts < data/samples.json > results/evaluation.json
```

To reproduce the paper's 5,000 truncation test cases (5 schemas × 1,000 samples × 5 truncation positions), first collect LLM outputs:

```bash
# Step 1: Collect 1,000 complete LLM outputs (5 schemas × 200 samples)
python3 baselines/collect_llm_outputs.py --output data/llm_outputs/

# Step 2: Run evaluation
npx tsx baselines/evaluate_all.ts < data/samples.json > results/evaluation.json
```

### Run TTFT Measurement (§5.7 Industrial Case)

```bash
# Set API credentials
export OPENAI_API_KEY=sk-xxx
export OPENAI_BASE_URL=https://api.openai.com/v1  # or your LLM endpoint

# Run 20 iterations (default), supplement_facts scenario
npx tsx baselines/measure_ttft.ts

# Custom iteration count
npx tsx baselines/measure_ttft.ts --iterations 10
```

Output: P50/P95/mean TTFT for both `stream:false` (before) and `stream:true + ICover` (after) modes.

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
  │   4. Truncate incomplete key name
  │   5. Fix truncated decimal point
  ├─ countBrackets(text): string-aware bracket counter (O(n))
  └─ buildClosingStrategies(text): enumerate 5 closing orders

Layer 3: Targeted Array Extraction
  └─ Regex match: "arrayKey":\s*\[...\]  (dynamic arrayKey parameter)
```

### ICover Protocol

```
Delta mode (traditional):  emit [o_{k+1}, ..., o_n]  → consumer appends
ICover mode (proposed):    emit [o_1, ..., o_n]       → consumer overwrites
```

**Key insight:** In streaming JSON, the same object undergoes progressive field completion:
`{"name":"Cal"}` → `{"name":"Cal","amount":"45"}` → `{"name":"Cal","amount":"45","unit":"kcal"}`

Delta mode locks the frontend to stale values (`"Cal"` never updates to `"Calcium"`). ICover mode overwrites on each emit, guaranteeing convergence to the true value as the stream completes.

---

## 📁 Repository Structure

```
regusift-paper/
├── src/
│   ├── partial-json-parser.ts   # Core: three-layer recovery (§3.2)
│   ├── icover-protocol.ts       # Core: ICover protocol (§3.3)
│   └── stream-ticker.ts         # Frontend rendering (§3.5)
├── baselines/
│   ├── evaluate_all.ts          # 4-method comparison (§5)
│   ├── run_evaluation.py        # Evaluation wrapper (metrics computation)
│   ├── run_ablation.py          # Ablation study post-processing
│   ├── stress_test_layer3.ts    # Layer 3 stress test
│   ├── measure_ttft.ts          # TTFT measurement (§5.7)
│   └── collect_llm_outputs.py   # Data collection (§5.1)
├── data/
│   └── llm_outputs/             # Pre-collected LLM outputs (gitignored)
├── results/                     # Evaluation results (gitignored)
├── package.json
├── tsconfig.json
├── .gitignore
├── LICENSE
└── README.md
```

---

## 📝 Citation

If you use this code in your research, please cite:

```bibtex
@article{shao2026incremental,
  title   = {面向大语言模型流式输出的增量式结构化数据解析方法},
  author  = {邵俊},
  journal = {计算机工程与应用},
  year    = {2026},
  note    = {In press}
}
```

---

## 🔬 Reproducibility Notes

1. **GPT-5.4-mini model:** The paper uses GPT-5.4-mini via OpenAI's official API. Raw LLM outputs (JSON logs) are preserved in `data/llm_outputs/` for reproducibility. To re-run with a different model, set `MODEL` in `baselines/measure_ttft.ts` and `baselines/collect_llm_outputs.py`.

2. **Pure API transport:** All parsing experiments are based on pre-collected LLM output files and involve only local `JSON.parse` and string operations. The API transport layer does not affect parsing experiment results.

3. **Node.js native bridge:** The evaluation script imports the production TypeScript code directly via `tsx`, ensuring evaluation results match production system behavior. All 4 methods run in the same V8 engine, eliminating cross-language comparison bias.

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

This work was supported by Shenzhen Zhenshi Zhiyuan Technology Co., Ltd. The industrial deployment was conducted in the ReguSift FDA dietary supplement label generation system.

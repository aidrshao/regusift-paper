#!/usr/bin/env python3
"""
论文图表生成
=============
读取 results/ 目录下的实验结果, 生成论文第 6 章需要的图表。

图表:
  - Figure 2: 截断位置 × 恢复率 二维热力图
  - Figure 3: 流式 token 累积 vs 前端行数增长 时间线
  - Figure 4: 各方法在不同截断位置的 F1 曲线
  - Figure 5: 消融实验柱状图

用法:
  python generate_figures.py                    # 生成所有图表
  python generate_figures.py --figure heatmap   # 仅生成热力图
  python generate_figures.py --figure timeline  # 仅生成时间线
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from config import SCHEMAS
ROOT = Path(__file__).parent
RESULTS_DIR = ROOT / "results"

# 图表输出目录 (paper_v2/figures)
FIGURES_DIR = ROOT / "figures"
FIGURES_DIR.mkdir(parents=True, exist_ok=True)

# ── 期刊字体规范设置 ──
# 期刊要求: 英文为 Times New Roman, 坐标图标目格式为 "物理量/单位"
# 中文核心期刊要求: 图内文字使用中文 (《计算机工程与应用》排版规范)
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

# 设置中英混排字体: 优先 PingFang SC / Songti SC (中文), 回落 Times New Roman (英文)
plt.rcParams['font.family'] = 'serif'
plt.rcParams['font.serif'] = ['Songti SC', 'SimSun', 'Times New Roman', 'DejaVu Serif']
plt.rcParams['font.sans-serif'] = ['PingFang SC', 'Heiti SC', 'Arial Unicode MS']
plt.rcParams['mathtext.fontset'] = 'stix'  # 数学公式用 STIX 字体(接近 TNR)
plt.rcParams['axes.unicode_minus'] = False  # 负号正常显示
plt.rcParams['axes.titlesize'] = 12
plt.rcParams['axes.labelsize'] = 11
plt.rcParams['xtick.labelsize'] = 10
plt.rcParams['ytick.labelsize'] = 10
plt.rcParams['legend.fontsize'] = 10
plt.rcParams['figure.titlesize'] = 13


def _save_figure_both(fig, name_without_ext: str):
    """同时保存 PNG (600dpi 预览) 和 PDF (矢量, 期刊要求)"""
    png_path = FIGURES_DIR / f"{name_without_ext}.png"
    pdf_path = FIGURES_DIR / f"{name_without_ext}.pdf"
    fig.savefig(png_path, dpi=600, bbox_inches='tight')
    fig.savefig(pdf_path, bbox_inches='tight')  # 矢量 PDF, 期刊要求
    print(f"  Saved: {png_path}")
    print(f"  Saved: {pdf_path} (vector)")


def load_results() -> dict:
    """
    加载所有实验结果。
    优先读取含 truncation_pct 的评估输出 (*.baseline.v2.json)。
    方法 key: naive / partial_json / json_repair / json_completer / best_effort / tolerant_repair / ours
    """
    results = {}
    for path in sorted(RESULTS_DIR.glob("*.baseline.v2.json")):
        key = path.stem.replace(".baseline.v2", "")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if data and isinstance(data, list) and "truncation_pct" in data[0]:
            results[key] = data
    # 兼容 ours_fixed -> ours
    if "ours" not in results and "ours_fixed" in results:
        results["ours"] = results["ours_fixed"]
    return results


def gen_heatmap(results: dict):
    """
    Figure 2: 截断位置 × 恢复率 二维热力图 (2×2 矩阵, 单栏)
    X 轴: 截断位置 (10%, 25%, 50%, 75%, 90%)
    Y 轴: Schema (5 种)
    颜色: 恢复率 (0% - 100%)
    子图: 4 种方法 (B1, B2, B3, Ours)
    2026-08 改造: 由 1×4 横排改为 2×2 矩阵, 适配单栏排版 (tex 中 width=\columnwidth)
    """
    import matplotlib
    matplotlib.use('Agg')  # 无 GUI 后端
    import matplotlib.pyplot as plt
    import numpy as np

    methods = ["naive", "partial_json", "json_repair", "ours"]
    method_labels = {
        "naive": "B1 朴素丢弃",
        "partial_json": "B2 partial-json",
        "json_repair": "B3 jsonrepair",
        "ours": "本文方法",
    }
    truncation_pcts = [10, 25, 50, 75, 90]
    schema_ids = list(SCHEMAS.keys())

    # 2×2 矩阵: figsize 与最终单栏宽度(约 8.15cm ≈ 3.2in) 接近, 避免过度缩放导致字太小
    fig, axes = plt.subplots(2, 2, figsize=(3.2, 4.1))
    axes = axes.flatten()
    fig.suptitle("各方法在不同截断位置与 Schema 上的恢复率", fontsize=9.5, y=0.99)

    for idx, method in enumerate(methods):
        res = results.get(method, [])
        if not res:
            axes[idx].text(0.5, 0.5, "No Data", ha='center', va='center', transform=axes[idx].transAxes)
            axes[idx].set_title(method_labels[method], fontsize=8.5)
            continue

        # 构建热力图矩阵: rows=schemas, cols=truncation_pcts
        matrix = np.zeros((len(schema_ids), len(truncation_pcts)))
        for i, schema_id in enumerate(schema_ids):
            for j, pct in enumerate(truncation_pcts):
                schema_pct_res = [r for r in res if r.get("schema") == schema_id and r.get("truncation_pct") == pct]
                if schema_pct_res:
                    matrix[i, j] = sum(1 for r in schema_pct_res if r.get("recovered")) / len(schema_pct_res)
                else:
                    matrix[i, j] = 0

        im = axes[idx].imshow(matrix, cmap='RdYlGn', vmin=0, vmax=1, aspect='auto')
        axes[idx].set_title(method_labels[method], fontsize=8.5)
        axes[idx].set_xticks(range(len(truncation_pcts)))
        axes[idx].set_yticks(range(len(schema_ids)))
        # 左列子图 (idx 0,2) 显示 Y 轴 Schema 名称, 右列隐藏避免压线
        if idx in (0, 2):
            axes[idx].set_yticklabels([s.replace("_", "\n") for s in schema_ids], fontsize=5.5)
        else:
            axes[idx].set_yticklabels([])
        # 仅底行子图 (idx 2,3) 显示 X 轴截断位置, 顶行隐藏
        if idx in (2, 3):
            axes[idx].set_xticklabels([f"{p}%" for p in truncation_pcts], fontsize=6)
            axes[idx].set_xlabel("截断位置/%", fontsize=6.5)
        else:
            axes[idx].set_xticklabels([])
            axes[idx].set_xlabel("")

        # 仅标注非满恢复(<100%)的关键失败格, 避免 100% 标签在窄格中粘连挤压
        for i in range(len(schema_ids)):
            for j in range(len(truncation_pcts)):
                value = matrix[i, j]
                if value >= 0.995:
                    continue
                color = "white" if value < 0.5 or value > 0.8 else "black"
                label = f"{value:.0%}" if abs(round(value * 100) - value * 100) < 1e-9 else f"{value:.1%}"
                axes[idx].text(j, i, label, ha="center", va="center",
                               color=color, fontsize=6.5, fontweight='bold')

    # 子图间距: 避免顶部子图 X 轴与标题、左右标签压线
    plt.subplots_adjust(wspace=0.35, hspace=0.55)

    # 共享颜色条 (底部横置, 释放右侧空间)
    cbar = fig.colorbar(im, ax=axes, label="恢复率", orientation='horizontal', shrink=0.8, aspect=40, pad=0.15)
    cbar.ax.tick_params(labelsize=5.5)
    cbar.set_label("恢复率", fontsize=6.5)

    # 坐标图标目规范化: X 轴 "截断位置/%"; 刻度线置于坐标轴内侧
    for ax in axes:
        ax.tick_params(direction='in', labelsize=6)

    _save_figure_both(fig, "fig2_heatmap_recovery")
    plt.close()


def gen_f1_curve(results: dict):
    """
    Figure 3: 各方法字段 F1 随截断位置变化的曲线。
    修复:
      - 完整覆盖表5 的 7 方法 (含 B4 JsonCompleter / B5 best-effort / B6 tolerant)
      - 去除画面中央黄色自辩护注释框与指向空白的箭头
      - 用不同 marker / 线型 / 轻微抖动区分重叠曲线
      - 本文方法用粗实线 + 白色菱形, 不遮挡基线
    """
    methods = ["naive", "json_completer", "partial_json", "json_repair", "best_effort", "tolerant_repair", "ours"]
    method_labels = {
        "naive": "B1 朴素丢弃", "json_completer": "B4 JsonCompleter", "partial_json": "B2 partial-json",
        "json_repair": "B3 json-repair", "best_effort": "B5 best-effort", "tolerant_repair": "B6 tolerant",
        "ours": "本文方法",
    }
    method_colors = {
        "naive": "#7f8c8d", "json_completer": "#8e44ad", "partial_json": "#e67e22",
        "json_repair": "#2980b9", "best_effort": "#16a085", "tolerant_repair": "#c0392b",
        "ours": "#2ecc71",
    }
    method_marker = {
        "naive": "s", "json_completer": "^", "partial_json": "o",
        "json_repair": "D", "best_effort": "v", "tolerant_repair": "*", "ours": "X",
    }
    truncation_pcts = [10, 25, 50, 75, 90]

    def group_f1(res):
        out = {}
        for pct in truncation_pcts:
            pr = [r for r in res if r.get("truncation_pct") == pct]
            out[pct] = sum(r.get("field_f1", 0) for r in pr) / len(pr) if pr else 0
        return out

    fig, ax = plt.subplots(figsize=(5.2, 4.6))
    for method in methods:
        res = results.get(method)
        if not res:
            continue
        f1 = group_f1(res)
        vals = [f1[p] for p in truncation_pcts]
        is_ours = (method == "ours")
        # 对重叠的宽松库施加轻微 x 抖动, 保证 marker 清晰分离
        xs = list(truncation_pcts)
        if method in ("partial_json", "json_repair"):
            xs = [p + 0.8 for p in truncation_pcts]
        elif method in ("best_effort", "tolerant_repair"):
            xs = [p - 0.8 for p in truncation_pcts]
        lbl = method_labels[method] if is_ours else f"{method_labels[method]}"
        ax.plot(xs, vals,
                marker=method_marker[method],
                linestyle='-' if is_ours else '--',
                label=lbl,
                color=method_colors[method],
                linewidth=3.2 if is_ours else 1.6,
                markersize=13 if is_ours else 7,
                markerfacecolor='white' if is_ours else method_colors[method],
                markeredgewidth=2.2 if is_ours else 1.2,
                alpha=1.0 if is_ours else 0.9,
                zorder=10 if is_ours else 2)

    ax.set_xlabel("截断位置/%", fontsize=13)
    ax.set_ylabel("字段 F1", fontsize=13)
    ax.set_title("各方法字段 F1 随截断位置的变化", fontsize=14, fontweight='bold')
    ax.set_xticks(truncation_pcts)
    ax.set_xticklabels([f"{p}%" for p in truncation_pcts], fontsize=12)
    ax.tick_params(axis='y', labelsize=12)
    ax.set_ylim(-0.05, 1.1)
    ax.set_xlim(5, 95)
    ax.legend(fontsize=11, loc='upper left', framealpha=0.95, edgecolor='gray', ncol=2)
    ax.grid(True, alpha=0.3, linestyle=':')
    ax.tick_params(direction='in')

    _save_figure_both(fig, "fig3_f1_curve")
    plt.close()


def gen_ablation_bar(results: dict):
    """
    Figure 5: 消融实验柱状图
    """
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import numpy as np

    ablation_data = results.get("ablation", {})
    summaries = ablation_data.get("summaries", [])

    if not summaries:
        print("  [SKIP] No ablation data")
        return

    config_labels = {
        "full": "完整系统",
        "no_layer3": "去除第三层",
        "no_icover": "去除 ICover (Delta)",
    }

    configs = [s["config"] for s in summaries if s["config"] in config_labels]
    recovery_rates = [s["recovery_rate"] for s in summaries if s["config"] in config_labels]
    f1_scores = [s["field_f1"] for s in summaries if s["config"] in config_labels]
    value_accs = [s["value_accuracy"] for s in summaries if s["config"] in config_labels]
    labels = [config_labels.get(c, c) for c in configs]

    x = np.arange(len(labels))
    width = 0.25

    fig, ax = plt.subplots(figsize=(10, 6))
    bars1 = ax.bar(x - width, recovery_rates, width, label='恢复率', color='#2ecc71')
    bars2 = ax.bar(x, f1_scores, width, label='字段 F1', color='#3498db')
    bars3 = ax.bar(x + width, value_accs, width, label='值精确率', color='#f39c12')

    ax.set_ylabel('得分', fontsize=11)
    ax.set_title('消融实验结果', fontsize=12)
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=10)
    ax.legend(fontsize=10)
    ax.set_ylim(0, 1.1)
    ax.grid(True, alpha=0.3, axis='y')
    # 期刊要求: 刻度线置于坐标轴内侧
    ax.tick_params(direction='in')

    # 在柱子上显示数值
    for bars in [bars1, bars2, bars3]:
        for bar in bars:
            height = bar.get_height()
            ax.annotate(f'{height:.3f}',
                        xy=(bar.get_x() + bar.get_width() / 2, height),
                        xytext=(0, 3), textcoords="offset points",
                        ha='center', va='bottom', fontsize=9)

    _save_figure_both(fig, "fig5_ablation")
    plt.close()


def gen_timeline(results: dict):
    """
    Figure 3: 流式 token 累积 vs 前端行数增长 时间线
    需要读取 timeline 数据
    """
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    # 读取第一个 sample 的 timeline
    gt_path = Path(__file__).parent / "data" / "ground_truth.json"
    if not gt_path.exists():
        print("  [SKIP] No ground_truth.json")
        return

    gt_index = json.loads(gt_path.read_text(encoding="utf-8"))
    if not gt_index:
        print("  [SKIP] Empty ground truth")
        return

    # 找第一个有 timeline 的 sample
    timeline = None
    for sample in gt_index:
        tl_path = Path(sample.get("timeline_path", ""))
        if tl_path.exists():
            timeline = json.loads(tl_path.read_text(encoding="utf-8"))
            sample_info = sample
            break

    if not timeline:
        print("  [SKIP] No timeline data")
        return

    # 提取时间和累积长度
    times = [t["timestamp"] for t in timeline]
    cum_lens = [t["cumulative_len"] for t in timeline]

    # 模拟前端逐行入场 (每 50ms 推一个 ingredient)
    # 假设每个 ingredient 约 200 字符, 前端 50ms/ticker
    ingredient_count = sample_info.get("array_length", 12)
    total_chars = sample_info.get("total_length", 5000)
    chars_per_ingredient = total_chars / max(ingredient_count, 1)

    # 模拟流式解析成功的时间点 (假设每个 ingredient 在累积了足够字符后才能被解析)
    frontend_times = []
    frontend_counts = []
    accumulated = 0
    for i, (t, cl) in enumerate(zip(times, cum_lens)):
        while accumulated < cl and len(frontend_counts) < ingredient_count:
            accumulated += chars_per_ingredient
            # 前端 ticker 延迟: 每个 ingredient 50ms
            frontend_times.append(t + 0.05 * len(frontend_counts))
            frontend_counts.append(len(frontend_counts))

    fig, ax1 = plt.subplots(figsize=(12, 6))

    color1 = '#3498db'
    # 坐标图标目格式: "物理量/单位" (期刊要求, 中文)
    ax1.set_xlabel('时间/s', fontsize=11)
    ax1.set_ylabel('累积 buffer 长度/字符', color=color1, fontsize=11)
    ax1.plot(times, cum_lens, color=color1, linewidth=2, label='LLM token 流')
    ax1.tick_params(axis='y', labelcolor=color1, direction='in')
    ax1.tick_params(axis='x', direction='in')
    ax1.fill_between(times, cum_lens, alpha=0.1, color=color1)

    ax2 = ax1.twinx()
    color2 = '#2ecc71'
    ax2.set_ylabel('前端已显示成分数/行', color=color2, fontsize=11)
    if frontend_times:
        ax2.step(frontend_times, frontend_counts, color=color2, linewidth=2, where='post', label='前端显示')
    ax2.tick_params(axis='y', labelcolor=color2, direction='in')
    ax2.set_ylim(0, max(frontend_counts) + 2 if frontend_counts else 15)

    # 标注 TTFT
    if frontend_times:
        ax2.axvline(x=frontend_times[0], color='#e74c3c', linestyle='--', alpha=0.7, label=f'TTFT = {frontend_times[0]:.1f}s')

    fig.suptitle('流式 token 累积与前端显示行数增长', fontsize=12)
    fig.legend(loc='upper right', bbox_to_anchor=(0.9, 0.85), fontsize=10)

    _save_figure_both(fig, "fig3_timeline")
    plt.close()


def main():
    parser = argparse.ArgumentParser(description="Generate paper figures")
    parser.add_argument("--figure", choices=["all", "heatmap", "timeline", "f1_curve", "ablation"],
                        default="all", help="Which figure to generate")
    args = parser.parse_args()

    results = load_results()

    print(f"{'='*60}")
    print("Generating figures...")
    print(f"{'='*60}")

    if args.figure in ("all", "heatmap"):
        print("\n[Figure 2] Heatmap: Recovery Rate × Truncation Position")
        gen_heatmap(results)

    if args.figure in ("all", "timeline"):
        print("\n[Figure 3] Timeline: Token Stream vs Frontend Display")
        gen_timeline(results)

    if args.figure in ("all", "f1_curve"):
        print("\n[Figure 4] F1 Curve by Truncation Position")
        gen_f1_curve(results)

    if args.figure in ("all", "ablation"):
        print("\n[Figure 5] Ablation Bar Chart")
        gen_ablation_bar(results)

    print(f"\n{'='*60}")
    print(f"Figures saved to: {FIGURES_DIR}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()

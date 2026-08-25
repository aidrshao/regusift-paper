"""
论文实验共享配置 (自包含版本)
============================
本仓库为物理隔离的学术独立仓库, 所有评估脚本在同一根目录下自包含运行。
ROOT 为仓库根目录, REGUSIFT_ROOT 即 ROOT 本身 (评估脚本在此运行 npx tsx)。
"""

import os
from pathlib import Path

# ── 路径 (仓库完全自包含) ──
ROOT = Path(__file__).parent
REGUSIFT_ROOT = ROOT  # 仓库根目录即 ReguSift 根目录 (自包含)
DATA_DIR = ROOT / "data"
LLM_OUTPUTS_DIR = DATA_DIR / "llm_outputs"
TEST_SCHEMAS_DIR = DATA_DIR / "test_schemas"
RESULTS_DIR = ROOT / "results"
LOG_DIR = RESULTS_DIR / "log"
PAPER_DIR = ROOT / "paper"

for d in [DATA_DIR, LLM_OUTPUTS_DIR, TEST_SCHEMAS_DIR, RESULTS_DIR, LOG_DIR, PAPER_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# ── JSON Schema 集合 (5 种, 对应论文表 2) ──
SCHEMAS = {
    "supplement_facts": {
        "description": "FDA Supplement Facts 标签", "nesting_depth": 3, "array_length_range": (5, 30),
        "prompt": """You are a nutrition label generator. Generate a realistic FDA Supplement Facts label as JSON.
Include 8-15 supplement ingredients with name, amount, unit, and %DV.
Also include meta fields: productName, servingSize, servingsPerContainer.
Return ONLY valid JSON, no markdown fences.

Schema:
{
  "productName": string,
  "servingSize": string,
  "servingsPerContainer": number,
  "ingredients": [
    {"name": string, "amount": string, "unit": string, "dailyValue": string}
  ]
}""",
    },
    "medical_record": {
        "description": "电子病历摘要", "nesting_depth": 4, "array_length_range": (3, 10),
        "prompt": """Generate a realistic electronic medical record summary as JSON.
Include patient info, diagnoses array, medications array, and lab results array.
Return ONLY valid JSON, no markdown fences.

Schema:
{
  "patient": {"name": string, "age": number, "gender": string},
  "diagnoses": [{"code": string, "description": string}],
  "medications": [{"name": string, "dosage": string, "frequency": string}],
  "labResults": [{"test": string, "value": string, "unit": string, "referenceRange": string}]
}""",
    },
    "product_catalog": {
        "description": "电商产品目录", "nesting_depth": 3, "array_length_range": (10, 50),
        "prompt": """Generate a realistic e-commerce product catalog as JSON.
Include 15-30 products with name, price, category, and stock.
Return ONLY valid JSON, no markdown fences.

Schema:
{
  "catalogId": string,
  "lastUpdated": string,
  "products": [
    {"id": string, "name": string, "price": number, "category": string, "stock": number}
  ]
}""",
    },
    "financial_report": {
        "description": "季度财务报表", "nesting_depth": 4, "array_length_range": (5, 20),
        "prompt": """Generate a realistic quarterly financial report as JSON.
Include company info, quarter, revenue breakdown, and expenses breakdown.
Return ONLY valid JSON, no markdown fences.

Schema:
{
  "company": string,
  "quarter": string,
  "revenue": [{"category": string, "amount": number, "yoyChange": number}],
  "expenses": [{"category": string, "amount": number, "budgetVariance": number}]
}""",
    },
    "recipe_ingredients": {
        "description": "食谱配料表", "nesting_depth": 2, "array_length_range": (5, 15),
        "prompt": """Generate a realistic recipe with ingredients list as JSON.
Include recipe name, servings, prep time, and ingredients.
Return ONLY valid JSON, no markdown fences.

Schema:
{
  "recipeName": string,
  "servings": number,
  "prepTimeMinutes": number,
  "ingredients": [
    {"name": string, "amount": string, "unit": string}
  ]
}""",
    },
}

# ── 截断位置 ──
TRUNCATION_POSITIONS = [0.10, 0.25, 0.50, 0.75, 0.90]

# ── 样本数 ──
SAMPLES_PER_SCHEMA = 200

# ── 基线方法 ──
BASELINES = ["naive", "partial-json", "json-repair", "partialjson-py"]

# ── 消融实验配置 ──
ABLATION_CONFIGS = {
    "full": {"layer1": True, "layer2": True, "layer3": True, "icover": True, "thinking": True, "ticker": True},
    "no_layer3": {"layer1": True, "layer2": True, "layer3": False, "icover": True, "thinking": True, "ticker": True},
    "no_icover": {"layer1": True, "layer2": True, "layer3": True, "icover": False, "thinking": True, "ticker": True},
    "no_thinking": {"layer1": True, "layer2": True, "layer3": True, "icover": True, "thinking": False, "ticker": True},
    "no_ticker": {"layer1": True, "layer2": True, "layer3": True, "icover": True, "thinking": True, "ticker": False},
}

# ── 指标 ──
METRICS = ["recovery_rate", "field_f1", "value_accuracy", "parse_latency_ms", "e2e_ttft_ms", "e2e_complete_ms"]

# ── 统计显著性 ──
SIGNIFICANCE_LEVEL = 0.05

# ── 数据收集 (需自行配置 API Key, 见 README) ──
# 原始 LLM 输出已随仓库公开, 复现评估无需调用 API; 如需重新采集数据,
# 请设置对应的环境变量 (如 OPENAI_API_KEY) 后运行 collect_llm_outputs.py。
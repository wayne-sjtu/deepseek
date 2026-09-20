"""生成 AI 效能运营台所需的 mock 数据集。

设计要点
--------
1. 数据模型严格对齐接口文档 ``document.yaml`` 的字段口径，字段名与文档保持一致（或给出映射），
   真实接口接入时只需替换 dataSource 层，不动页面代码。
2. 粒度：成员 × 自然日。所有部门级 / 公司级指标都由成员日粒度**聚合**得出，
   保证「部门汇总之和 == 公司总量」，避免对不齐导致的信任问题。
3. 确定性：固定随机种子，任何机器上重复生成结果完全一致。
4. 仅使用 Python 标准库，无需 pip 安装依赖。

字段口径来源（document.yaml 行号）
---------------------------------
- /dashboard/member/data            L1690+  成员代码量 / AI 生成量 / 采纳率 / 生成率
- /observability/metric-*           L6478+  token / 模型调用 / 首 token / 工具调用 / 会话
- /openapi/usage/members/query      L2511+  Credits 消耗、周期限量
- /openapi/members                  L1955+  成员、部门、加入时间
- /openapi/resources/overview       L6783+  积分与席位余额
"""

from __future__ import annotations

import json
import math
import os
import random
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SEED = 20260920
TZ = timezone(timedelta(hours=8))  # 东八区，与文档示例一致
WINDOW_DAYS = 180  # 生成 180 天日粒度，足够支撑 7/30/90/自定义区间对比


def _resolve_reference_day() -> date:
    """确定数据窗口的「今天」。

    默认取**运行当天**：这样任何时间生成的看板都是「最近 180 天」，
    不会出现「clone 下来看到半年前的数据」这种过期演示。

    需要字节级可复现时（CI 快照、回归对比）用环境变量钉住：
        AEC_REFERENCE_DAY=2026-09-20 python3 backend/app/gen_mock.py
    固定种子 SEED 只保证**数值**可复现，日期是另一维度，必须单独钉。
    """
    raw = os.environ.get("AEC_REFERENCE_DAY", "").strip()
    if raw:
        return date.fromisoformat(raw)
    return date.today()


REFERENCE_DAY = _resolve_reference_day()

ENTERPRISE_ID = "1234567890"
ENTERPRISE_NAME = "示例科技集团"

# --------------------------------------------------------------------------
# 组织架构
# --------------------------------------------------------------------------
DEPARTMENTS = [
    # id, 名称, 全路径, 上级, 语言画像, 生产力系数, AI 采纳强度, 人数
    ("dept-root", "示例科技集团", "示例科技集团", None, None, 0.0, 0.0, 0),
    ("dept-001", "平台研发中心", "示例科技集团/平台研发中心", "dept-root", ["Go", "Python", "SQL"], 1.28, 1.32, 12),
    ("dept-002", "客户端研发部", "示例科技集团/客户端研发部", "dept-root", ["TypeScript", "Swift", "Kotlin"], 1.16, 1.18, 9),
    ("dept-003", "数据与算法部", "示例科技集团/数据与算法部", "dept-root", ["Python", "SQL"], 1.10, 1.45, 8),
    ("dept-004", "产品设计部", "示例科技集团/产品设计部", "dept-root", ["TypeScript", "Markdown"], 0.82, 0.94, 6),
    ("dept-005", "质量保障部", "示例科技集团/质量保障部", "dept-root", ["Python", "TypeScript"], 0.92, 1.06, 7),
    ("dept-006", "企业服务与运营", "示例科技集团/企业服务与运营", "dept-root", ["Java", "SQL", "Markdown"], 0.74, 0.78, 6),
]
DEPARTMENT_BY_ID = {d[0]: d for d in DEPARTMENTS}

# 各语言在「新增代码字符数 / 行数」上的平均密度，用于让字符数与行数自洽
LANG_CHARS_PER_LINE = {
    "Go": 34, "Java": 37, "TypeScript": 32, "Python": 29,
    "Swift": 33, "Kotlin": 34, "SQL": 41, "Markdown": 52,
}

SURNAMES = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜"
GIVEN_NAMES = [
    "嘉树", "子墨", "宇航", "思远", "晨曦", "雨桐", "若冰", "文轩", "梓涵", "沐辰",
    "一鸣", "子瑜", "亦舟", "悠然", "知微", "折枝", "南乔", "北辰", "清和", "白露",
    "疏影", "观棋", "长歌", "星野", "云舒", "予安", "承宇", "宁远", "振宇", "静姝",
]

CLIENTS = ["VSCode", "JetBrains", "WorkBuddy", "Web", "CLI"]
CLIENT_WEIGHTS = [0.52, 0.18, 0.16, 0.09, 0.05]
PLUGIN_VERSIONS = ["v5.18.2", "v5.19.0", "v5.20.1", "v5.20.3"]
PLUGIN_WEIGHTS = [0.12, 0.23, 0.31, 0.34]
MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-lite", "claude-sonnet-4.6", "gpt-5.2-codex"]
MODEL_WEIGHTS = [0.46, 0.22, 0.14, 0.11, 0.07]


def _round(value: float, digits: int = 4) -> float:
    return round(value + 1e-9, digits)


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _weighted(rng: random.Random, items: list, weights: list):
    return rng.choices(items, weights=weights, k=1)[0]


def _is_weekend(day: date) -> bool:
    return day.weekday() >= 5


def _ramp(t: float, start: float, end: float) -> float:
    """线性爬坡：t 归一化到 [0,1]。"""
    return start + (end - start) * _clamp(t, 0.0, 1.0)


def build_org(rng: random.Random) -> tuple[list[dict], list[dict]]:
    """构造部门与成员名册。"""
    departments: list[dict] = []
    for dept_id, name, full_path, parent, langs, prod, adopt, headcount in DEPARTMENTS:
        departments.append({
            "departmentId": dept_id,
            "departmentName": name,
            "fullPath": full_path,
            "parentId": parent,
            "level": 0 if parent is None else (1 if parent == "dept-root" else 2),
            "status": "enabled",
        })

    members: list[dict] = []
    used_names: set[str] = set()
    for dept_id, name, _full, _parent, langs, prod, adopt, headcount in DEPARTMENTS:
        if headcount == 0:
            continue
        for index in range(headcount):
            while True:
                given = rng.choice(GIVEN_NAMES)
                surname = rng.choice(SURNAMES)
                user_name = f"{surname}{given}"
                if user_name not in used_names:
                    used_names.add(user_name)
                    break
            # 8 位成员为窗口期内新入职，用于体现「新人爬坡」
            is_new_joiner = rng.random() < 0.16
            if is_new_joiner:
                joined_offset = rng.randint(20, 130)
            else:
                joined_offset = rng.randint(WINDOW_DAYS + 60, WINDOW_DAYS + 900)
            joined_at = REFERENCE_DAY - timedelta(days=joined_offset)
            # 5% 成员近 21 天完全无活跃，用于验证「不活跃」筛选与空态
            dormant = len(members) % 16 == 15  # 每个部门固定留 1 位长期不活跃成员，便于验证空态与提醒
            primary_lang = rng.choice(langs)
            members.append({
                "userId": f"{rng.randrange(16**8):08x}-{rng.randrange(16**4):04x}-4{rng.randrange(16**3):03x}-"
                          f"{rng.choice('89ab')}{rng.randrange(16**3):03x}-{rng.randrange(16**12):012x}",
                "userName": user_name,
                "userNickname": user_name,
                "email": f"user{len(members) + 1:03d}@example.com",
                "primaryDepartmentId": dept_id,
                "primaryDepartmentName": name,
                "departmentFullPath": DEPARTMENT_BY_ID[dept_id][2],
                "departmentIds": [dept_id],
                "departmentNames": [name],
                "departmentFullPaths": [DEPARTMENT_BY_ID[dept_id][2]],
                "joinedAt": datetime.combine(joined_at, datetime.min.time(), TZ).isoformat(),
                # —— 隐藏的生成参数（不直接暴露给页面，供生成器内部使用）——
                "_prod": prod * rng.uniform(0.62, 1.55),
                "_adopt": adopt * rng.uniform(0.72, 1.34),
                "_lang": primary_lang,
                "_dormant": dormant,
                "_joinedOffset": joined_offset,
                "_activityBias": rng.uniform(0.75, 1.3),
            })
    return departments, members


def generate() -> dict:
    rng = random.Random(SEED)
    departments, members = build_org(rng)

    start_day = REFERENCE_DAY - timedelta(days=WINDOW_DAYS - 1)
    days = [start_day + timedelta(days=i) for i in range(WINDOW_DAYS)]

    # 公司级 AI 使用渗透曲线：180 天内从 0.6 爬到 1.15，叠加月度波动
    def company_curve(day_index: int) -> float:
        base = _ramp(day_index / (WINDOW_DAYS - 1), 0.60, 1.15)
        monthly = 1.0 + 0.05 * math.sin((day_index / 30.0) * 2 * math.pi)
        return base * monthly

    series: list[dict] = []
    for day_index, day in enumerate(days):
        weekend = _is_weekend(day)
        weekend_factor = 0.17 if weekend else rng.uniform(0.93, 1.08)
        curve = company_curve(day_index)
        for member in members:
            if day < start_day:
                continue
            # 入职前无数据
            if day < REFERENCE_DAY - timedelta(days=member["_joinedOffset"]):
                continue
            if member["_dormant"] and (REFERENCE_DAY - day).days < 40:  # 长期不活跃：近 40 天零使用，但历史仍有基线
                continue
            if rng.random() < 0.04:  # 当天无任何 AI 行为
                continue

            tenure_days = (day - (REFERENCE_DAY - timedelta(days=member["_joinedOffset"]))).days
            tenure_factor = _ramp(tenure_days / 45.0, 0.35, 1.0)

            # 「活跃强度」：驱动所有绝对量指标，保证各指标同向变化
            intensity = (
                member["_prod"] * member["_activityBias"] * tenure_factor
                * curve * weekend_factor * rng.uniform(0.55, 1.4)
            )
            intensity = max(intensity, 0.05)

            chars_per_line = LANG_CHARS_PER_LINE.get(member["_lang"], 33)

            # —— 代码补全 ——
            comp_gen = max(0, round(rng.gauss(58, 9) * intensity))
            comp_accept = round(comp_gen * _clamp(rng.gauss(0.29, 0.05) * member["_adopt"], 0.02, 0.72))
            comp_rate = _round(comp_accept / comp_gen * 100, 2) if comp_gen else 0.0
            comp_gen_lines = round(comp_gen * rng.uniform(1.1, 2.4))
            comp_gen_chars = round(comp_gen_lines * chars_per_line * rng.uniform(0.7, 1.15))
            comp_accept_lines = round(comp_gen_lines * comp_accept / comp_gen) if comp_gen else 0
            comp_accept_chars = round(comp_gen_chars * comp_accept / comp_gen) if comp_gen else 0
            comp_line_rate = _round(comp_accept_lines / comp_gen_lines * 100, 2) if comp_gen_lines else 0.0
            comp_char_rate = _round(comp_accept_chars / comp_gen_chars * 100, 2) if comp_gen_chars else 0.0

            # —— 对话 ——
            dialog = max(0, round(rng.gauss(15, 3.4) * intensity))
            ask = round(dialog * rng.uniform(0.18, 0.34))
            craft = round(dialog * rng.uniform(0.24, 0.40))
            agent = round(dialog * rng.uniform(0.06, 0.20))
            knowledge = round(dialog * rng.uniform(0.03, 0.12))
            context = round(dialog * rng.uniform(0.02, 0.09))
            command = round(dialog * rng.uniform(0.01, 0.06))
            action = round(dialog * rng.uniform(0.0, 0.03))
            custom = round(dialog * rng.uniform(0.0, 0.04))

            # —— 代码生成量（AI 生成 vs 新增总量）——
            target_rate = _clamp(0.72 * member["_adopt"] * rng.uniform(0.82, 1.14), 0.18, 0.965)
            total_lines = max(1, comp_accept_lines + round(rng.gauss(46, 11) * intensity))
            ai_lines = round(total_lines * target_rate)
            total_chars = round(total_lines * chars_per_line * rng.uniform(0.82, 1.22))
            ai_chars = round(total_chars * target_rate * rng.uniform(0.94, 1.06))
            gen_rate_lines = _round(ai_lines / total_lines * 100, 2)
            gen_rate_chars = _round(ai_chars / total_chars * 100, 2) if total_chars else 0.0

            # —— token 与 Credits 消耗（成本敞口）——
            input_tokens = round(dialog * rng.uniform(1500, 3400) + comp_gen * rng.uniform(20, 45))
            output_tokens = round(dialog * rng.uniform(320, 780) + comp_accept * rng.uniform(28, 62))
            cache_read = round(input_tokens * rng.uniform(0.16, 0.44))
            credit = _round(
                dialog * rng.uniform(2.4, 5.1)
                + comp_gen * rng.uniform(0.05, 0.11)
                + output_tokens / 1000.0 * rng.uniform(0.55, 0.95),
                2,
            )
            credit_cost = _round(credit * 0.0126, 4)

            # —— 会话 / 请求 / 工具调用（可观测域）——
            session_count = max(1, round(dialog / rng.uniform(2.4, 4.2)))
            request_count = dialog + max(0, round(comp_gen * rng.uniform(0.02, 0.06)))
            error_count = 1 if rng.random() < 0.018 else 0
            tool_calls = round(agent * rng.uniform(1.4, 4.6)) + (1 if rng.random() < 0.3 else 0)
            tool_errors = 1 if tool_calls and rng.random() < 0.03 else 0
            ttft_avg = round(rng.gauss(680, 90) * (1.0 + max(0.0, (0.85 - curve)) * 0.5))
            p50 = round(ttft_avg * rng.uniform(0.72, 0.86))
            p90 = round(ttft_avg * rng.uniform(1.9, 2.5))
            p95 = round(p90 * rng.uniform(1.1, 1.28))
            p99 = round(p95 * rng.uniform(1.12, 1.35))
            duration_avg = round(rng.gauss(3200, 600) * (1.0 + intensity * 0.06))
            duration_p50 = round(duration_avg * rng.uniform(0.6, 0.75))
            duration_p95 = round(duration_avg * rng.uniform(2.0, 2.8))
            session_duration = round(session_count * rng.uniform(210, 640))
            session_rounds = _round(dialog / session_count, 2)

            series.append({
                "d": day.isoformat(),
                "u": member["userId"],
                # 代码补全
                "cg": comp_gen, "ca": comp_accept,
                "cgl": comp_gen_lines, "cal": comp_accept_lines,
                "cgc": comp_gen_chars, "cac": comp_accept_chars,
                # 对话
                "dc": dialog, "dk": ask, "dcr": craft, "dcy": custom, "dcm": command,
                "dct": context, "da": agent, "dkb": knowledge, "dac": action,
                # 代码量
                "ail": ai_lines, "tnl": total_lines, "aic": ai_chars, "tnc": total_chars,
                # 成本
                "cr": credit, "crc": credit_cost,
                "it": input_tokens, "ot": output_tokens, "cri": cache_read,
                # 会话与可观测
                "sc": session_count, "rq": request_count, "err": error_count,
                "tc": tool_calls, "te": tool_errors,
                "ttft": ttft_avg, "p50": p50, "p90": p90, "p95": p95, "p99": p99,
                "dur": duration_avg, "dp50": duration_p50, "dp95": duration_p95,
                "sdur": session_duration, "srd": session_rounds,
                # 客户端 / 插件 / 模型（维度拆解）
                "cl": _weighted(rng, CLIENTS, CLIENT_WEIGHTS),
                "pv": _weighted(rng, PLUGIN_VERSIONS, PLUGIN_WEIGHTS),
                "md": _weighted(rng, MODELS, MODEL_WEIGHTS),
                "lg": member["_lang"],
            })

    # 补齐成员维度派生字段（由日粒度聚合，口径与文档 L1828-L1923 一致）
    agg: dict[str, dict] = {}
    for row in series:
        bucket = agg.setdefault(row["u"], {"cg": 0, "ca": 0, "cgl": 0, "cal": 0, "cgc": 0, "cac": 0,
                                           "dc": 0, "ail": 0, "tnl": 0, "aic": 0, "tnc": 0,
                                           "cr": 0.0, "it": 0, "ot": 0, "last": None, "active": set()})
        for key in ("cg", "ca", "cgl", "cal", "cgc", "cac", "dc", "ail", "tnl", "aic", "tnc", "it", "ot"):
            bucket[key] += row[key]
        bucket["cr"] += row["cr"]
        bucket["last"] = row["d"] if bucket["last"] is None or row["d"] > bucket["last"] else bucket["last"]
        bucket["active"].add(row["d"])

    for member in members:
        bucket = agg.get(member["userId"])
        if not bucket:
            # 窗口内完全无行为的成员：字段置零，便于前端展示冷启动状态
            member.update({
                "lastActiveTime": None, "activeDays": 0, "dialogCount": 0,
                "completionGenerateCount": 0, "completionAcceptCount": 0,
                "completionAcceptRateByCount": 0.0, "completionGenerateLines": 0,
                "completionAcceptLines": 0, "completionAcceptRateByLines": 0.0,
                "completionGenerateChars": 0, "completionAcceptChars": 0,
                "completionAcceptRateByChars": 0.0, "aiGenerateCodeLines": 0,
                "totalNewCodeLines": 0, "codeGenerateRateByLines": 0.0,
                "aiGenerateCodeChars": 0, "totalNewCodeChars": 0,
                "codeGenerateRateByChars": 0.0, "totalUsed": 0.0,
            })
        else:
            def pct(num: float, den: float) -> float:
                return _round(num / den * 100, 2) if den else 0.0
            member.update({
                "lastActiveTime": datetime.combine(
                    date.fromisoformat(bucket["last"]), datetime.min.time(), TZ
                ).replace(hour=17, minute=42).isoformat(),
                "activeDays": len(bucket["active"]),
                "dialogCount": bucket["dc"],
                "completionGenerateCount": bucket["cg"],
                "completionAcceptCount": bucket["ca"],
                "completionAcceptRateByCount": pct(bucket["ca"], bucket["cg"]),
                "completionGenerateLines": bucket["cgl"],
                "completionAcceptLines": bucket["cal"],
                "completionAcceptRateByLines": pct(bucket["cal"], bucket["cgl"]),
                "completionGenerateChars": bucket["cgc"],
                "completionAcceptChars": bucket["cac"],
                "completionAcceptRateByChars": pct(bucket["cac"], bucket["cgc"]),
                "aiGenerateCodeLines": bucket["ail"],
                "totalNewCodeLines": bucket["tnl"],
                "codeGenerateRateByLines": pct(bucket["ail"], bucket["tnl"]),
                "aiGenerateCodeChars": bucket["aic"],
                "totalNewCodeChars": bucket["tnc"],
                "codeGenerateRateByChars": pct(bucket["aic"], bucket["tnc"]),
                "totalUsed": _round(bucket["cr"], 2),
                "inputTokens": bucket["it"],
                "outputTokens": bucket["ot"],
            })
    # 周期限量：口径必须与「额度周期」对齐（自然月），因此用**当月消耗**推导，
    # 而不是用 180 天窗口消耗，否则看板窗口与额度周期错配、风险档位失真。
    cycle_prefix = REFERENCE_DAY.replace(day=1).isoformat()
    month_used: dict[str, float] = {}
    for row in series:
        if row["d"] >= cycle_prefix:
            month_used[row["u"]] = month_used.get(row["u"], 0.0) + row["cr"]

    for index, member in enumerate(members):
        base = month_used.get(member["userId"], 0.0)
        if index % 10 == 3:
            member["cycleLimit"] = None
            member["cycleLimitDisplay"] = "不限量"
        else:
            # 系数分布：<1.05 超限风险、1.05~1.4 偏高、>1.4 正常
            if index % 5 == 4:
                factor = 0.95
            elif index % 3 == 0:
                factor = 1.22
            else:
                factor = 1.85
            limit = int(base * factor) + 30
            member["cycleLimit"] = limit
            member["cycleLimitDisplay"] = str(limit)

    # 计算当前额度周期（自然月口径，与 usage/quota-cycle 对齐）
    cycle_start = REFERENCE_DAY.replace(day=1)
    next_month = (cycle_start + timedelta(days=32)).replace(day=1)
    quota_cycle = {
        "cycleType": "MONTHLY",
        "cycleMode": "natural_month",
        "cycleStart": datetime.combine(cycle_start, datetime.min.time(), TZ).isoformat(),
        "cycleEnd": datetime.combine(next_month, datetime.min.time(), TZ).isoformat(),
        "nextCycleStart": datetime.combine(next_month, datetime.min.time(), TZ).isoformat(),
    }

    # 资源概览：积分 + 席位（与 resources/overview 对齐）
    total_credit = sum(row["cr"] for row in series)
    license_total = len(members) + 24
    license_used = sum(1 for m in members if m["lastActiveTime"])
    resources = {
        "enterpriseId": ENTERPRISE_ID,
        "items": [
            {
                "resourceType": "credit", "unit": "credit",
                "total": int(total_credit * 1.42), "used": int(total_credit),
                "remaining": int(total_credit * 0.42),
                "remainingRatio": 0.42,
                "sources": [
                    {"sourceType": "fixedPackage", "name": "订阅包（当期）",
                     "total": int(total_credit * 1.2), "used": int(total_credit * 0.86),
                     "currentPeriodStart": quota_cycle["cycleStart"],
                     "currentPeriodEnd": quota_cycle["cycleEnd"],
                     "resetAt": quota_cycle["cycleEnd"]},
                    {"sourceType": "additionalPackage", "name": "加量包 A",
                     "total": int(total_credit * 0.12), "used": int(total_credit * 0.1),
                     "effectiveAt": quota_cycle["cycleStart"], "expiresAt": quota_cycle["cycleEnd"]},
                    {"sourceType": "enterpriseGiftPackage", "name": "企业赠送包",
                     "total": int(total_credit * 0.1), "used": int(total_credit * 0.04),
                     "effectiveAt": quota_cycle["cycleStart"], "expiresAt": quota_cycle["cycleEnd"]},
                ],
            },
            {"resourceType": "license", "unit": "seat", "total": license_total,
             "used": license_used, "remaining": license_total - license_used,
             "remainingRatio": _round((license_total - license_used) / license_total, 4)},
        ],
    }

    # 默认成员额度
    default_quota = {
        "cycleType": "MONTHLY", "cycleLimit": 12000, **{
            k: quota_cycle[k] for k in ("cycleMode", "cycleStart", "cycleEnd", "nextCycleStart")
        },
    }

    payload = {
        "meta": {
            "generatedAt": datetime.now(TZ).isoformat(),
            "referenceDay": REFERENCE_DAY.isoformat(),
            "windowDays": WINDOW_DAYS,
            "seed": SEED,
            "enterpriseId": ENTERPRISE_ID,
            "enterpriseName": ENTERPRISE_NAME,
            "note": "全部数值为 mock 数据，用于接口未就绪阶段的联调与视觉验收",
        },
        "departments": departments,
        "members": members,
        "quotaCycle": quota_cycle,
        "defaultQuota": default_quota,
        "resources": resources,
        "series": series,
    }
    return payload


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    out = root / "data" / "mock_dataset.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = generate()
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    size_kb = out.stat().st_size / 1024
    members = payload["members"]
    print(f"[OK] {out}  ({size_kb:.0f} KB)")
    print(f"     部门 {len(payload['departments']) - 1} 个 / 成员 {len(members)} 人 / 日粒度记录 {len(payload['series'])} 条")
    print(f"      窗口 {payload['meta']['referenceDay']} 往前 {WINDOW_DAYS} 天")
    total_lines = sum(m["totalNewCodeLines"] for m in members)
    ai_lines = sum(m["aiGenerateCodeLines"] for m in members)
    credit = sum(m["totalUsed"] for m in members)
    print(f"      新增代码 {total_lines:,} 行 / AI 生成 {ai_lines:,} 行 "
          f"(占比 {ai_lines / total_lines * 100:.1f}%) / Credits {credit:,.0f}")


if __name__ == "__main__":
    main()

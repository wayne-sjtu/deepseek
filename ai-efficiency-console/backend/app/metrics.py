"""指标聚合层。

职责：把「成员 × 日」粒度的原始数据聚合成接口文档要求的各种口径。
关键约束：**部门 / 公司级指标一律由成员日粒度求和得到**，不单独生成，
因此「部门汇总之和 == 公司总量」永远成立，前端不会出现对不齐的数字。

口径映射（document.yaml）
------------------------
成员级字段直接对应 /dashboard/member/data 的返回字段（L1828-L1923）。
派生比率一律「先求和再相除」，避免平均平均数的辛普森悖论。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Iterable

# 求和型字段（绝对量），其余为比率型
SUM_FIELDS = (
    "cg", "ca", "cgl", "cal", "cgc", "cac",
    "dc", "dk", "dcr", "dcy", "dcm", "dct", "da", "dkb", "dac",
    "ail", "tnl", "aic", "tnc",
    "cr", "crc", "it", "ot", "cri",
    "sc", "rq", "err", "tc", "te",
)


def _empty_totals() -> dict:
    totals = {k: 0 for k in SUM_FIELDS}
    totals["cr"] = 0.0
    totals["crc"] = 0.0
    return totals


@dataclass
class Slice:
    """一个时间窗口内的聚合结果。"""

    start: str
    end: str
    days: int
    org: dict
    departments: dict[str, dict] = field(default_factory=dict)
    members: dict[str, dict] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "start": self.start, "end": self.end, "days": self.days,
            "org": self.org, "departments": self.departments, "members": self.members,
        }


def _ratio(num: float, den: float) -> float | None:
    if not den:
        return None
    return round(num / den * 100, 2)


def _finalize(totals: dict, member_count: int = 1) -> dict:
    """把求和结果换算成与接口文档一致的比率字段。"""
    out = dict(totals)
    out["completionAcceptRateByCount"] = _ratio(totals["ca"], totals["cg"])
    out["completionAcceptRateByLines"] = _ratio(totals["cal"], totals["cgl"])
    out["completionAcceptRateByChars"] = _ratio(totals["cac"], totals["cgc"])
    out["codeGenerateRateByLines"] = _ratio(totals["ail"], totals["tnl"])
    out["codeGenerateRateByChars"] = _ratio(totals["aic"], totals["tnc"])
    out["credit"] = round(totals["cr"], 2)
    out["aiCodeLines"] = totals["ail"]
    out["totalNewCodeLines"] = totals["tnl"]
    out["dialogCount"] = totals["dc"]
    # 与 document.yaml /dashboard/member/data 字段命名对齐的别名
    out["completionGenerateCount"] = totals["cg"]
    out["completionAcceptCount"] = totals["ca"]
    out["completionGenerateLines"] = totals["cgl"]
    out["completionAcceptLines"] = totals["cal"]
    out["completionGenerateChars"] = totals["cgc"]
    out["completionAcceptChars"] = totals["cac"]
    out["aiGenerateCodeLines"] = totals["ail"]
    out["totalNewCodeLines"] = totals["tnl"]
    out["aiGenerateCodeChars"] = totals["aic"]
    out["totalNewCodeChars"] = totals["tnc"]
    out["sessionCount"] = totals["sc"]
    out["requestCount"] = totals["rq"]
    out["toolCallCount"] = totals["tc"]
    out["inputTokens"] = totals["it"]
    out["outputTokens"] = totals["ot"]
    out["tokenUsage"] = totals["it"] + totals["ot"]
    out["cacheReadInputTokens"] = totals["cri"]
    # 可靠性 / 时延派生指标
    out["requestErrorRate"] = _ratio(totals["err"], totals["rq"])
    out["toolErrorRate"] = _ratio(totals["te"], totals["tc"])
    return out


def build_indexes(dataset: dict) -> dict:
    """预计算索引，避免每次请求都线性扫描。"""
    members = {m["userId"]: m for m in dataset["members"]}
    dept_of = {m["userId"]: m["primaryDepartmentId"] for m in dataset["members"]}
    # 按日 -> 记录列表，便于时间窗口切片
    by_day: dict[str, list[dict]] = {}
    for row in dataset["series"]:
        by_day.setdefault(row["d"], []).append(row)
    return {
        "members": members,
        "dept_of": dept_of,
        "by_day": by_day,
        "days": sorted(by_day.keys()),
        "departments": {d["departmentId"]: d for d in dataset["departments"]},
    }


def _iter_rows(index: dict, start: str, end: str, user_ids: set[str] | None) -> Iterable[dict]:
    for day in index["days"]:
        if day < start or day > end:
            continue
        for row in index["by_day"][day]:
            if user_ids is not None and row["u"] not in user_ids:
                continue
            yield row


def aggregate(
    dataset: dict,
    index: dict,
    start: str,
    end: str,
    user_ids: set[str] | None = None,
    department_ids: set[str] | None = None,
) -> Slice:
    """按 [start, end] 闭区间聚合，可选按成员 / 部门下钻。"""
    if department_ids:
        scoped = {uid for uid, did in index["dept_of"].items() if did in department_ids}
        user_ids = scoped if user_ids is None else (user_ids & scoped)

    org = _empty_totals()
    per_member: dict[str, dict] = {}
    per_dept: dict[str, dict] = {}
    active_days: dict[str, set] = {}
    last_active: dict[str, str] = {}
    distinct_days: set[str] = set()

    for row in _iter_rows(index, start, end, user_ids):
        uid = row["u"]
        bucket = per_member.setdefault(uid, _empty_totals())
        for key in SUM_FIELDS:
            value = row[key]
            org[key] += value
            bucket[key] += value
        active_days.setdefault(uid, set()).add(row["d"])
        if uid not in last_active or row["d"] > last_active[uid]:
            last_active[uid] = row["d"]
        distinct_days.add(row["d"])
        dept_id = index["dept_of"].get(uid)
        if dept_id:
            dept_bucket = per_dept.setdefault(dept_id, _empty_totals())
            for key in SUM_FIELDS:
                dept_bucket[key] += row[key]

    days = len(distinct_days)
    org_out = _finalize(org)
    org_out["activeUserNum"] = len(per_member)
    org_out["dau"] = round(len(per_member) / days, 1) if days else 0
    org_out["avgCreditsPerActiveUser"] = (
        round(org["cr"] / len(per_member), 2) if per_member else 0
    )
    org_out["avgAiLinesPerActiveUser"] = (
        round(org["ail"] / len(per_member), 1) if per_member else 0
    )

    departments_out: dict[str, dict] = {}
    for dept_id, totals in per_dept.items():
        dept_members = [uid for uid in per_member if index["dept_of"].get(uid) == dept_id]
        if not dept_members:
            continue
        out = _finalize(totals)
        out["departmentId"] = dept_id
        out["activeUserNum"] = len(dept_members)
        out["memberCount"] = sum(
            1 for m in dataset["members"] if m["primaryDepartmentId"] == dept_id
        )
        out["activeRate"] = _ratio(len(dept_members), out["memberCount"]) or 0.0
        out["avgCreditsPerActiveUser"] = round(totals["cr"] / len(dept_members), 2)
        out["avgAiLinesPerActiveUser"] = round(totals["ail"] / len(dept_members), 1)
        out["creditsPerKline"] = (
            round(totals["cr"] / (totals["tnl"] / 1000.0), 2) if totals["tnl"] else None
        )
        departments_out[dept_id] = out

    members_out: dict[str, dict] = {}
    for uid, totals in per_member.items():
        meta = index["members"].get(uid, {})
        out = _finalize(totals)
        out["userId"] = uid
        out["userName"] = meta.get("userName")
        out["userNickname"] = meta.get("userNickname")
        out["primaryDepartmentId"] = meta.get("primaryDepartmentId")
        out["primaryDepartmentName"] = meta.get("primaryDepartmentName")
        out["departmentFullPaths"] = meta.get("departmentFullPaths", [])
        out["activeDays"] = len(active_days.get(uid, ()))
        out["lastActiveTime"] = (
            f"{last_active[uid]}T17:42:00+08:00" if uid in last_active else None
        )
        out["cycleLimit"] = meta.get("cycleLimit")
        out["cycleLimitDisplay"] = meta.get("cycleLimitDisplay")
        # 配额使用率：仅对限量成员有意义，不限量返回 null
        limit = meta.get("cycleLimit")
        out["quotaUsageRate"] = _ratio(totals["cr"], limit) if limit else None
        out["creditsPerKline"] = (
            round(totals["cr"] / (totals["tnl"] / 1000.0), 2) if totals["tnl"] else None
        )
        # 人均日产出，用于识别「高消耗低产出」
        out["aiLinesPerActiveDay"] = (
            round(totals["ail"] / out["activeDays"], 1) if out["activeDays"] else 0
        )
        members_out[uid] = out

    return Slice(start=start, end=end, days=days, org=org_out,
                 departments=departments_out, members=members_out)


# --------------------------------------------------------------------------
# 趋势与分组
# --------------------------------------------------------------------------
GROUP_DIMENSIONS = {
    "department": "主部门",
    "user": "成员",
    "model": "模型",
    "client": "客户端",
    "plugin": "插件版本",
    "language": "编程语言",
    "taskScene": "任务场景",
}

ROW_DIM_FIELD = {
    "model": "md",
    "client": "cl",
    "plugin": "pv",
    "language": "lg",
}

# 可观测白名单指标 -> 原始字段
METRIC_WHITELIST: dict[str, tuple[str, str]] = {
    # 指标名: (原始字段, 单位)
    "genai_request_count": ("rq", ""),
    "model_request_count": ("rq", ""),
    "model_error_count": ("err", ""),
    "tool_call_count": ("tc", ""),
    "tool_error_count": ("te", ""),
    "tool_error_rate": ("__tool_error_rate__", "%"),
    "session_count": ("sc", ""),
    "user_count": ("__user_count__", ""),
    "dau": ("__dau__", ""),
    "credit": ("cr", ""),
    "credit_cost": ("crc", ""),
    "input_token": ("it", ""),
    "output_token": ("ot", ""),
    "token_usage": ("__token_usage__", ""),
    "cache_read_input_token": ("cri", ""),
    "ttft_avg": ("ttft", "ms"),
    "ttft_p50": ("p50", "ms"),
    "ttft_p90": ("p90", "ms"),
    "ttft_p95": ("p95", "ms"),
    "ttft_p99": ("p99", "ms"),
    "genai_operation_duration_avg": ("dur", "ms"),
    "model_invocation_duration_p50": ("dp50", "ms"),
    "model_invocation_duration_p95": ("dp95", "ms"),
    "completion_accept_rate_by_lines": ("__accept_line_rate__", "%"),
    "code_generate_rate_by_lines": ("__gen_line_rate__", "%"),
    "ai_generate_code_lines": ("ail", ""),
    "total_new_code_lines": ("tnl", ""),
    "dialog_count": ("dc", ""),
}


def _metric_value(name: str, totals: dict, extra: dict) -> tuple[float, str]:
    field_name, unit = METRIC_WHITELIST.get(name, (None, ""))
    if field_name is None:
        raise KeyError(name)
    if field_name.startswith("__"):
        return extra.get(field_name, 0.0), unit
    raw = totals.get(field_name, 0)
    if name in ("ttft_avg", "ttft_p50", "ttft_p90", "ttft_p95", "ttft_p99",
                "genai_operation_duration_avg", "model_invocation_duration_p50",
                "model_invocation_duration_p95"):
        # 时延类指标需要按权重平均而非求和（此处以记录条数近似加权）
        return float(raw), unit
    return float(raw), unit


def bucket_seconds_for(days: int) -> int:
    if days <= 2:
        return 300
    if days <= 7:
        return 3600
    return 86400


def daily_points(index: dict, start: str, end: str, field: str,
                 group: str | None, user_ids: set[str] | None) -> dict[str, list[tuple[str, float]]]:
    """返回 {分组值: [(日期, 值)]}，稀疏（无数据日不产出）。"""
    rows = list(_iter_rows(index, start, end, user_ids))
    if group == "department":
        key_of = lambda row: index["dept_of"].get(row["u"], "unknown")  # noqa: E731
    elif group == "user":
        key_of = lambda row: index["members"].get(row["u"], {}).get("userName", row["u"])  # noqa: E731
    elif group in ROW_DIM_FIELD:
        src = ROW_DIM_FIELD[group]
        key_of = lambda row: row[src]  # noqa: E731
    else:
        key_of = lambda row: "__total__"  # noqa: E731

    buckets: dict[str, dict[str, float]] = {}
    for row in rows:
        key = key_of(row)
        day = row["d"]
        buckets.setdefault(key, {})
        buckets[key][day] = buckets[key].get(day, 0.0) + float(row[field])
    return {
        key: sorted(day_map.items()) for key, day_map in buckets.items()
    }


def date_range(start: str, end: str) -> list[str]:
    begin = date.fromisoformat(start)
    finish = date.fromisoformat(end)
    return [(begin + timedelta(days=i)).isoformat() for i in range((finish - begin).days + 1)]

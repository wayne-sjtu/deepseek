"""AI 效能运营台 —— 后端服务（Python 标准库实现，零依赖）。

定位
----
1. **接口契约骨架**：路径与字段严格对齐 `document.yaml`（企业 OpenAPI）。真实企业接口
   就绪后，把 `DataSource` 换成 HTTP 客户端即可，前端与页面无需改动。
2. **Mock 数据源**：读取 `data/mock_dataset.json`（由 gen_mock.py 生成），
   在服务端完成部门 / 成员 / 组织级聚合，前端只负责展示。

启动
----
    python3 backend/app/gen_mock.py            # 首次：生成 mock 数据集（不入库）
    python3 backend/app/server.py --port 8000

自检
----
    python3 backend/app/server.py --selftest

支持的接口（{enterpriseId} 固定为数据集中的企业 ID）
--------------------------------------------------
GET  /api/enterprises/{eid}/info
GET  /api/enterprises/{eid}/openapi/members
GET  /api/enterprises/{eid}/openapi/departments
GET  /api/enterprises/{eid}/openapi/usage/quota-cycle
GET  /api/enterprises/{eid}/openapi/usage/default-quota
GET  /api/enterprises/{eid}/openapi/resources/overview
POST /api/enterprises/{eid}/openapi/usage/members/query
POST /api/enterprises/{eid}/openapi/usage/members/limit-query
POST /api/enterprises/{eid}/openapi/usage/members/quota/update
POST /api/enterprises/{eid}/openapi/usage/departments/{departmentId}/quota/update
POST /api/enterprises/{eid}/dashboard/member/data
POST /api/enterprises/{eid}/dashboard/analytics/{activity|dialog|completion|generation}
GET  /api/enterprises/{eid}/metrics
POST /api/enterprises/{eid}/openapi/observability/metric-summary/query
POST /api/enterprises/{eid}/openapi/observability/metric-trend/query
POST /api/enterprises/{eid}/openapi/observability/metric-records/query
POST /api/v1/efficiency/overview        # 本方案扩展：部门级效能总览（一次拿齐首屏）
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import threading
import traceback
import uuid
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from metrics import (  # noqa: E402
    GROUP_DIMENSIONS,
    METRIC_WHITELIST,
    ROW_DIM_FIELD,
    aggregate,
    bucket_seconds_for,
    build_indexes,
    daily_points,
    date_range,
)

ROOT = Path(__file__).resolve().parents[2]
DATASET_PATH = ROOT / "data" / "mock_dataset.json"
DIST_DIR = ROOT / "frontend" / "dist"
TZ = timezone(timedelta(hours=8))

# --------------------------------------------------------------------------
# 数据源
# --------------------------------------------------------------------------
class DataSource:
    """Mock 数据源。可平滑替换为真实 OpenAPI 客户端。"""

    def __init__(self, path: Path):
        self.path = path
        self.reload()

    def reload(self) -> None:
        if not self.path.exists():
            # 数据集是生成物（不入库），缺了要给可执行的指引，而不是让上层抛 FileNotFoundError
            raise SystemExit(
                f"未找到 mock 数据集：{self.path}\n"
                f"数据集由生成器产出且不入库，请先执行：\n"
                f"    python3 backend/app/gen_mock.py\n"
                f"（可用 AEC_REFERENCE_DAY=YYYY-MM-DD 钉住数据窗口终点以获得可复现的数据）"
            )
        with self.path.open(encoding="utf-8") as fh:
            self.dataset = json.load(fh)
        self.index = build_indexes(self.dataset)
        self.members = self.dataset["members"]
        self.member_by_id = {m["userId"]: m for m in self.members}
        self.member_by_name = {m["userName"]: m for m in self.members}
        self.enterprise_id = self.dataset["meta"]["enterpriseId"]
        self.window_start = self.dataset["meta"].get("referenceDay")
        # 可写的运行时状态（额度调整）
        self.default_quota = dict(self.dataset["defaultQuota"])
        self.audit: list[dict] = []

    # —— 时间窗口工具 ——
    @property
    def last_day(self) -> str:
        return self.index["days"][-1]

    def resolve_range(self, start: str | None, end: str | None, default_days: int = 30) -> tuple[str, str]:
        end = (end or self.last_day)[:10]
        if not start:
            start = (date.fromisoformat(end) - timedelta(days=default_days - 1)).isoformat()
        else:
            start = start[:10]
        if start > end:
            start, end = end, start
        return start, end

    def previous_range(self, start: str, end: str) -> tuple[str, str]:
        span = (date.fromisoformat(end) - date.fromisoformat(start)).days + 1
        prev_end = date.fromisoformat(start) - timedelta(days=1)
        prev_start = prev_end - timedelta(days=span - 1)
        return prev_start.isoformat(), prev_end.isoformat()

    def slice(self, start: str, end: str, user_ids=None, department_ids=None):
        return aggregate(self.dataset, self.index, start, end, user_ids, department_ids)


DS: DataSource


# --------------------------------------------------------------------------
# 响应工具
# --------------------------------------------------------------------------
def ok(data, extra: dict | None = None) -> dict:
    payload = {"code": 0, "msg": "OK", "requestId": str(uuid.uuid4()), "data": data}
    if extra:
        payload.update(extra)
    return payload


def err(code: int, msg: str) -> dict:
    return {"code": code, "msg": msg, "requestId": str(uuid.uuid4())}


def metric_card(key: str, name: str, current: float, previous: float, unit: str = "",
                higher_is_better: bool = True) -> dict:
    if previous in (None, 0):
        growth, change = (0.0, "new") if current else (0.0, "stable")
    else:
        growth = round((current - previous) / previous * 100, 2)
        if abs(growth) < 0.05:
            change = "stable"
        else:
            change = "increase" if growth > 0 else "decrease"
    return {
        "key": key, "name": name, "unit": unit,
        "current": current, "previous": previous, "growthRate": growth,
        "changeType": change, "higherIsBetter": higher_is_better,
    }


def series_point(key: str, name: str, points: list[tuple[str, float]], chart_type: str = "line") -> dict:
    return {
        "key": key, "name": name, "type": chart_type,
        "points": [{"time": t, "value": v} for t, v in points],
    }


# --------------------------------------------------------------------------
# Dashboard 域
# --------------------------------------------------------------------------
def _member_filter(payload: dict) -> set[str] | None:
    mf = payload.get("memberFilter") or {"type": "all"}
    if mf.get("type") == "selected" and mf.get("data"):
        return set(mf["data"])
    return None


def _department_filter(payload: dict) -> set[str] | None:
    ids = payload.get("departmentIds") or []
    return set(ids) if ids else None


def analytics_activity(start: str, end: str, user_ids, dept_ids) -> dict:
    cur = DS.slice(start, end, user_ids, dept_ids)
    p_start, p_end = DS.previous_range(start, end)
    prev = DS.slice(p_start, p_end, user_ids, dept_ids)
    days = [d for d in date_range(start, end)]

    # 日活曲线（按部门分组）
    daily: dict[str, dict[str, set]] = {}
    for day in days:
        daily[day] = {}
        for row in DS.index["by_day"].get(day, []):
            if user_ids is not None and row["u"] not in user_ids:
                continue
            dept = DS.index["dept_of"].get(row["u"])
            if dept_ids and dept not in dept_ids:
                continue
            daily[day].setdefault(dept, set()).add(row["u"])

    active_points = [(d, len({u for s in daily[d].values() for u in s})) for d in days]
    new_users = [m for m in DS.members
                 if (user_ids is None or m["userId"] in user_ids)
                 and m["joinedAt"][:10] >= start and m["joinedAt"][:10] <= end]

    dept_dist = sorted(
        ({"label": DS.index["departments"].get(k, {}).get("departmentName", k),
          "value": v["activeUserNum"],
          "extra": {"credit": v["credit"], "aiLines": v["aiCodeLines"]}}
         for k, v in cur.departments.items()),
        key=lambda x: -x["value"],
    )
    client_agg: dict[str, int] = {}
    for row in DS.index["by_day"].get(end, []):
        if user_ids is not None and row["u"] not in user_ids:
            continue
        client_agg[row["cl"]] = client_agg.get(row["cl"], 0) + 1

    return {
        "summary": {"metrics": [
            metric_card("activeUsers", "活跃用户", cur.org["activeUserNum"], prev.org["activeUserNum"], "人"),
            metric_card("dau", "日均活跃", cur.org["dau"], prev.org["dau"], "人"),
            metric_card("activeRate", "活跃率",
                        round(cur.org["activeUserNum"] / max(len(DS.members), 1) * 100, 2),
                        round(prev.org["activeUserNum"] / max(len(DS.members), 1) * 100, 2), "%"),
            metric_card("newUsers", "窗口内新增席位", len(new_users), 0, "人"),
        ]},
        "charts": {"charts": [
            {"key": "activeUserDistribution", "title": "活跃用户部门分布", "type": "pie",
             "data": {"items": dept_dist}},
            {"key": "activeUserByClient", "title": "当日客户端活跃分布", "type": "bar",
             "data": {"items": [{"label": k, "value": v} for k, v in
                                sorted(client_agg.items(), key=lambda x: -x[1])]}},
        ]},
        "trends": {"series": [
            series_point("activeUsers", "日活跃人数", active_points, "area"),
        ]},
        "dimension": {"type": "department", "label": "部门"},
    }


def analytics_dialog(start: str, end: str, user_ids, dept_ids) -> dict:
    cur = DS.slice(start, end, user_ids, dept_ids)
    p_start, p_end = DS.previous_range(start, end)
    prev = DS.slice(p_start, p_end, user_ids, dept_ids)

    totals = cur.org
    modes = [
        ("dk", "Ask 问答"), ("dcr", "Craft 编码"), ("da", "Agent"),
        ("dkb", "知识库"), ("dct", "上下文"), ("dcm", "命令"), ("dac", "动作"), ("dcy", "自定义"),
    ]
    trend_series = []
    for field, label in modes[:4]:
        pts = daily_points(DS.index, start, end, field, None, user_ids)
        pairs = pts.get("__total__", [])
        trend_series.append(series_point(field, label, pairs, "line"))

    model_map: dict[str, float] = {}
    for row in (r for d in date_range(start, end) for r in DS.index["by_day"].get(d, [])):
        if user_ids is not None and row["u"] not in user_ids:
            continue
        model_map[row["md"]] = model_map.get(row["md"], 0) + row["dc"]

    return {
        "summary": {"metrics": [
            metric_card("dialogCount", "对话次数", totals["dc"], prev.org["dc"], "次"),
            metric_card("dialogUsers", "对话用户数", totals["activeUserNum"], prev.org["activeUserNum"], "人"),
            metric_card("avgDialogPerUser", "人均对话次数",
                        round(totals["dc"] / max(totals["activeUserNum"], 1), 1),
                        round(prev.org["dc"] / max(prev.org["activeUserNum"], 1), 1), "次"),
            metric_card("sessionCount", "会话数", totals["sc"], prev.org["sc"], "个"),
            metric_card("avgSessionRounds", "平均会话轮次",
                        round(totals["dc"] / max(totals["sc"], 1), 2),
                        round(prev.org["dc"] / max(prev.org["sc"], 1), 2), "轮"),
        ]},
        "charts": {"charts": [
            {"key": "dialogByMode", "title": "对话能力分布", "type": "donut",
             "data": {"items": [{"label": label, "value": totals[field]} for field, label in modes]}},
            {"key": "dialogByModel", "title": "按模型对话次数", "type": "bar",
             "data": {"items": [{"label": k, "value": round(v)} for k, v in
                                sorted(model_map.items(), key=lambda x: -x[1])]}},
        ]},
        "trends": {"series": trend_series},
        "dimension": {"type": "taskScene", "label": "任务场景"},
    }


def analytics_completion(start: str, end: str, user_ids, dept_ids) -> dict:
    cur = DS.slice(start, end, user_ids, dept_ids)
    p_start, p_end = DS.previous_range(start, end)
    prev = DS.slice(p_start, p_end, user_ids, dept_ids)
    t, p = cur.org, prev.org

    lang_map: dict[str, dict[str, float]] = {}
    for row in (r for d in date_range(start, end) for r in DS.index["by_day"].get(d, [])):
        if user_ids is not None and row["u"] not in user_ids:
            continue
        bucket = lang_map.setdefault(row["lg"], {"cal": 0, "cgl": 0, "cg": 0, "ca": 0})
        bucket["cal"] += row["cal"]
        bucket["cgl"] += row["cgl"]
        bucket["cg"] += row["cg"]
        bucket["ca"] += row["ca"]

    return {
        "summary": {"metrics": [
            metric_card("completionGenerateCount", "补全生成次数", t["cg"], p["cg"], "次"),
            metric_card("completionAcceptCount", "补全采纳次数", t["ca"], p["ca"], "次"),
            metric_card("completionAcceptRateByCount", "采纳率（按次数）",
                        t["completionAcceptRateByCount"] or 0, p["completionAcceptRateByCount"] or 0, "%"),
            metric_card("completionAcceptRateByLines", "采纳率（按行数）",
                        t["completionAcceptRateByLines"] or 0, p["completionAcceptRateByLines"] or 0, "%"),
            metric_card("completionAcceptLines", "采纳行数", t["cal"], p["cal"], "行"),
        ]},
        "charts": {"charts": [
            {"key": "completionByLanguage", "title": "按语言采纳率（按行数）", "type": "bar",
             "data": {"items": [
                 {"label": lang,
                  "value": round(b["cal"] / b["cgl"] * 100, 2) if b["cgl"] else 0,
                  "extra": {"acceptLines": b["cal"], "genLines": b["cgl"]}}
                 for lang, b in sorted(lang_map.items(), key=lambda x: -x[1]["cal"])]}},
        ]},
        "trends": {"series": [
            series_point("completionAcceptLines", "采纳行数",
                         daily_points(DS.index, start, end, "cal", None, user_ids).get("__total__", []), "bar"),
            series_point("completionAcceptRateByLines", "采纳率",
                         [(d, round(cal / cgl * 100, 2) if cgl else 0) for d, cal, cgl in _pair_daily(
                             DS.index, start, end, "cal", "cgl", user_ids)], "line"),
        ]},
        "dimension": {"type": "language", "label": "编程语言"},
    }


def _pair_daily(index, start, end, num_field, den_field, user_ids):
    """按天返回 (日期, 分子, 分母)，用于比率型趋势线（先求和再相除）。"""
    from metrics import _iter_rows
    buckets: dict[str, list[float]] = {}
    for row in _iter_rows(index, start, end, user_ids):
        b = buckets.setdefault(row["d"], [0.0, 0.0])
        b[0] += row[num_field]
        b[1] += row[den_field]
    return [(d, v[0], v[1]) for d, v in sorted(buckets.items())]


def analytics_generation(start: str, end: str, user_ids, dept_ids) -> dict:
    cur = DS.slice(start, end, user_ids, dept_ids)
    p_start, p_end = DS.previous_range(start, end)
    prev = DS.slice(p_start, p_end, user_ids, dept_ids)
    t, p = cur.org, prev.org

    dept_bars = sorted(
        ({"label": v.get("departmentId") and DS.index["departments"].get(v["departmentId"], {}).get("departmentName", v["departmentId"]),
          "value": v["codeGenerateRateByLines"] or 0,
          "extra": {"aiLines": v["aiCodeLines"], "totalLines": v["totalNewCodeLines"], "credit": v["credit"]}}
         for v in cur.departments.values()),
        key=lambda x: -x["value"],
    )
    return {
        "summary": {"metrics": [
            metric_card("aiGenerateCodeLines", "AI 生成代码行数", t["aiCodeLines"], p["aiCodeLines"], "行"),
            metric_card("totalNewCodeLines", "新增代码总行数", t["totalNewCodeLines"], p["totalNewCodeLines"], "行"),
            metric_card("codeGenerateRateByLines", "AI 代码占比（按行数）",
                        t["codeGenerateRateByLines"] or 0, p["codeGenerateRateByLines"] or 0, "%"),
            metric_card("codeGenerateRateByChars", "AI 代码占比（按字符）",
                        t["codeGenerateRateByChars"] or 0, p["codeGenerateRateByChars"] or 0, "%"),
            metric_card("aiLinesPerActiveUser", "人均 AI 代码行数",
                        t["avgAiLinesPerActiveUser"], p["avgAiLinesPerActiveUser"], "行"),
        ]},
        "charts": {"charts": [
            {"key": "generateRateByDepartment", "title": "各部门 AI 代码占比", "type": "bar",
             "data": {"items": dept_bars}},
        ]},
        "trends": {"series": [
            series_point("totalNewCodeLines", "新增代码总行数",
                         daily_points(DS.index, start, end, "tnl", None, user_ids).get("__total__", []), "bar"),
            series_point("aiGenerateCodeLines", "AI 生成代码行数",
                         daily_points(DS.index, start, end, "ail", None, user_ids).get("__total__", []), "bar"),
            series_point("codeGenerateRateByLines", "AI 代码占比",
                         [(d, round(a / t2 * 100, 2) if t2 else 0) for d, a, t2 in _pair_daily(
                             DS.index, start, end, "ail", "tnl", user_ids)], "line"),
        ]},
        "dimension": {"type": "department", "label": "部门"},
    }


def member_data(payload: dict) -> dict:
    start, end = DS.resolve_range(
        (payload.get("timeRange") or {}).get("startTime"),
        (payload.get("timeRange") or {}).get("endTime"),
    )
    user_ids = _member_filter(payload)
    dept_ids = _department_filter(payload)
    cur = DS.slice(start, end, user_ids, dept_ids)
    p_start, p_end = DS.previous_range(start, end)
    prev = DS.slice(p_start, p_end, user_ids, dept_ids)

    member_options = payload.get("memberOptions") or {}
    keyword = (member_options.get("searchKeyword") or "").strip().lower()
    sort_by = member_options.get("sortBy") or "totalNewCodeLines"
    sort_order = member_options.get("sortOrder") or "desc"

    # 冷启动成员（窗口内无任何行为）也要出现在列表里，便于提醒与派发
    all_members = [
        m for m in DS.members
        if (user_ids is None or m["userId"] in user_ids)
        and (not dept_ids or m["primaryDepartmentId"] in dept_ids)
    ]
    rows: list[dict] = []
    for meta in all_members:
        uid = meta["userId"]
        cur_row = cur.members.get(uid)
        prev_row = prev.members.get(uid)
        if cur_row is None:
            cur_row = _zero_member(meta)
        row = dict(cur_row)
        row["previousCredit"] = prev_row["credit"] if prev_row else 0.0
        row["previousTotalNewCodeLines"] = prev_row["totalNewCodeLines"] if prev_row else 0
        row["creditGrowthRate"] = (
            round((row["credit"] - row["previousCredit"]) / row["previousCredit"] * 100, 2)
            if row["previousCredit"] else (0.0 if not row["credit"] else 100.0)
        )
        rows.append(row)

    if keyword:
        rows = [r for r in rows if keyword in (r["userName"] or "").lower()
                or keyword in (r["userNickname"] or "").lower()
                or keyword in (r["primaryDepartmentName"] or "").lower()]

    def sort_key(row: dict):
        value = row.get(sort_by)
        if value is None:
            return float("-inf") if sort_order == "desc" else float("inf")
        return value

    rows.sort(key=sort_key, reverse=(sort_order == "desc"))

    pagination = payload.get("pagination") or {}
    page = max(1, int(pagination.get("page") or 1))
    page_size = max(1, min(200, int(pagination.get("pageSize") or 20)))
    total = len(rows)
    start_index = (page - 1) * page_size
    page_rows = rows[start_index:start_index + page_size]

    return {
        "members": [_to_doc_member(r) for r in page_rows],
        "pagination": {
            "page": page, "pageSize": page_size, "total": total,
            "totalPage": max(1, (total + page_size - 1) // page_size),
        },
        "range": {"start": start, "end": end},
        "orgSummary": {
            "credit": cur.org["credit"],
            "previousCredit": prev.org["credit"],
            "aiCodeLines": cur.org["aiCodeLines"],
            "totalNewCodeLines": cur.org["totalNewCodeLines"],
            "codeGenerateRateByLines": cur.org["codeGenerateRateByLines"],
            "activeUserNum": cur.org["activeUserNum"],
        },
    }


def _zero_member(meta: dict) -> dict:
    return {
        "userId": meta["userId"], "userName": meta["userName"], "userNickname": meta["userNickname"],
        "primaryDepartmentId": meta["primaryDepartmentId"],
        "primaryDepartmentName": meta["primaryDepartmentName"],
        "departmentFullPaths": meta.get("departmentFullPaths", []),
        "activeDays": 0, "lastActiveTime": None,
        "credit": 0.0, "aiCodeLines": 0, "totalNewCodeLines": 0,
        "completionGenerateCount": 0, "completionAcceptCount": 0,
        "completionGenerateLines": 0, "completionAcceptLines": 0,
        "completionGenerateChars": 0, "completionAcceptChars": 0,
        "aiGenerateCodeChars": 0, "totalNewCodeChars": 0,
        "dialogCount": 0, "sessionCount": 0, "requestCount": 0,
        "inputTokens": 0, "outputTokens": 0, "tokenUsage": 0,
        "completionAcceptRateByCount": 0.0, "completionAcceptRateByLines": 0.0,
        "completionAcceptRateByChars": 0.0, "codeGenerateRateByLines": 0.0,
        "codeGenerateRateByChars": 0.0,
        "cycleLimit": meta.get("cycleLimit"), "cycleLimitDisplay": meta.get("cycleLimitDisplay"),
        "quotaUsageRate": None, "creditsPerKline": None, "aiLinesPerActiveDay": 0,
    }


def _to_doc_member(row: dict) -> dict:
    """输出字段名与 document.yaml L1785-L1923 对齐，额外字段以 __ 前缀标注为本方案扩展。"""
    return {
        "memberId": row["userId"],
        "memberName": row["userName"],
        "userNickname": row["userNickname"],
        "lastActiveTime": row["lastActiveTime"],
        "departmentIds": [row["primaryDepartmentId"]],
        "departmentNames": [row["primaryDepartmentName"]],
        "departmentFullPaths": row.get("departmentFullPaths", []),
        "primaryDepartmentId": row["primaryDepartmentId"],
        "primaryDepartmentName": row["primaryDepartmentName"],
        "activeDays": row["activeDays"],
        "dialogCount": row["dialogCount"],
        "completionGenerateCount": row["completionGenerateCount"],
        "completionAcceptCount": row["completionAcceptCount"],
        "completionAcceptRateByCount": row["completionAcceptRateByCount"] or 0,
        "completionGenerateLines": row["completionGenerateLines"],
        "completionAcceptLines": row["completionAcceptLines"],
        "completionAcceptRateByLines": row["completionAcceptRateByLines"] or 0,
        "completionGenerateChars": row["completionGenerateChars"],
        "completionAcceptChars": row["completionAcceptChars"],
        "completionAcceptRateByChars": row["completionAcceptRateByChars"] or 0,
        "aiGenerateCodeLines": row["aiCodeLines"],
        "totalNewCodeLines": row["totalNewCodeLines"],
        "codeGenerateRateByLines": row["codeGenerateRateByLines"] or 0,
        "aiGenerateCodeChars": row["aiGenerateCodeChars"],
        "totalNewCodeChars": row["totalNewCodeChars"],
        "codeGenerateRateByChars": row["codeGenerateRateByChars"] or 0,
        "totalUsed": row["credit"],
        "cycleLimit": row["cycleLimit"],
        "cycleLimitDisplay": row["cycleLimitDisplay"],
        # —— 本方案扩展字段（前端效能分析使用）——
        "__credit": row["credit"],
        "__previousCredit": row["previousCredit"],
        "__creditGrowthRate": row["creditGrowthRate"],
        "__previousTotalNewCodeLines": row["previousTotalNewCodeLines"],
        "__sessionCount": row["sessionCount"],
        "__requestCount": row["requestCount"],
        "__tokenUsage": row["tokenUsage"],
        "__inputTokens": row["inputTokens"],
        "__outputTokens": row["outputTokens"],
        "__quotaUsageRate": row["quotaUsageRate"],
        "__creditsPerKline": row["creditsPerKline"],
        "__aiLinesPerActiveDay": row["aiLinesPerActiveDay"],
    }


# --------------------------------------------------------------------------
# 本方案扩展：部门级效能总览（首屏一次拿齐，避免 N+1 请求）
# --------------------------------------------------------------------------
def efficiency_overview(payload: dict) -> dict:
    start, end = DS.resolve_range(
        (payload.get("timeRange") or {}).get("startTime"),
        (payload.get("timeRange") or {}).get("endTime"),
    )
    p_start, p_end = DS.previous_range(start, end)
    user_ids = _member_filter(payload)
    dept_ids = _department_filter(payload)
    cur = DS.slice(start, end, user_ids, dept_ids)
    prev = DS.slice(p_start, p_end, user_ids, dept_ids)

    total_seats = next(
        (i["total"] for i in DS.dataset["resources"]["items"] if i["resourceType"] == "license"),
        len(DS.members),
    )
    used_seats = next(
        (i["used"] for i in DS.dataset["resources"]["items"] if i["resourceType"] == "license"),
        len(DS.members),
    )

    departments = []
    for dept_id, v in sorted(cur.departments.items(),
                             key=lambda kv: -kv[1]["credit"]):
        pv = prev.departments.get(dept_id, {})
        meta = DS.index["departments"].get(dept_id, {})
        departments.append({
            "departmentId": dept_id,
            "departmentName": meta.get("departmentName", dept_id),
            "fullPath": meta.get("fullPath", ""),
            "memberCount": v["memberCount"],
            "activeUserNum": v["activeUserNum"],
            "activeRate": v["activeRate"],
            "credit": v["credit"],
            "previousCredit": pv.get("credit", 0.0),
            "creditGrowthRate": (
                round((v["credit"] - pv.get("credit", 0)) / pv["credit"] * 100, 2)
                if pv.get("credit") else (0.0 if not v["credit"] else 100.0)
            ),
            "creditShare": round(v["credit"] / cur.org["credit"] * 100, 2) if cur.org["credit"] else 0,
            "avgCreditPerUser": v["avgCreditsPerActiveUser"],
            "dialogCount": v["dialogCount"],
            "sessionCount": v["sessionCount"],
            "requestCount": v["requestCount"],
            "tokenUsage": v["tokenUsage"],
            "aiCodeLines": v["aiCodeLines"],
            "totalNewCodeLines": v["totalNewCodeLines"],
            "aiCodeRate": v["codeGenerateRateByLines"],
            "acceptRateByLines": v["completionAcceptRateByLines"],
            "creditsPerKline": v["creditsPerKline"],
            "aiLinesPerActiveUser": v["avgAiLinesPerActiveUser"],
            "requestErrorRate": v["requestErrorRate"],
            "toolErrorRate": v["toolErrorRate"],
        })

    # 日级趋势：消耗 / 代码量 / AI 占比 / 活跃人数
    credit_by_day = dict(daily_points(DS.index, start, end, "cr", None, user_ids).get("__total__", []))
    lines_by_day = dict(daily_points(DS.index, start, end, "tnl", None, user_ids).get("__total__", []))
    ai_by_day = dict(daily_points(DS.index, start, end, "ail", None, user_ids).get("__total__", []))
    active_by_day: dict[str, set] = {}
    for day in date_range(start, end):
        for row in DS.index["by_day"].get(day, []):
            if user_ids is not None and row["u"] not in user_ids:
                continue
            dept = DS.index["dept_of"].get(row["u"])
            if dept_ids and dept not in dept_ids:
                continue
            active_by_day.setdefault(day, set()).add(row["u"])

    days = date_range(start, end)
    trend = [{
        "date": d,
        "credit": round(credit_by_day.get(d, 0.0), 2),
        "totalNewCodeLines": lines_by_day.get(d, 0),
        "aiCodeLines": ai_by_day.get(d, 0),
        "aiCodeRate": round(ai_by_day.get(d, 0) / lines_by_day[d] * 100, 2) if lines_by_day.get(d) else 0,
        "activeUserNum": len(active_by_day.get(d, ())),
    } for d in days]

    return {
        "range": {"start": start, "end": end, "previousStart": p_start, "previousEnd": p_end,
                  "days": len(days)},
        "org": {
            **{k: cur.org[k] for k in (
                "credit", "dialogCount", "sessionCount", "requestCount", "tokenUsage",
                "inputTokens", "outputTokens", "cacheReadInputTokens", "toolCallCount",
                "aiCodeLines", "totalNewCodeLines", "codeGenerateRateByLines",
                "codeGenerateRateByChars", "completionAcceptRateByLines",
                "completionAcceptRateByCount", "completionGenerateCount", "completionAcceptCount",
                "completionAcceptLines", "activeUserNum", "dau", "requestErrorRate", "toolErrorRate",
                "avgCreditsPerActiveUser", "avgAiLinesPerActiveUser",
            )},
            "previous": {
                k: prev.org.get(k) for k in (
                    "credit", "dialogCount", "aiCodeLines", "totalNewCodeLines",
                    "codeGenerateRateByLines", "activeUserNum", "tokenUsage",
                )
            },
            "memberCount": len(DS.members),
            "seatTotal": total_seats,
            "seatUsed": used_seats,
            "resourceItems": DS.dataset["resources"]["items"],
            "quotaCycle": DS.dataset["quotaCycle"],
        },
        "departments": departments,
        "trend": trend,
    }


# --------------------------------------------------------------------------
# 可观测域
# --------------------------------------------------------------------------
def metric_summary(payload: dict) -> dict:
    metrics = payload.get("metrics") or []
    if not metrics:
        raise ValueError("metrics 必填")
    if len(metrics) > 20:
        raise ValueError("metrics 最多 20 个")
    unknown = [m for m in metrics if m not in METRIC_WHITELIST]
    if unknown:
        raise ValueError(f"指标名不在白名单: {','.join(unknown)}")

    rng = payload.get("range") or {}
    start = datetime.fromtimestamp(int(rng.get("start", 0)), TZ).date().isoformat()
    end = datetime.fromtimestamp(int(rng.get("end", 0)), TZ).date().isoformat()
    cur = DS.slice(start, end, {payload["userId"]} if payload.get("userId") else None)
    p_start, p_end = DS.previous_range(start, end)
    prev = DS.slice(p_start, p_end, {payload["userId"]} if payload.get("userId") else None)

    fields = []
    for name in metrics:
        _, unit = METRIC_WHITELIST[name]
        current, _ = _metric(name, cur)
        previous, _ = _metric(name, prev)
        fields.append({
            "key": name, "value": round(current, 2), "unit": unit,
            "momRate": (round((current - previous) / previous, 4)
                        if previous else (None if not current else 1.0)),
            "compareValue": round(previous, 2),
        })
    return {"fields": fields, "range": {"start": start, "end": end}}


def _metric(name: str, slice_obj) -> tuple[float, str]:
    field_name, unit = METRIC_WHITELIST[name]
    org = slice_obj.org
    derived = {
        "__tool_error_rate__": org.get("toolErrorRate") or 0.0,
        "__token_usage__": org.get("tokenUsage", 0),
        "__user_count__": org.get("activeUserNum", 0),
        "__dau__": org.get("dau", 0),
        "__accept_line_rate__": org.get("completionAcceptRateByLines") or 0.0,
        "__gen_line_rate__": org.get("codeGenerateRateByLines") or 0.0,
    }
    if field_name in derived:
        return float(derived[field_name]), unit
    return float(org.get(field_name, 0)), unit


def metric_trend(payload: dict) -> dict:
    metrics = payload.get("metrics") or []
    unknown = [m for m in metrics if m not in METRIC_WHITELIST]
    if unknown:
        raise ValueError(f"指标名不在白名单: {','.join(unknown)}")
    group_by = payload.get("groupBy")
    if group_by == "department":
        # 说明：真实企业接口 groupBy 不支持 department（应用身份无组织语义，返回 400）。
        #      Mock 阶段直接返回部门维度，真实接入时由本方案后端用成员级数据自行 rollup。
        pass
    rng = payload.get("range") or {}
    start = datetime.fromtimestamp(int(rng.get("start", 0)), TZ).date().isoformat()
    end = datetime.fromtimestamp(int(rng.get("end", 0)), TZ).date().isoformat()

    lines = []
    for name in metrics:
        field_name, unit = METRIC_WHITELIST[name]
        if group_by and group_by in ROW_DIM_FIELD:
            source = ROW_DIM_FIELD[group_by]
            buckets: dict[str, dict[str, float]] = {}
            for day in date_range(start, end):
                for row in DS.index["by_day"].get(day, []):
                    key = row[source]
                    buckets.setdefault(key, {}).setdefault(day, 0.0)
                    buckets[key][day] += float(row[field_name])
            for key, day_map in buckets.items():
                lines.append({
                    "metric": name,
                    "group": key,
                    "unit": unit,
                    "points": [{"time": int(datetime.fromisoformat(d).replace(tzinfo=TZ).timestamp()),
                                "value": round(v, 2)} for d, v in sorted(day_map.items())],
                })
        else:
            pairs = daily_points(DS.index, start, end, field_name, group_by, None)
            for key, points in pairs.items():
                label = key
                if group_by == "department" and key in DS.index["departments"]:
                    label = DS.index["departments"][key]["departmentName"]
                lines.append({
                    "metric": name, "group": label, "unit": unit,
                    "points": [{"time": int(datetime.fromisoformat(d).replace(tzinfo=TZ).timestamp()),
                                "value": round(v, 2)} for d, v in points],
                })

    days = len(date_range(start, end))
    return {
        "bucketSeconds": bucket_seconds_for(days),
        "granularity": payload.get("granularity", "auto"),
        "groupBy": group_by,
        "lines": lines,
        "range": {"start": start, "end": end},
    }


def metric_records(payload: dict) -> dict:
    metrics = payload.get("metrics") or []
    unknown = [m for m in metrics if m not in METRIC_WHITELIST]
    if unknown:
        raise ValueError(f"指标名不在白名单: {','.join(unknown)}")
    rng = payload.get("range") or {}
    start = datetime.fromtimestamp(int(rng.get("start", 0)), TZ).date().isoformat()
    end = datetime.fromtimestamp(int(rng.get("end", 0)), TZ).date().isoformat()

    records = []
    for day in date_range(start, end):
        for row in DS.index["by_day"].get(day, []):
            if payload.get("userId") and row["u"] != payload["userId"]:
                continue
            meta = DS.index["members"].get(row["u"], {})
            values = {}
            for name in metrics:
                field_name, _ = METRIC_WHITELIST[name]
                values[name] = row.get(field_name) if not field_name.startswith("__") else None
            records.append({
                "timestamp": int(datetime.fromisoformat(day).replace(tzinfo=TZ).timestamp()),
                "date": day,
                "userId": row["u"],
                "userName": meta.get("userName"),
                "departmentName": meta.get("primaryDepartmentName"),
                "model": row["md"], "client": row["cl"], "pluginVersion": row["pv"],
                "language": row["lg"],
                "metrics": values,
            })
    records.sort(key=lambda r: (r["timestamp"], r["userName"] or ""), reverse=True)
    total = len(records)
    page_size = int(payload.get("pageSize") or 50)
    page = max(1, int(payload.get("pageNum") or 1))
    return {
        "total": total, "pageNum": page, "pageSize": page_size,
        "records": records[(page - 1) * page_size: page * page_size],
        "range": {"start": start, "end": end},
    }


# --------------------------------------------------------------------------
# 路由
# --------------------------------------------------------------------------
def route(method: str, path: str, query: dict, body: dict):
    parts = [p for p in path.split("/") if p]
    if parts and parts[0] == "api":
        parts = parts[1:]

    # /enterprises/{eid}/...
    if len(parts) >= 2 and parts[0] == "enterprises":
        eid = parts[1]
        if eid != DS.enterprise_id:
            return 403, err(40301, f"企业不存在或无权访问: {eid}")
        rest = parts[2:]
        return route_enterprise(method, rest, query, body)

    if parts[:2] == ["v1", "efficiency"]:
        tail = parts[2:]
        if method == "GET" and tail[:1] == ["overview"]:
            return 200, ok(efficiency_overview({"timeRange": _q_range(query),
                                                 "departmentIds": _q_list(query, "departmentIds"),
                                                 "memberFilter": _q_member_filter(query)}))
        if method == "GET" and tail[:1] == ["members"]:
            payload = {
                "timeRange": _q_range(query),
                "departmentIds": _q_list(query, "departmentIds"),
                "memberFilter": _q_member_filter(query),
                "pagination": {"page": int(query.get("page", ["1"])[0]),
                               "pageSize": int(query.get("pageSize", ["20"])[0])},
                "memberOptions": {"sortBy": query.get("sortBy", ["totalNewCodeLines"])[0],
                                  "sortOrder": query.get("sortOrder", ["desc"])[0],
                                  "searchKeyword": query.get("keyword", [""])[0]},
            }
            return 200, ok(member_data(payload))
        if method == "GET" and tail[:1] == ["member"] and len(tail) >= 2:
            return member_detail(tail[1], _q_range(query))
        if method == "GET" and tail[:1] == ["departments"]:
            return 200, ok(DS.dataset["departments"])
        if method == "GET" and tail[:1] == ["quota"]:
            return 200, ok(quota_list(query))
        if method == "GET" and tail[:1] == ["meta"]:
            return 200, ok({
                "meta": DS.dataset["meta"],
                "quotaCycle": DS.dataset["quotaCycle"],
                "defaultQuota": DS.default_quota,
                "audit": DS.audit[-20:],
            })
    return 404, err(40400, f"未实现的接口: {method} {path}")


def quota_list(query: dict) -> dict:
    """额度视图：把「周期限量」与「窗口内实际消耗」放在一起，供额度管理页使用。"""
    start, end = DS.resolve_range(query.get("startTime", [None])[0], query.get("endTime", [None])[0])
    keyword = query.get("keyword", [""])[0].strip().lower()
    dept_ids = set(_q_list(query, "departmentIds"))
    cur = DS.slice(start, end, None, dept_ids or None)
    items = []
    for m in DS.members:
        if dept_ids and m["primaryDepartmentId"] not in dept_ids:
            continue
        if keyword and keyword not in m["userName"].lower() \
                and keyword not in m["primaryDepartmentName"].lower():
            continue
        used = cur.members.get(m["userId"], {}).get("credit", 0.0)
        limit = m.get("cycleLimit")
        rate = round(used / limit * 100, 2) if limit else None
        items.append({
            "userId": m["userId"], "userName": m["userName"],
            "departmentName": m["primaryDepartmentName"],
            "departmentId": m["primaryDepartmentId"],
            "cycleLimit": limit,
            "cycleLimitDisplay": m.get("cycleLimitDisplay", "不限量"),
            "totalUsed": round(used, 2),
            "__quotaUsageRate": rate,
            "riskLevel": ("unlimited" if rate is None
                          else "high" if rate >= 90
                          else "medium" if rate >= 70 else "low"),
        })
    items.sort(key=lambda x: (-(x["__quotaUsageRate"] or -1), -x["totalUsed"]))
    page = max(1, int(query.get("page", ["1"])[0]))
    size = max(1, min(500, int(query.get("pageSize", ["200"])[0])))
    return {
        "items": items[(page - 1) * size: page * size],
        "totalCount": len(items),
        "range": {"start": start, "end": end},
    }


def member_detail(member_id: str, time_range: dict) -> tuple[int, dict]:
    meta = DS.member_by_id.get(member_id) or DS.member_by_name.get(member_id)
    if not meta:
        return 404, err(40401, f"成员不存在: {member_id}")
    start, end = DS.resolve_range(time_range.get("startTime"), time_range.get("endTime"))
    p_start, p_end = DS.previous_range(start, end)
    uid = meta["userId"]
    cur = DS.slice(start, end, {uid})
    prev = DS.slice(p_start, p_end, {uid})
    row = cur.members.get(uid) or _zero_member(meta)
    days = date_range(start, end)
    detail_trend = []
    by_day_rows = {d: r for d in days for r in DS.index["by_day"].get(d, []) if r["u"] == uid}
    for d in days:
        r = by_day_rows.get(d)
        detail_trend.append({
            "date": d,
            "credit": round(r["cr"], 2) if r else 0,
            "aiCodeLines": r["ail"] if r else 0,
            "totalNewCodeLines": r["tnl"] if r else 0,
            "aiCodeRate": round(r["ail"] / r["tnl"] * 100, 2) if r and r["tnl"] else 0,
            "dialogCount": r["dc"] if r else 0,
            "completionAcceptLines": r["cal"] if r else 0,
            "acceptRateByLines": round(r["cal"] / r["cgl"] * 100, 2) if r and r["cgl"] else 0,
            "tokenUsage": (r["it"] + r["ot"]) if r else 0,
        })
    model_mix: dict[str, dict] = {}
    client_mix: dict[str, dict] = {}
    lang_mix: dict[str, dict] = {}
    for d in days:
        for r in DS.index["by_day"].get(d, []):
            if r["u"] != uid:
                continue
            for store, key in ((model_mix, r["md"]), (client_mix, r["cl"]), (lang_mix, r["lg"])):
                b = store.setdefault(key, {"credit": 0.0, "dialogCount": 0, "aiCodeLines": 0})
                b["credit"] += r["cr"]
                b["dialogCount"] += r["dc"]
                b["aiCodeLines"] += r["ail"]
    def to_items(store, total_credit):
        return sorted(
            ({"label": k, "value": round(v["credit"], 2),
              "extra": {"dialogCount": v["dialogCount"], "aiCodeLines": v["aiCodeLines"],
                        "share": round(v["credit"] / total_credit * 100, 2) if total_credit else 0}}
             for k, v in store.items()),
            key=lambda x: -x["value"],
        )
    total_credit = sum(v["credit"] for v in model_mix.values()) or 1.0
    return 200, ok({
        "member": _to_doc_member({
            **dict(row),
            "previousCredit": prev.members.get(uid, {}).get("credit", 0.0),
            "previousTotalNewCodeLines": prev.members.get(uid, {}).get("totalNewCodeLines", 0),
            "creditGrowthRate": (
                round((row["credit"] - prev.members.get(uid, {}).get("credit", 0))
                      / prev.members.get(uid, {}).get("credit", 1) * 100, 2)
                if prev.members.get(uid, {}).get("credit") else 0.0),
        }),
        "profile": {
            "email": meta.get("email"),
            "joinedAt": meta.get("joinedAt"),
            "departmentFullPaths": meta.get("departmentFullPaths", []),
            "cycleLimit": meta.get("cycleLimit"),
            "cycleLimitDisplay": meta.get("cycleLimitDisplay"),
            "primaryLanguage": meta.get("_lang"),
        },
        "range": {"start": start, "end": end, "previousStart": p_start, "previousEnd": p_end},
        "trend": detail_trend,
        "modelMix": to_items(model_mix, total_credit),
        "clientMix": to_items(client_mix, total_credit),
        "languageMix": to_items(lang_mix, total_credit),
    })


def route_enterprise(method: str, rest: list[str], query: dict, body: dict):
    # —— 基础信息 / 成员 / 部门 ——
    if method == "GET" and rest == ["info"]:
        return 200, ok({
            "enterpriseId": DS.enterprise_id,
            "enterpriseName": DS.dataset["meta"]["enterpriseName"],
            "memberCount": len(DS.members),
            "departmentCount": len(DS.dataset["departments"]) - 1,
        })
    if method == "GET" and rest == ["openapi", "members"]:
        page = int(query.get("pageNum", ["1"])[0])
        size = min(200, int(query.get("pageSize", ["20"])[0]))
        keyword = query.get("keyword", [""])[0].lower()
        items = DS.members
        if keyword:
            items = [m for m in items if keyword in m["userName"].lower() or keyword in (m["email"] or "").lower()]
        total = len(items)
        page_items = items[(page - 1) * size: page * size]
        return 200, ok({
            "items": [{
                "userId": m["userId"], "userName": m["userName"], "email": m["email"],
                "departmentIds": m["departmentIds"], "departmentName": m["primaryDepartmentName"],
                "joinedAt": m["joinedAt"], "enabled": True,
            } for m in page_items],
            "totalCount": total, "pageNum": page, "pageSize": size,
        })
    if method == "GET" and rest == ["openapi", "departments"]:
        return 200, ok({"items": DS.dataset["departments"], "totalCount": len(DS.dataset["departments"])})

    # —— 用量域 ——
    if method == "GET" and rest == ["openapi", "usage", "quota-cycle"]:
        return 200, ok(DS.dataset["quotaCycle"])
    if method == "GET" and rest == ["openapi", "usage", "default-quota"]:
        return 200, ok(DS.default_quota)
    if method == "POST" and rest == ["openapi", "usage", "default-quota", "update"]:
        limit_type = body.get("limitType")
        if limit_type not in ("limited", "unlimited"):
            return 400, err(40001, "limitType 必须为 limited 或 unlimited")
        if limit_type == "limited":
            new_limit = body.get("newLimit")
            if not isinstance(new_limit, int) or not 1 <= new_limit <= 999999999:
                return 400, err(40001, "newLimit 取值范围 1 ~ 999999999")
            DS.default_quota["cycleLimit"] = new_limit
        else:
            DS.default_quota["cycleLimit"] = -1
        affected = sum(1 for m in DS.members if m.get("cycleLimit") is None)
        DS.audit.append({"at": datetime.now(TZ).isoformat(), "action": "default-quota",
                         "limitType": limit_type, "newLimit": body.get("newLimit"),
                         "affectedCount": affected})
        return 200, ok({"affectedCount": affected})

    if method == "POST" and rest == ["openapi", "usage", "members", "query"]:
        user_ids = set(body.get("userIds") or [])
        user_names = set(body.get("userNames") or [])
        if not user_ids and not user_names:
            return 400, err(40001, "userIds 与 userNames 至少提供一个")
        targets = [m for m in DS.members if m["userId"] in user_ids or m["userName"] in user_names]
        start, end = DS.resolve_range(body.get("startTime"), body.get("endTime"))
        cur = DS.slice(start, end, {m["userId"] for m in targets})
        page = max(1, int(body.get("pageNum") or 1))
        size = max(1, min(500, int(body.get("pageSize") or 20)))
        items = []
        for m in targets:
            row = cur.members.get(m["userId"])
            used = row["credit"] if row else 0.0
            limit = m.get("cycleLimit")
            items.append({
                "userId": m["userId"], "userName": m["userName"],
                "cycleLimit": limit,
                "cycleLimitDisplay": m.get("cycleLimitDisplay", "不限量"),
                "totalUsed": round(used, 2),
                "__quotaUsageRate": round(used / limit * 100, 2) if limit else None,
            })
        items.sort(key=lambda x: -x["totalUsed"])
        invalid_names = [n for n in user_names if n not in DS.member_by_name]
        invalid_ids = [i for i in user_ids if i not in DS.member_by_id]
        return 200, ok({
            "items": items[(page - 1) * size: page * size],
            "totalCount": len(items), "pageNum": page, "pageSize": size,
            "invalidUserIds": invalid_ids, "invalidUserNames": invalid_names,
            "range": {"start": start, "end": end},
        })

    if method == "POST" and rest == ["openapi", "usage", "members", "limit-query"]:
        user_ids = set(body.get("userIds") or [])
        user_names = set(body.get("userNames") or [])
        targets = [m for m in DS.members if m["userId"] in user_ids or m["userName"] in user_names]
        return 200, ok({
            "items": [{
                "userId": m["userId"], "userName": m["userName"],
                "cycleLimit": m.get("cycleLimit"),
                "cycleLimitDisplay": m.get("cycleLimitDisplay", "不限量"),
                "operator": "mock-admin", "operatedAt": DS.dataset["meta"]["generatedAt"],
            } for m in targets],
            "totalCount": len(targets),
        })

    if method == "POST" and rest == ["openapi", "usage", "members", "quota", "update"]:
        return _apply_quota_update(body, targets=[
            m for m in DS.members
            if m["userId"] in set(body.get("userIds") or [])
            or m["userName"] in set(body.get("userNames") or [])
        ], scope="members")

    # 路径: /openapi/usage/departments/{departmentId}/quota/update
    if (method == "POST" and len(rest) == 6
            and rest[:3] == ["openapi", "usage", "departments"]
            and rest[4:] == ["quota", "update"]):
        dept_id = rest[3]
        targets = [m for m in DS.members if m["primaryDepartmentId"] == dept_id]
        return _apply_quota_update(body, targets=targets, scope="department", dept_id=dept_id)

    if method == "GET" and rest == ["openapi", "resources", "overview"]:
        return 200, ok(DS.dataset["resources"])

    # —— Dashboard 域 ——
    if method == "POST" and rest[:2] == ["dashboard", "member"] and rest[2:3] == ["data"]:
        return 200, ok(member_data(body))
    if method == "POST" and rest[:2] == ["dashboard", "analytics"] and len(rest) == 3:
        kind = rest[2]
        tr = body.get("timeRange") or {}
        start, end = DS.resolve_range(tr.get("startTime"), tr.get("endTime"))
        user_ids = _member_filter(body)
        dept_ids = _department_filter(body)
        handlers = {
            "activity": analytics_activity,
            "dialog": analytics_dialog,
            "completion": analytics_completion,
            "generation": analytics_generation,
        }
        if kind not in handlers:
            return 404, err(40400, f"未知分析类型: {kind}")
        return 200, ok(handlers[kind](start, end, user_ids, dept_ids))

    # —— 监控指标 v1（旧看板）——
    if method == "GET" and rest == ["metrics"]:
        queries = [q for q in query.get("queries", [""])[0].split(",") if q]
        start_raw = query.get("range.start", [""])[0]
        end_raw = query.get("range.end", [""])[0]
        step = int(query.get("range.step", ["86400"])[0])
        field_of = {
            "activeUserNum": "__active__", "completionActiveUserNum": "__comp_active__",
            "chatActiveUserNum": "__chat_active__", "chatNum": "dc",
            "completionAcceptNum": "ca", "completionAcceptLineNum": "cal",
            "completionAcceptCharacterNum": "cac", "lineIncreaseNum": "tnl",
            "characterIncreaseNum": "tnc", "completionNum": "cg",
            "completionLineNum": "cgl", "completionCharacterNum": "cgc",
            "completionAcceptRate": "__accept_rate__",
            "completionAcceptLineRate": "__accept_line_rate__",
            "completionAcceptCharacterRate": "__accept_char_rate__",
            "completionGenerateLineRate": "__gen_line_rate__",
            "completionGenerateCharacterRate": "__gen_char_rate__",
        }
        unknown = [q for q in queries if q not in field_of]
        if unknown:
            return 400, err(40001, f"不支持的指标: {','.join(unknown)}")
        if not start_raw or not end_raw:
            return 400, err(40001, "range.start 与 range.end 必填")
        start = start_raw[:10]
        end = end_raw[:10]
        cur = DS.slice(start, end)
        data: dict[str, list] = {}
        for q in queries:
            field_name = field_of[q]
            if field_name.startswith("__"):
                data[q] = [[], []]
                continue
            pairs = daily_points(DS.index, start, end, field_name, None, None).get("__total__", [])
            points = pairs if step >= 86400 else _resample(pairs, step)
            data[q] = [
                [int(datetime.fromisoformat(d).replace(tzinfo=TZ).timestamp() * 1000) for d, _ in points],
                [round(v, 4) for _, v in points],
            ]
        data.setdefault("activeUserNum", [])
        if "activeUserNum" in queries:
            active = []
            for d, v in daily_points(DS.index, start, end, "cr", None, None).get("__total__", []):
                users = {r["u"] for r in DS.index["by_day"].get(d, [])}
                active.append((d, len(users)))
            data["activeUserNum"] = [
                [int(datetime.fromisoformat(d).replace(tzinfo=TZ).timestamp() * 1000) for d, _ in active],
                [v for _, v in active],
            ]
        derived_rates = {
            "completionAcceptRate": "completionAcceptRateByCount",
            "completionAcceptLineRate": "completionAcceptRateByLines",
            "completionAcceptCharacterRate": "completionAcceptRateByChars",
            "completionGenerateLineRate": "codeGenerateRateByLines",
            "completionGenerateCharacterRate": "codeGenerateRateByChars",
        }
        for q, org_key in derived_rates.items():
            if q in queries:
                data[q] = [[int(datetime.fromisoformat(end).replace(tzinfo=TZ).timestamp() * 1000)],
                           [cur.org.get(org_key) or 0]]
        return 200, ok(data)

    # —— 可观测域 ——
    if method == "POST" and rest == ["openapi", "observability", "metric-summary", "query"]:
        try:
            return 200, ok(metric_summary(body))
        except ValueError as exc:
            return 400, err(40001, str(exc))
    if method == "POST" and rest == ["openapi", "observability", "metric-trend", "query"]:
        try:
            return 200, ok(metric_trend(body))
        except ValueError as exc:
            return 400, err(40001, str(exc))
    if method == "POST" and rest == ["openapi", "observability", "metric-records", "query"]:
        try:
            return 200, ok(metric_records(body))
        except ValueError as exc:
            return 400, err(40001, str(exc))

    return 404, err(40400, f"未实现的接口: {method} /{'/'.join(rest)}")


def _resample(pairs, step_seconds: int):
    """把日粒度降级为更小的步长（mock 场景下做插值，仅用于兼容 range.step 语义）。"""
    out = []
    for d, v in pairs:
        base = datetime.fromisoformat(d).replace(tzinfo=TZ)
        for offset in range(0, 86400, step_seconds):
            out.append(((base + timedelta(seconds=offset)).isoformat(), v / max(1, 86400 // step_seconds)))
    return out


def _apply_quota_update(body: dict, targets: list[dict], scope: str, dept_id: str | None = None):
    limit_type = body.get("limitType")
    if limit_type not in ("limited", "unlimited"):
        return 400, err(40001, "limitType 必须为 limited 或 unlimited")
    new_limit = body.get("newLimit")
    if limit_type == "limited" and (not isinstance(new_limit, int) or not 1 <= new_limit <= 999999999):
        return 400, err(40001, "newLimit 取值范围 1 ~ 999999999")
    for m in targets:
        if limit_type == "limited":
            m["cycleLimit"] = new_limit
            m["cycleLimitDisplay"] = str(new_limit)
        else:
            m["cycleLimit"] = None
            m["cycleLimitDisplay"] = "不限量"
    DS.audit.append({"at": datetime.now(TZ).isoformat(), "action": f"{scope}-quota",
                     "departmentId": dept_id, "limitType": limit_type, "newLimit": new_limit,
                     "affectedCount": len(targets)})
    return 200, ok({"affectedCount": len(targets)})


def _q_range(query: dict) -> dict:
    return {"startTime": query.get("startTime", [None])[0],
            "endTime": query.get("endTime", [None])[0]}


def _q_list(query: dict, key: str):
    raw = query.get(key, [""])[0]
    return [item for item in raw.split(",") if item]


def _q_member_filter(query: dict) -> dict:
    ids = _q_list(query, "userIds")
    return {"type": "selected", "data": ids} if ids else {"type": "all"}


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    """API + 前端构建产物（frontend/dist）同源托管。"""

    server_version = "AIEfficiencyConsole/1.0"

    def log_message(self, fmt, *args):  # 降噪
        if os.environ.get("AEC_VERBOSE"):
            super().log_message(fmt, *args)

    # —— CORS ——
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Enterprise-Id")
        self.send_header("Cache-Control", "no-store")

    def _json(self, status: int, payload) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/healthz":
            return self._json(200, ok({"status": "ok", "dataset": DS.dataset["meta"]}))
        # "/" 与 "/index.html" 属于静态入口，交由 _static_or_api 处理；
        # 仅当未构建前端时，才在静态处理器里返回接口清单提示。
        try:
            body = self._read_body() if method in ("POST", "PUT") else {}
            status, payload = route(method, path, query, body)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            status, payload = 500, err(50000, f"服务端异常: {exc}")
        self._json(status, payload)

    def do_GET(self):
        self._static_or_api("GET")

    def do_POST(self):
        self._static_or_api("POST")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _static_or_api(self, method: str) -> None:
        """只有 /api/** 与 /healthz 走接口路由，其余一律按静态资源处理（含 SPA 回退）。"""
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/") or path == "/healthz":
            return self._dispatch(method)
        if method != "GET":
            return self._json(405, err(40500, f"{method} 不支持该路径: {path}"))
        self._serve_static(path)

    def _serve_static(self, path: str) -> None:
        index_file = DIST_DIR / "index.html"
        if not index_file.exists():
            # 前端未构建：给出可执行的指引，而不是一个无信息量的 404
            return self._json(200, ok({
                "name": "AI 效能运营台 Mock API",
                "hint": "前端尚未构建。执行 `cd frontend && npm install && npm run build` 后刷新本页；"
                        "开发态请访问 `npm run dev` 输出的地址（默认 http://127.0.0.1:5173）。",
                "apiIndex": "/api/v1/efficiency/overview?startTime=2026-08-22&endTime=2026-09-20",
            }))
        rel = path.lstrip("/") or "index.html"
        target = (DIST_DIR / rel).resolve()
        root = DIST_DIR.resolve()
        if target != root and root not in target.parents:
            return self._json(403, err(40300, "非法路径"))
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            target = index_file  # SPA 回退：/overview、/members/:id 等前端路由
        raw = target.read_bytes()
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self._cors()
        self.end_headers()
        self.wfile.write(raw)


# --------------------------------------------------------------------------
# 自检
# --------------------------------------------------------------------------
SELFTEST_CASES = [
    ("GET", "/api/v1/efficiency/meta", None),
    ("GET", "/api/v1/efficiency/overview?startTime=2026-08-22&endTime=2026-09-20", None),
    ("GET", "/api/v1/efficiency/members?pageSize=5&sortBy=totalNewCodeLines", None),
    ("GET", "/api/v1/efficiency/departments", None),
    ("GET", "/api/enterprises/1234567890/info", None),
    ("GET", "/api/enterprises/1234567890/openapi/members?pageSize=3", None),
    ("GET", "/api/enterprises/1234567890/openapi/usage/quota-cycle", None),
    ("GET", "/api/enterprises/1234567890/openapi/usage/default-quota", None),
    ("GET", "/api/enterprises/1234567890/openapi/resources/overview", None),
    ("GET", "/api/enterprises/1234567890/metrics?queries=activeUserNum,lineIncreaseNum,completionAcceptLineRate"
            "&range.start=2026-09-01&range.end=2026-09-20&range.step=86400", None),
    ("POST", "/api/enterprises/1234567890/dashboard/member/data",
     {"timeRange": {"startTime": "2026-08-22", "endTime": "2026-09-20"},
      "memberFilter": {"type": "all"}, "pagination": {"page": 1, "pageSize": 5},
      "memberOptions": {"sortBy": "aiGenerateCodeLines", "sortOrder": "desc"}}),
    ("POST", "/api/enterprises/1234567890/dashboard/analytics/activity",
     {"timeRange": {"startTime": "2026-08-22", "endTime": "2026-09-20"},
      "memberFilter": {"type": "all"}, "viewType": "metrics"}),
    ("POST", "/api/enterprises/1234567890/dashboard/analytics/dialog",
     {"timeRange": {"startTime": "2026-08-22", "endTime": "2026-09-20"},
      "memberFilter": {"type": "all"}, "viewType": "trends"}),
    ("POST", "/api/enterprises/1234567890/dashboard/analytics/completion",
     {"timeRange": {"startTime": "2026-08-22", "endTime": "2026-09-20"},
      "memberFilter": {"type": "all"}, "viewType": "metrics"}),
    ("POST", "/api/enterprises/1234567890/dashboard/analytics/generation",
     {"timeRange": {"startTime": "2026-08-22", "endTime": "2026-09-20"},
      "memberFilter": {"type": "all"}, "viewType": "metrics"}),
    ("POST", "/api/enterprises/1234567890/openapi/observability/metric-summary/query",
     {"range": {"start": 1755792000, "end": 1758297600},
      "metrics": ["genai_request_count", "token_usage", "credit", "ttft_p95", "tool_error_rate"]}),
    ("POST", "/api/enterprises/1234567890/openapi/observability/metric-trend/query",
     {"range": {"start": 1755792000, "end": 1758297600},
      "metrics": ["credit", "token_usage"], "groupBy": "department"}),
    ("POST", "/api/enterprises/1234567890/openapi/observability/metric-records/query",
     {"range": {"start": 1758211200, "end": 1758297600}, "metrics": ["credit", "token_usage"],
      "pageSize": 3}),
    ("POST", "/api/enterprises/1234567890/openapi/usage/members/query",
     {"userNames": ["张伟"], "pageSize": 3}),
    ("POST", "/api/enterprises/1234567890/openapi/observability/metric-summary/query",
     {"range": {"start": 1755792000, "end": 1758297600}, "metrics": ["not_a_metric"]}, 400),
    ("GET", "/api/enterprises/wrong-id/info", None, 403),
]


def selftest_http() -> int:
    """HTTP 层自检。

    历史教训：`/` 曾被错误地归类为接口路径，导致静态入口返回 404
    （`未实现的接口: GET /`），而当时的自检直接调用 route() 因此完全没发现。
    路由分类属于 HTTP 层行为，必须在这一层验证。
    """
    failures = 0
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"
    index_exists = (DIST_DIR / "index.html").exists()
    print(f"HTTP 层自检（{base}，前端产物{'已' if index_exists else '未'}构建）：")

    def probe(method: str, path: str, payload: bytes | None = None):
        request = urllib.request.Request(f"{base}{path}", method=method, data=payload)
        if payload is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, response.headers.get("Content-Type", ""), response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers.get("Content-Type", ""), exc.read()

    # 期望 (方法, 路径, 状态码, 内容类型关键字, 说明)
    cases = [
        ("GET", "/", 200, "application/json" if not index_exists else "text/html", "根路径：静态入口"),
        ("GET", "/overview", 200, "application/json" if not index_exists else "text/html", "SPA 深链回退"),
        ("GET", "/members/whatever-uuid", 200, "application/json" if not index_exists else "text/html", "带参深链"),
        ("GET", "/favicon.svg", 200, None, "静态资源"),
        ("GET", "/healthz", 200, "application/json", "健康检查"),
        ("GET", "/api/v1/efficiency/meta", 200, "application/json", "扩展接口"),
        ("GET", "/api/v1/efficiency/nope", 404, "application/json", "未实现的扩展接口"),
        ("POST", "/overview", 405, "application/json", "静态路径不接受 POST"),
    ]
    for method, path, expect_status, expect_type, label in cases:
        status, ctype, body = probe(method, path)
        type_ok = expect_type is None or expect_type in ctype
        ok = status == expect_status and type_ok
        if not ok:
            failures += 1
        print(f"  [{'OK  ' if ok else 'FAIL'}] {status} {method:<4} {path:<28} {label}")
        if not ok:
            print(f"         期望 {expect_status} {expect_type}，实际 {status} {ctype}：{body[:120]!r}")

    # 前端未构建时必须给出可执行指引，而不是无信息量的 404
    if not index_exists:
        status, _, body = probe("GET", "/")
        if b"npm run build" not in body:
            failures += 1
            print("  [FAIL] 未构建前端时的根路径缺少构建指引")
        else:
            print("  [OK  ] 未构建前端时返回了构建指引")

    httpd.shutdown()
    httpd.server_close()
    return failures


def selftest() -> int:
    failures = 0
    print(f"数据集：{DATASET_PATH}")
    print(f"企业：{DS.enterprise_id}  成员：{len(DS.members)}  记录：{len(DS.dataset['series'])}\n")
    for case in SELFTEST_CASES:
        method, path, body = case[0], case[1], case[2]
        expect_status = case[3] if len(case) > 3 else 200
        parsed = urlparse(path)
        try:
            if parsed.path == "/healthz":
                status, payload = 200, ok({"status": "ok"})
            else:
                status, payload = route(method, parsed.path, parse_qs(parsed.query), body or {})
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            print(f"[FAIL] {method} {path} -> 异常 {exc}")
            failures += 1
            continue
        if expect_status >= 400:
            # 错误分支只校验状态码与错误码语义
            is_ok = status == expect_status and payload.get("code") not in (None, 0)
        else:
            is_ok = status == 200 and payload.get("code") == 0
        mark = "OK  " if is_ok else "FAIL"
        if not is_ok:
            failures += 1
        data = payload.get("data")
        size = len(json.dumps(data, ensure_ascii=False)) if data is not None else 0
        print(f"[{mark}] {status} {method:<4} {parsed.path}"
              f"{'?' + parsed.query if parsed.query else ''}   payload={size}B")
    # 交叉校验：部门汇总之和 == 公司总量
    start, end = DS.resolve_range(None, None, 30)
    sl = DS.slice(start, end)
    dept_credit = round(sum(v["credit"] for v in sl.departments.values()), 2)
    org_credit = round(sl.org["credit"], 2)
    member_credit = round(sum(v["credit"] for v in sl.members.values()), 2)
    print(f"\n口径一致性校验（{start} ~ {end}）：")
    print(f"  部门汇总 credits = {dept_credit:,.2f}")
    print(f"  成员汇总 credits = {member_credit:,.2f}")
    print(f"  公司总量 credits = {org_credit:,.2f}")
    if abs(dept_credit - org_credit) > 0.01 or abs(member_credit - org_credit) > 0.01:
        print("  [FAIL] 汇总口径不一致")
        failures += 1
    else:
        print("  [OK  ] 汇总口径一致")
    print()
    failures += selftest_http()

    print(f"\n{'全部通过' if failures == 0 else f'{failures} 个用例失败'}")
    return 1 if failures else 0


def main() -> None:
    global DS
    parser = argparse.ArgumentParser(description="AI 效能运营台 Mock API 服务")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--dataset", default=str(DATASET_PATH))
    parser.add_argument("--selftest", action="store_true", help="跑一遍接口自检后退出")
    args = parser.parse_args()

    DS = DataSource(Path(args.dataset))
    if args.selftest:
        raise SystemExit(selftest())

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"AI 效能运营台 Mock API  ->  http://{args.host}:{args.port}")
    print(f"  数据集: {args.dataset}")
    print(f"  企业: {DS.enterprise_id} / 成员 {len(DS.members)} / 日记录 {len(DS.dataset['series'])}")
    print(f"  自检: python3 {Path(__file__).name} --selftest")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()

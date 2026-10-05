/**
 * 路由层共享工具 —— 对应 Python `server.py` 的
 * `_q_range` / `_q_list` / `_q_member_filter` / `_member_filter` / `_department_filter`
 * / `member_data` / `_zero_member` / `_to_doc_member`。
 *
 * 为什么成员明细放在共享层：`/api/v1/efficiency/members`（本方案扩展）与
 * `/api/enterprises/{eid}/dashboard/member/data`（对齐 document.yaml）**是同一份实现**，
 * Python 版就是这么复用的。拆成两份会让两个入口的口径分叉。
 */

import type { DataSource } from '../datasource.ts';
import { round2 } from '../pyround.ts';
import type { MetricsRecord } from '../metrics.ts';
import type { ParsedQuery } from '../http/query.ts';

/** 路由层的通用行类型：字段名与 Python dict 一一对应，故不逐字段收窄。 */
export type Row = Record<string, any>;

// ---------------------------------------------------------------------------
// 查询串 → payload 片段
// ---------------------------------------------------------------------------

/** 等价 `_q_range(query)`。注意 Python 里缺省值是 `None`（不是空串）。 */
export function qRange(query: ParsedQuery): { startTime: string | null; endTime: string | null } {
  return {
    startTime: query['startTime']?.[0] ?? null,
    endTime: query['endTime']?.[0] ?? null,
  };
}

/** 等价 `_q_list(query, key)`：逗号分隔，丢弃空项。 */
export function qList(query: ParsedQuery, key: string): string[] {
  const raw = query[key]?.[0] ?? '';
  return raw.split(',').filter((item) => item);
}

/** 等价 `_q_member_filter(query)`：从 `userIds` 逗号串构造 memberFilter。 */
export function qMemberFilter(query: ParsedQuery): { type: string; data?: string[] } {
  const ids = qList(query, 'userIds');
  return ids.length ? { type: 'selected', data: ids } : { type: 'all' };
}

// ---------------------------------------------------------------------------
// payload → 过滤条件
// ---------------------------------------------------------------------------

/** 等价 `_member_filter(payload)`：仅在 `type === 'selected'` 且有数据时返回集合。 */
export function memberFilter(payload: Row): Set<string> | null {
  const mf = payload?.['memberFilter'] ?? { type: 'all' };
  if (mf?.['type'] === 'selected' && mf?.['data']) return new Set<string>(mf['data']);
  return null;
}

/** 等价 `_department_filter(payload)`。 */
export function departmentFilter(payload: Row): Set<string> | null {
  const ids = payload?.['departmentIds'] ?? [];
  return ids.length ? new Set<string>(ids) : null;
}

// ---------------------------------------------------------------------------
// 成员行构造
// ---------------------------------------------------------------------------

/** 等价 `_zero_member(meta)`：窗口内无任何行为的成员也要出现在列表里。 */
export function zeroMember(meta: Row): Row {
  return {
    userId: meta['userId'],
    userName: meta['userName'],
    userNickname: meta['userNickname'],
    primaryDepartmentId: meta['primaryDepartmentId'],
    primaryDepartmentName: meta['primaryDepartmentName'],
    departmentFullPaths: meta['departmentFullPaths'] ?? [],
    activeDays: 0,
    lastActiveTime: null,
    credit: 0.0,
    aiCodeLines: 0,
    totalNewCodeLines: 0,
    completionGenerateCount: 0,
    completionAcceptCount: 0,
    completionGenerateLines: 0,
    completionAcceptLines: 0,
    completionGenerateChars: 0,
    completionAcceptChars: 0,
    aiGenerateCodeChars: 0,
    totalNewCodeChars: 0,
    dialogCount: 0,
    sessionCount: 0,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    tokenUsage: 0,
    completionAcceptRateByCount: 0.0,
    completionAcceptRateByLines: 0.0,
    completionAcceptRateByChars: 0.0,
    codeGenerateRateByLines: 0.0,
    codeGenerateRateByChars: 0.0,
    cycleLimit: meta['cycleLimit'] ?? null,
    cycleLimitDisplay: meta['cycleLimitDisplay'] ?? null,
    quotaUsageRate: null,
    creditsPerKline: null,
    aiLinesPerActiveDay: 0,
  };
}

/**
 * 等价 `_to_doc_member(row)`。
 * 输出字段名与 `document.yaml` L1785-L1923 对齐，扩展字段以 `__` 前缀标注。
 */
export function toDocMember(row: Row): Row {
  return {
    memberId: row['userId'],
    memberName: row['userName'],
    userNickname: row['userNickname'],
    lastActiveTime: row['lastActiveTime'],
    departmentIds: [row['primaryDepartmentId']],
    departmentNames: [row['primaryDepartmentName']],
    departmentFullPaths: row['departmentFullPaths'] ?? [],
    primaryDepartmentId: row['primaryDepartmentId'],
    primaryDepartmentName: row['primaryDepartmentName'],
    activeDays: row['activeDays'],
    dialogCount: row['dialogCount'],
    completionGenerateCount: row['completionGenerateCount'],
    completionAcceptCount: row['completionAcceptCount'],
    // Python 的 `x or 0`：None / 0 都归一为 0
    completionAcceptRateByCount: row['completionAcceptRateByCount'] || 0,
    completionGenerateLines: row['completionGenerateLines'],
    completionAcceptLines: row['completionAcceptLines'],
    completionAcceptRateByLines: row['completionAcceptRateByLines'] || 0,
    completionGenerateChars: row['completionGenerateChars'],
    completionAcceptChars: row['completionAcceptChars'],
    completionAcceptRateByChars: row['completionAcceptRateByChars'] || 0,
    aiGenerateCodeLines: row['aiCodeLines'],
    totalNewCodeLines: row['totalNewCodeLines'],
    codeGenerateRateByLines: row['codeGenerateRateByLines'] || 0,
    aiGenerateCodeChars: row['aiGenerateCodeChars'],
    totalNewCodeChars: row['totalNewCodeChars'],
    codeGenerateRateByChars: row['codeGenerateRateByChars'] || 0,
    totalUsed: row['credit'],
    cycleLimit: row['cycleLimit'],
    cycleLimitDisplay: row['cycleLimitDisplay'],
    // —— 本方案扩展字段（前端效能分析使用）——
    __credit: row['credit'],
    __previousCredit: row['previousCredit'],
    __creditGrowthRate: row['creditGrowthRate'],
    __previousTotalNewCodeLines: row['previousTotalNewCodeLines'],
    __sessionCount: row['sessionCount'],
    __requestCount: row['requestCount'],
    __tokenUsage: row['tokenUsage'],
    __inputTokens: row['inputTokens'],
    __outputTokens: row['outputTokens'],
    __quotaUsageRate: row['quotaUsageRate'],
    __creditsPerKline: row['creditsPerKline'],
    __aiLinesPerActiveDay: row['aiLinesPerActiveDay'],
  };
}

/**
 * 等价 `member_data(payload)`。
 *
 * 要点：
 *   - 冷启动成员（窗口内无行为）也要出现，便于提醒与派发；
 *   - 环比用等长紧邻区间；`creditGrowthRate` 在前期为 0 时按 0 / 100 分档；
 *   - 排序对 `None` 关键字统一沉底（Python 用 ±inf，这里用 ±Infinity）；
 *   - `pageSize` 上限 200。
 */
export function memberData(ds: DataSource, payload: Row): Row {
  const timeRange = payload?.['timeRange'] ?? {};
  const [start, end] = ds.resolveRange(timeRange['startTime'] ?? null, timeRange['endTime'] ?? null);
  const userIds = memberFilter(payload);
  const deptIds = departmentFilter(payload);
  const cur = ds.slice(start, end, userIds, deptIds);
  const [pStart, pEnd] = ds.previousRange(start, end);
  const prev = ds.slice(pStart, pEnd, userIds, deptIds);

  const memberOptions = payload?.['memberOptions'] ?? {};
  const keyword = String(memberOptions['searchKeyword'] ?? '').trim().toLowerCase();
  const sortBy = memberOptions['sortBy'] ?? 'totalNewCodeLines';
  const sortOrder = memberOptions['sortOrder'] ?? 'desc';

  const allMembers = ds.members.filter(
    (m) =>
      (userIds === null || userIds.has(m.userId)) &&
      (!deptIds || deptIds.has(m.primaryDepartmentId)),
  );

  const rows: Row[] = [];
  for (const meta of allMembers) {
    const uid = meta.userId;
    const curRow: Row = cur.members[uid] ?? zeroMember(meta as unknown as Row);
    const prevRow = prev.members[uid];
    const row: Row = { ...curRow };
    row['previousCredit'] = prevRow ? prevRow['credit'] : 0.0;
    row['previousTotalNewCodeLines'] = prevRow ? prevRow['totalNewCodeLines'] : 0;
    row['creditGrowthRate'] = row['previousCredit']
      ? round2(((row['credit'] - row['previousCredit']) / row['previousCredit']) * 100)
      : row['credit']
        ? 100.0
        : 0.0;
    rows.push(row);
  }

  const filtered = keyword
    ? rows.filter(
        (r) =>
          String(r['userName'] ?? '').toLowerCase().includes(keyword) ||
          String(r['userNickname'] ?? '').toLowerCase().includes(keyword) ||
          String(r['primaryDepartmentName'] ?? '').toLowerCase().includes(keyword),
      )
    : rows;

  const desc = sortOrder === 'desc';
  const keyOf = (row: Row): number => {
    const v = row[sortBy];
    if (v === null || v === undefined) return desc ? -Infinity : Infinity;
    return Number(v);
  };
  // JS 的 Array#sort 自 ES2019 起稳定；Python 的 reverse=True 也保持相等元素原序，故语义一致
  filtered.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka < kb) return desc ? 1 : -1;
    if (ka > kb) return desc ? -1 : 1;
    return 0;
  });

  const pagination = payload?.['pagination'] ?? {};
  const page = Math.max(1, Number(pagination['page'] ?? 1) || 1);
  const pageSize = Math.max(1, Math.min(200, Number(pagination['pageSize'] ?? 20) || 20));
  const total = filtered.length;
  const startIndex = (page - 1) * pageSize;
  const pageRows = filtered.slice(startIndex, startIndex + pageSize);

  return {
    members: pageRows.map(toDocMember),
    pagination: {
      page,
      pageSize,
      total,
      totalPage: Math.max(1, Math.floor((total + pageSize - 1) / pageSize)),
    },
    range: { start, end },
    orgSummary: {
      credit: cur.org['credit'],
      previousCredit: prev.org['credit'],
      aiCodeLines: cur.org['aiCodeLines'],
      totalNewCodeLines: cur.org['totalNewCodeLines'],
      codeGenerateRateByLines: cur.org['codeGenerateRateByLines'],
      activeUserNum: cur.org['activeUserNum'],
    },
  };
}

/** 便捷取值：把 MetricsRecord 当成宽松字典用。 */
export function pick(record: MetricsRecord | undefined, key: string): any {
  return record ? record[key] : undefined;
}

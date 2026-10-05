/**
 * 本方案扩展的效能域路由 —— 对应 Python `server.py` 的
 * `efficiency_overview` / `quota_list` / `member_detail`。
 *
 * 定位：这些接口是"一次拿齐首屏"的聚合读接口，专门为前端少发请求而设计。
 * 聚合一律走 `ds.slice()` / `metrics.ts`，本文件不实现任何口径。
 */

import type { DataSource } from '../datasource.ts';
import type { MetricsRecord } from '../metrics.ts';
import { dailyPoints, dateRange } from '../metrics.ts';
import { round2 } from '../pyround.ts';
import type { ParsedQuery } from '../http/query.ts';
import { departmentFilter, memberFilter, qList, zeroMember, toDocMember, type Row } from './shared.ts';
import { ok as okBody, err as errBody } from '../http/envelope.ts';

/** 等价 Python 的 `next((i[k] for i in items if ...), default)` 取值模式。 */
function resourceField(
  ds: DataSource,
  resourceType: string,
  field: string,
  fallback: number,
): number {
  const items = ds.dataset.resources?.items ?? [];
  for (const item of items as Row[]) {
    if (item['resourceType'] === resourceType) return Number(item[field]);
  }
  return fallback;
}

/** 等价 `efficiency_overview(payload)`：部门级效能总览，首屏一次拿齐。 */
export function efficiencyOverview(ds: DataSource, payload: Row): Row {
  const timeRange = payload?.['timeRange'] ?? {};
  const [start, end] = ds.resolveRange(timeRange['startTime'] ?? null, timeRange['endTime'] ?? null);
  const [pStart, pEnd] = ds.previousRange(start, end);
  const userIds = memberFilter(payload);
  const deptIds = departmentFilter(payload);
  const cur = ds.slice(start, end, userIds, deptIds);
  const prev = ds.slice(pStart, pEnd, userIds, deptIds);

  const totalSeats = resourceField(ds, 'license', 'total', ds.members.length);
  const usedSeats = resourceField(ds, 'license', 'used', ds.members.length);

  // 按 credit 降序；Python 的 `sorted(key=-credit)` 稳定，JS 的 sort 也稳定，故相等项保持插入序
  const departments: Row[] = [];
  const deptEntries = Object.entries(cur.departments) as Array<[string, MetricsRecord]>;
  deptEntries.sort((a, b) => Number(b[1]['credit'] ?? 0) - Number(a[1]['credit'] ?? 0));
  for (const [deptId, v] of deptEntries) {
    const pv: MetricsRecord = prev.departments[deptId] ?? {};
    const meta = (ds.index.departments.get(deptId) ?? {}) as unknown as Row;
    departments.push({
      departmentId: deptId,
      departmentName: meta['departmentName'] ?? deptId,
      fullPath: meta['fullPath'] ?? '',
      memberCount: v['memberCount'],
      activeUserNum: v['activeUserNum'],
      activeRate: v['activeRate'],
      credit: v['credit'],
      previousCredit: pv['credit'] ?? 0.0,
      creditGrowthRate: pv['credit']
        ? round2(((Number(v['credit']) - Number(pv['credit'])) / Number(pv['credit'])) * 100)
        : v['credit']
          ? 100.0
          : 0.0,
      creditShare: cur.org['credit']
        ? round2((Number(v['credit']) / Number(cur.org['credit'])) * 100)
        : 0,
      avgCreditPerUser: v['avgCreditsPerActiveUser'],
      dialogCount: v['dialogCount'],
      sessionCount: v['sessionCount'],
      requestCount: v['requestCount'],
      tokenUsage: v['tokenUsage'],
      aiCodeLines: v['aiCodeLines'],
      totalNewCodeLines: v['totalNewCodeLines'],
      aiCodeRate: v['codeGenerateRateByLines'],
      acceptRateByLines: v['completionAcceptRateByLines'],
      creditsPerKline: v['creditsPerKline'],
      aiLinesPerActiveUser: v['avgAiLinesPerActiveUser'],
      requestErrorRate: v['requestErrorRate'],
      toolErrorRate: v['toolErrorRate'],
    });
  }

  // 日级趋势：消耗 / 代码量 / AI 占比 / 活跃人数
  const totalOf = (field: string): Map<string, number> =>
    new Map(dailyPoints(ds.index, start, end, field, null, userIds)['__total__'] ?? []);
  const creditByDay = totalOf('cr');
  const linesByDay = totalOf('tnl');
  const aiByDay = totalOf('ail');

  const activeByDay = new Map<string, Set<string>>();
  for (const day of dateRange(start, end)) {
    for (const row of ds.index.byDay.get(day) ?? []) {
      if (userIds !== null && !userIds.has(row.u)) continue;
      const dept = ds.index.deptOf.get(row.u) ?? null;
      if (deptIds && (dept === null || !deptIds.has(dept))) continue;
      let bucket = activeByDay.get(day);
      if (!bucket) {
        bucket = new Set<string>();
        activeByDay.set(day, bucket);
      }
      bucket.add(row.u);
    }
  }

  const days = dateRange(start, end);
  const trend = days.map((d) => {
    const lines = linesByDay.get(d);
    return {
      date: d,
      credit: round2(creditByDay.get(d) ?? 0.0),
      totalNewCodeLines: linesByDay.get(d) ?? 0,
      aiCodeLines: aiByDay.get(d) ?? 0,
      aiCodeRate: lines ? round2(((aiByDay.get(d) ?? 0) / lines) * 100) : 0,
      activeUserNum: (activeByDay.get(d) ?? new Set<string>()).size,
    };
  });

  const ORG_KEYS = [
    'credit',
    'dialogCount',
    'sessionCount',
    'requestCount',
    'tokenUsage',
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'toolCallCount',
    'aiCodeLines',
    'totalNewCodeLines',
    'codeGenerateRateByLines',
    'codeGenerateRateByChars',
    'completionAcceptRateByLines',
    'completionAcceptRateByCount',
    'completionGenerateCount',
    'completionAcceptCount',
    'completionAcceptLines',
    'activeUserNum',
    'dau',
    'requestErrorRate',
    'toolErrorRate',
    'avgCreditsPerActiveUser',
    'avgAiLinesPerActiveUser',
  ];
  const PREV_KEYS = [
    'credit',
    'dialogCount',
    'aiCodeLines',
    'totalNewCodeLines',
    'codeGenerateRateByLines',
    'activeUserNum',
    'tokenUsage',
  ];

  const org: Row = {};
  for (const k of ORG_KEYS) org[k] = cur.org[k] ?? null;
  const previous: Row = {};
  for (const k of PREV_KEYS) previous[k] = prev.org[k] ?? null;
  org['previous'] = previous;
  org['memberCount'] = ds.members.length;
  org['seatTotal'] = totalSeats;
  org['seatUsed'] = usedSeats;
  org['resourceItems'] = ds.dataset.resources?.items ?? [];
  org['quotaCycle'] = ds.dataset.quotaCycle;

  return {
    range: {
      start,
      end,
      previousStart: pStart,
      previousEnd: pEnd,
      days: days.length,
    },
    org,
    departments,
    trend,
  };
}

/** 解析 `/api/v1/efficiency/overview` 的查询串为 payload。 */
export function overviewPayloadFromQuery(query: ParsedQuery): Row {
  return {
    timeRange: {
      startTime: query['startTime']?.[0] ?? null,
      endTime: query['endTime']?.[0] ?? null,
    },
    departmentIds: qList(query, 'departmentIds'),
    memberFilter: memberFilterFromQuery(query),
  };
}

function memberFilterFromQuery(query: ParsedQuery): Row {
  const ids = qList(query, 'userIds');
  return ids.length ? { type: 'selected', data: ids } : { type: 'all' };
}

// ---------------------------------------------------------------------------
// 额度视图
// ---------------------------------------------------------------------------

/**
 * 等价 `quota_list(query)`：把「周期限量」与「窗口内实际消耗」放在一起。
 *
 * 两个易错点：
 *   - 排序键是 `(-(rate or -1), -totalUsed)` 的**元组**：`or -1` 意味着
 *     `null`（不限量）与 `0`（未消耗）都会落到 `-1`，即排在最后，且两者同档；
 *     次级键是 totalUsed 降序。
 *   - `pageSize` 上限 500（与成员列表的 200 不同）。
 */
export function quotaList(ds: DataSource, query: ParsedQuery): Row {
  const [start, end] = ds.resolveRange(
    query['startTime']?.[0] ?? null,
    query['endTime']?.[0] ?? null,
  );
  const keyword = (query['keyword']?.[0] ?? '').trim().toLowerCase();
  const deptIds = new Set(qList(query, 'departmentIds'));
  const cur = ds.slice(start, end, null, deptIds.size ? deptIds : null);

  const items: Row[] = [];
  for (const m of ds.members) {
    if (deptIds.size && !deptIds.has(m.primaryDepartmentId)) continue;
    if (
      keyword &&
      !m.userName.toLowerCase().includes(keyword) &&
      !m.primaryDepartmentName.toLowerCase().includes(keyword)
    ) {
      continue;
    }
    const used = Number(cur.members[m.userId]?.['credit'] ?? 0.0);
    const limit = m.cycleLimit ?? null;
    const rate = limit ? round2((used / limit) * 100) : null;
    items.push({
      userId: m.userId,
      userName: m.userName,
      departmentName: m.primaryDepartmentName,
      departmentId: m.primaryDepartmentId,
      cycleLimit: limit,
      cycleLimitDisplay: (m as unknown as Row)['cycleLimitDisplay'] ?? '不限量',
      totalUsed: round2(used),
      __quotaUsageRate: rate,
      riskLevel:
        rate === null ? 'unlimited' : rate >= 90 ? 'high' : rate >= 70 ? 'medium' : 'low',
    });
  }

  // Python: key=(-(rate or -1), -totalUsed)，升序 → rate 降序、totalUsed 降序；稳定
  const rateKey = (x: Row): number => Number(x['__quotaUsageRate']) || -1;
  items.sort((a, b) => {
    const ra = rateKey(a);
    const rb = rateKey(b);
    if (ra !== rb) return rb - ra;
    return Number(b['totalUsed']) - Number(a['totalUsed']);
  });

  const page = Math.max(1, Number(query['page']?.[0] ?? '1') || 1);
  const size = Math.max(1, Math.min(500, Number(query['pageSize']?.[0] ?? '200') || 200));
  return {
    items: items.slice((page - 1) * size, page * size),
    totalCount: items.length,
    range: { start, end },
  };
}

// ---------------------------------------------------------------------------
// 成员详情（抽屉）
// ---------------------------------------------------------------------------

/** 等价 `member_detail(member_id, time_range)`，返回 `[status, payload]`。 */
export function memberDetail(
  ds: DataSource,
  memberId: string,
  timeRange: Row,
): [number, unknown] {
  const meta =
    (ds.memberById.get(memberId) as unknown as Row | undefined) ??
    (ds.memberByName.get(memberId) as unknown as Row | undefined);
  if (!meta) return [404, errBody(40401, `成员不存在: ${memberId}`)];

  const [start, end] = ds.resolveRange(timeRange?.['startTime'] ?? null, timeRange?.['endTime'] ?? null);
  const [pStart, pEnd] = ds.previousRange(start, end);
  const uid = String(meta['userId']);
  const uidSet = new Set([uid]);
  const cur = ds.slice(start, end, uidSet);
  const prev = ds.slice(pStart, pEnd, uidSet);
  const row: Row = (cur.members[uid] as unknown as Row) ?? zeroMember(meta);

  const days = dateRange(start, end);
  // Python 用字典推导 `{d: r for d in days for r in by_day[d] if r.u == uid}`：
  // 同一成员同日若有多条（不同 model/client），**保留最后一条**。
  const byDayRows = new Map<string, Row>();
  for (const d of days) {
    for (const r of (ds.index.byDay.get(d) ?? []) as unknown as Row[]) {
      if (r['u'] === uid) byDayRows.set(d, r);
    }
  }

  const detailTrend = days.map((d) => {
    const r = byDayRows.get(d);
    return {
      date: d,
      credit: r ? round2(Number(r['cr'])) : 0,
      aiCodeLines: r ? r['ail'] : 0,
      totalNewCodeLines: r ? r['tnl'] : 0,
      aiCodeRate: r && r['tnl'] ? round2((Number(r['ail']) / Number(r['tnl'])) * 100) : 0,
      dialogCount: r ? r['dc'] : 0,
      completionAcceptLines: r ? r['cal'] : 0,
      acceptRateByLines: r && r['cgl'] ? round2((Number(r['cal']) / Number(r['cgl'])) * 100) : 0,
      tokenUsage: r ? Number(r['it']) + Number(r['ot']) : 0,
    };
  });

  const modelMix = new Map<string, Row>();
  const clientMix = new Map<string, Row>();
  const langMix = new Map<string, Row>();
  for (const d of days) {
    for (const r of (ds.index.byDay.get(d) ?? []) as unknown as Row[]) {
      if (r['u'] !== uid) continue;
      const pairs: Array<[Map<string, Row>, unknown]> = [
        [modelMix, r['md']],
        [clientMix, r['cl']],
        [langMix, r['lg']],
      ];
      for (const [store, keyRaw] of pairs) {
        const key = String(keyRaw);
        let b = store.get(key);
        if (!b) {
          b = { credit: 0.0, dialogCount: 0, aiCodeLines: 0 };
          store.set(key, b);
        }
        b['credit'] += Number(r['cr']);
        b['dialogCount'] += Number(r['dc']);
        b['aiCodeLines'] += Number(r['ail']);
      }
    }
  }

  const toItems = (store: Map<string, Row>, totalCredit: number): Row[] => {
    const out = [...store.entries()].map(([k, v]) => ({
      label: k,
      value: round2(Number(v['credit'])),
      extra: {
        dialogCount: v['dialogCount'],
        aiCodeLines: v['aiCodeLines'],
        share: totalCredit ? round2((Number(v['credit']) / totalCredit) * 100) : 0,
      },
    }));
    out.sort((a, b) => b.value - a.value); // Python `sorted(key=-value)`
    return out;
  };

  let totalCredit = 0;
  for (const v of modelMix.values()) totalCredit += Number(v['credit']);
  if (!totalCredit) totalCredit = 1.0;

  const prevCredit = Number(prev.members[uid]?.['credit'] ?? 0);
  const prevLines = Number(prev.members[uid]?.['totalNewCodeLines'] ?? 0);
  const docRow: Row = {
    ...row,
    previousCredit: prevCredit,
    previousTotalNewCodeLines: prevLines,
    creditGrowthRate: prevCredit
      ? round2(((Number(row['credit']) - prevCredit) / prevCredit) * 100)
      : 0.0,
  };

  return [
    200,
    okBody({
      member: toDocMember(docRow),
      profile: {
        email: meta['email'] ?? null,
        joinedAt: meta['joinedAt'] ?? null,
        departmentFullPaths: meta['departmentFullPaths'] ?? [],
        cycleLimit: meta['cycleLimit'] ?? null,
        cycleLimitDisplay: meta['cycleLimitDisplay'] ?? null,
        primaryLanguage: meta['_lang'] ?? null,
      },
      range: { start, end, previousStart: pStart, previousEnd: pEnd },
      trend: detailTrend,
      modelMix: toItems(modelMix, totalCredit),
      clientMix: toItems(clientMix, totalCredit),
      languageMix: toItems(langMix, totalCredit),
    }),
  ];
}


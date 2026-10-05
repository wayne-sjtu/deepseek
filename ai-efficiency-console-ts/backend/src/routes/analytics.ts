/**
 * 分析域路由 —— 对应 Python `server.py` 的
 * `analytics_activity` / `analytics_dialog` / `analytics_completion` / `analytics_generation`
 * 以及辅助函数 `_pair_daily`。
 *
 * 对应 `/api/enterprises/{eid}/dashboard/analytics/{activity|dialog|completion|generation}`。
 * 与其它域一样：**这里不实现口径**，聚合一律走 `ds.slice()` 与 `metrics.ts`。
 */

import type { DataSource } from '../datasource.ts';
import type { MetricsRecord } from '../metrics.ts';
import { dailyPoints, dateRange } from '../metrics.ts';
import { round0, round1, round2 } from '../pyround.ts';
import { metricCard, seriesPoint } from '../http/envelope.ts';
import type { Row } from './shared.ts';

/** 等价 `daily_points(...).get("__total__", [])`。 */
function totalPairs(
  ds: DataSource,
  start: string,
  end: string,
  field: string,
  userIds: Set<string> | null,
): Array<[string, number]> {
  return dailyPoints(ds.index, start, end, field, null, userIds)['__total__'] ?? [];
}

/**
 * 等价 `_pair_daily(index, start, end, num_field, den_field, user_ids)`：
 * 按天返回 `(日期, 分子, 分母)`，用于比率型趋势线（**先求和再相除**）。
 *
 * 实现说明：Python 逐行累加两个字段；这里改成对两个字段各取一次 `daily_points`
 * 再按天合并 —— 两者等价，因为 `daily_points` 对"有行但该字段为 0"的日期同样
 * 会产出键（不会漏日），所以两侧的日期集合相同。而且是复用口径函数而非另写累加。
 */
export function pairDaily(
  ds: DataSource,
  start: string,
  end: string,
  numField: string,
  denField: string,
  userIds: Set<string> | null,
): Array<[string, number, number]> {
  const num = new Map(totalPairs(ds, start, end, numField, userIds));
  const den = new Map(totalPairs(ds, start, end, denField, userIds));
  const days = [...new Set([...num.keys(), ...den.keys()])].sort();
  return days.map((d) => [d, num.get(d) ?? 0, den.get(d) ?? 0]);
}

/** 等价 `efficiency_overview` 之外的 `analytics_activity`。 */
export function analyticsActivity(
  ds: DataSource,
  start: string,
  end: string,
  userIds: Set<string> | null,
  deptIds: Set<string> | null,
): Row {
  const cur = ds.slice(start, end, userIds, deptIds);
  const [pStart, pEnd] = ds.previousRange(start, end);
  const prev = ds.slice(pStart, pEnd, userIds, deptIds);
  const days = dateRange(start, end);

  // 日活曲线（按部门分组）
  const daily = new Map<string, Map<string | null, Set<string>>>();
  for (const day of days) {
    const byDept = new Map<string | null, Set<string>>();
    daily.set(day, byDept);
    for (const row of ds.index.byDay.get(day) ?? []) {
      if (userIds !== null && !userIds.has(row.u)) continue;
      const dept = ds.index.deptOf.get(row.u) ?? null;
      if (deptIds && (dept === null || !deptIds.has(dept))) continue;
      let bucket = byDept.get(dept);
      if (!bucket) {
        bucket = new Set<string>();
        byDept.set(dept, bucket);
      }
      bucket.add(row.u);
    }
  }

  const activePoints = days.map((d): [string, number] => {
    const union = new Set<string>();
    for (const s of (daily.get(d) ?? new Map()).values()) for (const u of s) union.add(u);
    return [d, union.size];
  });

  // 注意：Python 这里**没有**按 dept_ids 过滤（只有 user_ids），照抄
  const newUsers = ds.members.filter(
    (m) =>
      (userIds === null || userIds.has(m.userId)) &&
      m.joinedAt.slice(0, 10) >= start &&
      m.joinedAt.slice(0, 10) <= end,
  );

  const deptDist = (Object.entries(cur.departments) as Array<[string, MetricsRecord]>)
    .map(([k, v]) => ({
      label: (ds.index.departments.get(k) as unknown as Row | undefined)?.['departmentName'] ?? k,
      value: v['activeUserNum'],
      extra: { credit: v['credit'], aiLines: v['aiCodeLines'] },
    }))
    .sort((a, b) => Number(b.value) - Number(a.value));

  // 当日客户端活跃分布：只统计 end 这一天
  const clientAgg = new Map<string, number>();
  for (const row of ds.index.byDay.get(end) ?? []) {
    if (userIds !== null && !userIds.has(row.u)) continue;
    const key = String(row.cl);
    clientAgg.set(key, (clientAgg.get(key) ?? 0) + 1);
  }

  return {
    summary: {
      metrics: [
        metricCard('activeUsers', '活跃用户', cur.org['activeUserNum'], prev.org['activeUserNum'], '人'),
        metricCard('dau', '日均活跃', cur.org['dau'], prev.org['dau'], '人'),
        metricCard(
          'activeRate',
          '活跃率',
          round2((Number(cur.org['activeUserNum']) / Math.max(ds.members.length, 1)) * 100),
          round2((Number(prev.org['activeUserNum']) / Math.max(ds.members.length, 1)) * 100),
          '%',
        ),
        metricCard('newUsers', '窗口内新增席位', newUsers.length, 0, '人'),
      ],
    },
    charts: {
      charts: [
        {
          key: 'activeUserDistribution',
          title: '活跃用户部门分布',
          type: 'pie',
          data: { items: deptDist },
        },
        {
          key: 'activeUserByClient',
          title: '当日客户端活跃分布',
          type: 'bar',
          data: {
            items: [...clientAgg.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([label, value]) => ({ label, value })),
          },
        },
      ],
    },
    trends: {
      series: [seriesPoint('activeUsers', '日活跃人数', activePoints, 'area')],
    },
    dimension: { type: 'department', label: '部门' },
  };
}

/** 等价 `analytics_dialog`。 */
export function analyticsDialog(
  ds: DataSource,
  start: string,
  end: string,
  userIds: Set<string> | null,
  deptIds: Set<string> | null,
): Row {
  const cur = ds.slice(start, end, userIds, deptIds);
  const [pStart, pEnd] = ds.previousRange(start, end);
  const prev = ds.slice(pStart, pEnd, userIds, deptIds);

  const totals = cur.org as unknown as Row;
  const prevOrg = prev.org as unknown as Row;
  const MODES: Array<[string, string]> = [
    ['dk', 'Ask 问答'],
    ['dcr', 'Craft 编码'],
    ['da', 'Agent'],
    ['dkb', '知识库'],
    ['dct', '上下文'],
    ['dcm', '命令'],
    ['dac', '动作'],
    ['dcy', '自定义'],
  ];

  const trendSeries: Row[] = [];
  for (const [field, label] of MODES.slice(0, 4)) {
    trendSeries.push(seriesPoint(field, label, totalPairs(ds, start, end, field, userIds), 'line'));
  }

  const modelMap = new Map<string, number>();
  for (const d of dateRange(start, end)) {
    for (const row of ds.index.byDay.get(d) ?? []) {
      if (userIds !== null && !userIds.has(row.u)) continue;
      const key = String(row.md);
      modelMap.set(key, (modelMap.get(key) ?? 0) + Number(row.dc));
    }
  }

  return {
    summary: {
      metrics: [
        metricCard('dialogCount', '对话次数', totals['dc'], prevOrg['dc'], '次'),
        metricCard('dialogUsers', '对话用户数', totals['activeUserNum'], prevOrg['activeUserNum'], '人'),
        metricCard(
          'avgDialogPerUser',
          '人均对话次数',
          round1(Number(totals['dc']) / Math.max(Number(totals['activeUserNum']), 1)),
          round1(Number(prevOrg['dc']) / Math.max(Number(prevOrg['activeUserNum']), 1)),
          '次',
        ),
        metricCard('sessionCount', '会话数', totals['sc'], prevOrg['sc'], '个'),
        metricCard(
          'avgSessionRounds',
          '平均会话轮次',
          round2(Number(totals['dc']) / Math.max(Number(totals['sc']), 1)),
          round2(Number(prevOrg['dc']) / Math.max(Number(prevOrg['sc']), 1)),
          '轮',
        ),
      ],
    },
    charts: {
      charts: [
        {
          key: 'dialogByMode',
          title: '对话能力分布',
          type: 'donut',
          data: { items: MODES.map(([field, label]) => ({ label, value: totals[field] })) },
        },
        {
          key: 'dialogByModel',
          title: '按模型对话次数',
          type: 'bar',
          data: {
            items: [...modelMap.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([label, value]) => ({ label, value: round0(value) })),
          },
        },
      ],
    },
    trends: { series: trendSeries },
    dimension: { type: 'taskScene', label: '任务场景' },
  };
}

/** 等价 `analytics_completion`。 */
export function analyticsCompletion(
  ds: DataSource,
  start: string,
  end: string,
  userIds: Set<string> | null,
  deptIds: Set<string> | null,
): Row {
  const cur = ds.slice(start, end, userIds, deptIds);
  const [pStart, pEnd] = ds.previousRange(start, end);
  const prev = ds.slice(pStart, pEnd, userIds, deptIds);
  const t = cur.org as unknown as Row;
  const p = prev.org as unknown as Row;

  const langMap = new Map<string, Row>();
  for (const d of dateRange(start, end)) {
    for (const row of ds.index.byDay.get(d) ?? []) {
      if (userIds !== null && !userIds.has(row.u)) continue;
      const key = String(row.lg);
      let bucket = langMap.get(key);
      if (!bucket) {
        bucket = { cal: 0, cgl: 0, cg: 0, ca: 0 };
        langMap.set(key, bucket);
      }
      bucket['cal'] += Number(row.cal);
      bucket['cgl'] += Number(row.cgl);
      bucket['cg'] += Number(row.cg);
      bucket['ca'] += Number(row.ca);
    }
  }

  const langItems = [...langMap.entries()]
    .sort((a, b) => Number(b[1]['cal']) - Number(a[1]['cal']))
    .map(([lang, b]) => ({
      label: lang,
      value: b['cgl'] ? round2((Number(b['cal']) / Number(b['cgl'])) * 100) : 0,
      extra: { acceptLines: b['cal'], genLines: b['cgl'] },
    }));

  return {
    summary: {
      metrics: [
        metricCard('completionGenerateCount', '补全生成次数', t['cg'], p['cg'], '次'),
        metricCard('completionAcceptCount', '补全采纳次数', t['ca'], p['ca'], '次'),
        metricCard(
          'completionAcceptRateByCount',
          '采纳率（按次数）',
          t['completionAcceptRateByCount'] || 0,
          p['completionAcceptRateByCount'] || 0,
          '%',
        ),
        metricCard(
          'completionAcceptRateByLines',
          '采纳率（按行数）',
          t['completionAcceptRateByLines'] || 0,
          p['completionAcceptRateByLines'] || 0,
          '%',
        ),
        metricCard('completionAcceptLines', '采纳行数', t['cal'], p['cal'], '行'),
      ],
    },
    charts: {
      charts: [
        {
          key: 'completionByLanguage',
          title: '按语言采纳率（按行数）',
          type: 'bar',
          data: { items: langItems },
        },
      ],
    },
    trends: {
      series: [
        seriesPoint(
          'completionAcceptLines',
          '采纳行数',
          totalPairs(ds, start, end, 'cal', userIds),
          'bar',
        ),
        seriesPoint(
          'completionAcceptRateByLines',
          '采纳率',
          pairDaily(ds, start, end, 'cal', 'cgl', userIds).map(
            ([d, cal, cgl]): [string, number] => [d, cgl ? round2((cal / cgl) * 100) : 0],
          ),
          'line',
        ),
      ],
    },
    dimension: { type: 'language', label: '编程语言' },
  };
}

/** 等价 `analytics_generation`。 */
export function analyticsGeneration(
  ds: DataSource,
  start: string,
  end: string,
  userIds: Set<string> | null,
  deptIds: Set<string> | null,
): Row {
  const cur = ds.slice(start, end, userIds, deptIds);
  const [pStart, pEnd] = ds.previousRange(start, end);
  const prev = ds.slice(pStart, pEnd, userIds, deptIds);
  const t = cur.org as unknown as Row;
  const p = prev.org as unknown as Row;

  const deptBars = (Object.values(cur.departments) as MetricsRecord[])
    .map((v) => {
      const row = v as unknown as Row;
      const deptId = row['departmentId'];
      // 照抄 Python 的 `v.get("departmentId") and ...`：deptId 为假值时 label 直接取该假值
      const label = deptId
        ? ((ds.index.departments.get(String(deptId)) as unknown as Row | undefined)?.[
            'departmentName'
          ] ?? deptId)
        : deptId;
      return {
        label,
        value: row['codeGenerateRateByLines'] || 0,
        extra: {
          aiLines: row['aiCodeLines'],
          totalLines: row['totalNewCodeLines'],
          credit: row['credit'],
        },
      };
    })
    .sort((a, b) => Number(b.value) - Number(a.value));

  return {
    summary: {
      metrics: [
        metricCard('aiGenerateCodeLines', 'AI 生成代码行数', t['aiCodeLines'], p['aiCodeLines'], '行'),
        metricCard('totalNewCodeLines', '新增代码总行数', t['totalNewCodeLines'], p['totalNewCodeLines'], '行'),
        metricCard(
          'codeGenerateRateByLines',
          'AI 代码占比（按行数）',
          t['codeGenerateRateByLines'] || 0,
          p['codeGenerateRateByLines'] || 0,
          '%',
        ),
        metricCard(
          'codeGenerateRateByChars',
          'AI 代码占比（按字符）',
          t['codeGenerateRateByChars'] || 0,
          p['codeGenerateRateByChars'] || 0,
          '%',
        ),
        metricCard(
          'aiLinesPerActiveUser',
          '人均 AI 代码行数',
          t['avgAiLinesPerActiveUser'],
          p['avgAiLinesPerActiveUser'],
          '行',
        ),
      ],
    },
    charts: {
      charts: [
        {
          key: 'generateRateByDepartment',
          title: '各部门 AI 代码占比',
          type: 'bar',
          data: { items: deptBars },
        },
      ],
    },
    trends: {
      series: [
        seriesPoint(
          'totalNewCodeLines',
          '新增代码总行数',
          totalPairs(ds, start, end, 'tnl', userIds),
          'bar',
        ),
        seriesPoint(
          'aiGenerateCodeLines',
          'AI 生成代码行数',
          totalPairs(ds, start, end, 'ail', userIds),
          'bar',
        ),
        seriesPoint(
          'codeGenerateRateByLines',
          'AI 代码占比',
          pairDaily(ds, start, end, 'ail', 'tnl', userIds).map(
            ([d, a, total]): [string, number] => [d, total ? round2((a / total) * 100) : 0],
          ),
          'line',
        ),
      ],
    },
    dimension: { type: 'department', label: '部门' },
  };
}

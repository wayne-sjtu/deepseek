/**
 * 可观测域路由 —— 对应 Python `server.py` 的
 * `metric_summary` / `_metric` / `metric_trend` / `metric_records`。
 *
 * 对应 `/api/enterprises/{eid}/openapi/observability/{metric-summary|metric-trend|metric-records}/query`。
 *
 * 时区：Python 侧 `TZ = timezone(timedelta(hours=8))`，即 **UTC+8**。
 * 这里的 unix 秒 ⇄ 日期换算必须带 +8 偏移，否则日期会整体差一天。
 */

import type { DataSource } from '../datasource.ts';
import { METRIC_WHITELIST, ROW_DIM_FIELD, metricValue, dailyPoints, dateRange, bucketSecondsFor } from '../metrics.ts';
import { pyRound, round2 } from '../pyround.ts';
import type { Row } from './shared.ts';

/** 指标名不在白名单 / 参数非法 —— 由路由层转成 400（对应 Python 的 `ValueError`）。 */
export class MetricValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricValidationError';
  }
}

const TZ_OFFSET_SECONDS = 8 * 3600;

/** 等价 `datetime.fromtimestamp(sec, TZ).date().isoformat()`。 */
function unixToDateTz(sec: number): string {
  return new Date((sec + TZ_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

/** 等价 `datetime.fromisoformat(d).replace(tzinfo=TZ).timestamp()`（取整秒）。 */
function dateTzToUnix(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000 - TZ_OFFSET_SECONDS;
}

/** 等价 Python 的 `[m for m in metrics if m not in METRIC_WHITELIST]`。 */
function unknownMetrics(metrics: string[]): string[] {
  return metrics.filter((m) => !Object.prototype.hasOwnProperty.call(METRIC_WHITELIST, m));
}

/**
 * 等价 `_metric(name, slice_obj)`：从 `slice.org` 取指标值。
 *
 * 这里复用 `metrics.ts` 的 `metricValue`（而不是在路由层另写一套派生映射），
 * `extra` 的构造与 Python `_metric` 里的 `derived` 逐项对应。
 */
function metricOf(ds: DataSource, name: string, org: Row): [number, string] {
  const extra: Record<string, number> = {
    __tool_error_rate__: Number(org['toolErrorRate']) || 0.0,
    __token_usage__: Number(org['tokenUsage'] ?? 0),
    __user_count__: Number(org['activeUserNum'] ?? 0),
    __dau__: Number(org['dau'] ?? 0),
    __accept_line_rate__: Number(org['completionAcceptRateByLines']) || 0.0,
    __gen_line_rate__: Number(org['codeGenerateRateByLines']) || 0.0,
  };
  return metricValue(name, org as never, extra);
}

/** 等价 `metric_summary(payload)`。 */
export function metricSummary(ds: DataSource, payload: Row): Row {
  const metrics: string[] = payload?.['metrics'] ?? [];
  if (!metrics.length) throw new MetricValidationError('metrics 必填');
  if (metrics.length > 20) throw new MetricValidationError('metrics 最多 20 个');
  const unknown = unknownMetrics(metrics);
  if (unknown.length) throw new MetricValidationError(`指标名不在白名单: ${unknown.join(',')}`);

  const rng = payload?.['range'] ?? {};
  const start = unixToDateTz(Number(rng['start'] ?? 0));
  const end = unixToDateTz(Number(rng['end'] ?? 0));
  const userId = payload?.['userId'];
  const uidSet = userId ? new Set([String(userId)]) : null;
  const cur = ds.slice(start, end, uidSet);
  const [pStart, pEnd] = ds.previousRange(start, end);
  const prev = ds.slice(pStart, pEnd, uidSet);

  const fields: Row[] = [];
  for (const name of metrics) {
    const unit = METRIC_WHITELIST[name][1];
    const current = metricOf(ds, name, cur.org as unknown as Row)[0];
    const previous = metricOf(ds, name, prev.org as unknown as Row)[0];
    fields.push({
      key: name,
      value: round2(current),
      unit,
      momRate: previous
        ? pyRound((current - previous) / previous, 4)
        : current
          ? 1.0
          : null,
      compareValue: round2(previous),
    });
  }
  return { fields, range: { start, end } };
}

/** 等价 `metric_trend(payload)`。 */
export function metricTrend(ds: DataSource, payload: Row): Row {
  const metrics: string[] = payload?.['metrics'] ?? [];
  const unknown = unknownMetrics(metrics);
  if (unknown.length) throw new MetricValidationError(`指标名不在白名单: ${unknown.join(',')}`);

  const groupBy: string | null = payload?.['groupBy'] ?? null;
  const rng = payload?.['range'] ?? {};
  const start = unixToDateTz(Number(rng['start'] ?? 0));
  const end = unixToDateTz(Number(rng['end'] ?? 0));

  const lines: Row[] = [];
  for (const name of metrics) {
    const [fieldName, unit] = METRIC_WHITELIST[name];
    if (groupBy && Object.prototype.hasOwnProperty.call(ROW_DIM_FIELD, groupBy)) {
      const source = ROW_DIM_FIELD[groupBy];
      const buckets = new Map<string, Map<string, number>>();
      for (const day of dateRange(start, end)) {
        for (const row of (ds.index.byDay.get(day) ?? []) as unknown as Row[]) {
          const key = String(row[source]);
          let dayMap = buckets.get(key);
          if (!dayMap) {
            dayMap = new Map<string, number>();
            buckets.set(key, dayMap);
          }
          dayMap.set(day, (dayMap.get(day) ?? 0.0) + Number(row[fieldName]));
        }
      }
      for (const [key, dayMap] of buckets) {
        lines.push({
          metric: name,
          group: key,
          unit,
          points: [...dayMap.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .map(([d, v]) => ({ time: dateTzToUnix(d), value: round2(v) })),
        });
      }
    } else {
      // daily_points 在无 group 时用 "__total__" 作键；Python 里 group_by 为 None 也走这里
      const pairs = dailyPoints(ds.index, start, end, fieldName, groupBy, null);
      for (const [key, points] of Object.entries(pairs)) {
        let label = key;
        if (groupBy === 'department' && ds.index.departments.has(key)) {
          label = String((ds.index.departments.get(key) as unknown as Row)['departmentName']);
        }
        lines.push({
          metric: name,
          group: label,
          unit,
          points: points.map(([d, v]) => ({ time: dateTzToUnix(d), value: round2(v) })),
        });
      }
    }
  }

  const days = dateRange(start, end).length;
  return {
    bucketSeconds: bucketSecondsFor(days),
    granularity: payload?.['granularity'] ?? 'auto',
    groupBy,
    lines,
    range: { start, end },
  };
}

/** 等价 `metric_records(payload)`。 */
export function metricRecords(ds: DataSource, payload: Row): Row {
  const metrics: string[] = payload?.['metrics'] ?? [];
  const unknown = unknownMetrics(metrics);
  if (unknown.length) throw new MetricValidationError(`指标名不在白名单: ${unknown.join(',')}`);

  const rng = payload?.['range'] ?? {};
  const start = unixToDateTz(Number(rng['start'] ?? 0));
  const end = unixToDateTz(Number(rng['end'] ?? 0));
  const userId = payload?.['userId'];

  const records: Row[] = [];
  for (const day of dateRange(start, end)) {
    for (const row of (ds.index.byDay.get(day) ?? []) as unknown as Row[]) {
      if (userId && row['u'] !== userId) continue;
      const meta = (ds.index.members.get(String(row['u'])) ?? {}) as unknown as Row;
      const values: Row = {};
      for (const name of metrics) {
        const fieldName = METRIC_WHITELIST[name][0];
        values[name] = fieldName.startsWith('__') ? null : (row[fieldName] ?? null);
      }
      records.push({
        timestamp: dateTzToUnix(day),
        date: day,
        userId: row['u'],
        userName: meta['userName'] ?? null,
        departmentName: meta['primaryDepartmentName'] ?? null,
        model: row['md'],
        client: row['cl'],
        pluginVersion: row['pv'],
        language: row['lg'],
        metrics: values,
      });
    }
  }

  // Python: sort(key=(timestamp, userName or ""), reverse=True) —— 元组降序、相等保原序
  records.sort((a, b) => {
    if (a['timestamp'] !== b['timestamp']) return Number(b['timestamp']) - Number(a['timestamp']);
    const an = String(a['userName'] || '');
    const bn = String(b['userName'] || '');
    if (an < bn) return 1;
    if (an > bn) return -1;
    return 0;
  });

  const total = records.length;
  // 注意：Python 这里**没有**对 pageSize 做上下限收敛（与 metric_records 之外的接口不同）
  const pageSize = Number(payload?.['pageSize'] || 50);
  const page = Math.max(1, Number(payload?.['pageNum'] || 1));
  return {
    total,
    pageNum: page,
    pageSize,
    records: records.slice((page - 1) * pageSize, page * pageSize),
    range: { start, end },
  };
}

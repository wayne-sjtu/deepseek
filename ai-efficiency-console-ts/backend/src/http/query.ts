/**
 * 查询串解析 —— 等价 Python `urllib.parse.parse_qs`。
 *
 * 注意两点保真细节：
 *   1. Python 的 `parse_qs` **默认丢弃空值**（`keep_blank_values=False`），
 *      即 `?keyword=` 解析后不含 `keyword` 键。这里保持一致，
 *      因为下游大量使用 `query.get(k, [默认值])[0]` 的写法。
 *   2. 同名参数聚合成数组（`?a=1&a=2` → `{ a: ['1','2'] }`）。
 */

export type ParsedQuery = Record<string, string[]>;

export function parseQuery(search: string): ParsedQuery {
  const out: ParsedQuery = {};
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw) return out;
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
    const value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    if (value === '') continue; // 对齐 parse_qs 的 keep_blank_values=False
    (out[key] ??= []).push(value);
  }
  return out;
}

/** 等价 `query.get(key, [fallback])[0]`。 */
export function qGet(query: ParsedQuery, key: string, fallback = ''): string {
  const v = query[key];
  return v && v.length ? v[0]! : fallback;
}

/** 取全部同名参数值。 */
export function qAll(query: ParsedQuery, key: string): string[] {
  return query[key] ?? [];
}

import { useMemo, useState, type ReactNode } from 'react'
import { cx } from '../lib/format'

export interface Column<T> {
  key: string
  title: ReactNode
  /** 排序字段名；不传则该列不可排序 */
  sortKey?: string
  align?: 'left' | 'right' | 'center'
  width?: string
  /** 单元格渲染 */
  render: (row: T, index: number) => ReactNode
  /** 排序用的取值函数（默认取 row[sortKey]） */
  value?: (row: T) => number | string | null
  tooltip?: string
}

interface DataTableProps<T> {
  columns: Array<Column<T>>
  rows: T[]
  rowKey: (row: T) => string
  /** 受控排序（服务端排序时使用） */
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  onSortChange?: (sortBy: string, sortOrder: 'asc' | 'desc') => void
  /** 前端排序（本地数据，例如额度表） */
  localSort?: boolean
  defaultSort?: { key: string; order: 'asc' | 'desc' }
  onRowClick?: (row: T) => void
  highlightRow?: (row: T) => boolean
  maxHeight?: number
  empty?: ReactNode
}

function compare(a: number | string | null, b: number | string | null): number {
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'zh-CN')
}

/**
 * 数据表格。
 * 数值列默认右对齐 + 等宽字体，便于纵向扫读与横向比较（数字不跳位）。
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  sortBy,
  sortOrder = 'desc',
  onSortChange,
  localSort = false,
  defaultSort,
  onRowClick,
  highlightRow,
  maxHeight = 560,
  empty,
}: DataTableProps<T>) {
  const [localState, setLocalState] = useState(defaultSort ?? { key: '', order: 'desc' as const })

  const activeKey = localSort ? localState.key : sortBy
  const activeOrder = localSort ? localState.order : sortOrder

  const sorted = useMemo(() => {
    if (!localSort || !localState.key) return rows
    const column = columns.find((c) => c.sortKey === localState.key)
    if (!column) return rows
    const pick = column.value ?? ((row: T) => (row as Record<string, number | string | null>)[column.sortKey!])
    return [...rows].sort((a, b) => {
      const result = compare(pick(a), pick(b))
      return localState.order === 'desc' ? -result : result
    })
  }, [rows, localSort, localState, columns])

  const handleSort = (column: Column<T>) => {
    if (!column.sortKey) return
    const nextOrder: 'asc' | 'desc' =
      activeKey === column.sortKey && activeOrder === 'desc' ? 'asc' : 'desc'
    if (localSort) {
      setLocalState({ key: column.sortKey, order: nextOrder })
    } else {
      onSortChange?.(column.sortKey, nextOrder)
    }
  }

  const alignClass = (align?: string) =>
    align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'

  return (
    <div className="overflow-auto rounded-xl border border-white/[0.05]" style={{ maxHeight }}>
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-ink-800/95 backdrop-blur">
          <tr>
            {columns.map((column) => {
              const sortable = Boolean(column.sortKey)
              const active = activeKey === column.sortKey
              return (
                <th
                  key={column.key}
                  title={column.tooltip}
                  style={{ width: column.width }}
                  className={cx(
                    'whitespace-nowrap border-b border-white/[0.07] px-3 py-2.5 text-[12px] font-medium',
                    alignClass(column.align),
                    sortable ? 'cursor-pointer select-none hover:text-brand-300' : '',
                    active ? 'text-brand-300' : 'text-slate-400',
                  )}
                  onClick={() => handleSort(column)}
                >
                  <span className="inline-flex items-center gap-1">
                    {column.title}
                    {sortable && (
                      <span className={cx('text-[9px]', active ? 'opacity-100' : 'opacity-30')}>
                        {active && activeOrder === 'asc' ? '▲' : '▼'}
                      </span>
                    )}
                  </span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-xs text-slate-500">
                {empty ?? '当前筛选条件下没有数据'}
              </td>
            </tr>
          )}
          {sorted.map((row, index) => (
            <tr
              key={rowKey(row)}
              onClick={() => onRowClick?.(row)}
              className={cx(
                'border-b border-white/[0.04] transition-colors last:border-0',
                onRowClick && 'cursor-pointer',
                highlightRow?.(row) ? 'bg-brand-500/[0.07]' : 'hover:bg-white/[0.035]',
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cx(
                    'whitespace-nowrap px-3 py-2.5 text-[13px] text-slate-200',
                    alignClass(column.align),
                    column.align === 'right' && 'font-mono tabular-nums',
                  )}
                >
                  {column.render(row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

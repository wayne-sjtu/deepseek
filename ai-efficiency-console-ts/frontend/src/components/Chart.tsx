import { useEffect, useRef, type CSSProperties } from 'react'
import * as echarts from 'echarts'
import { cx } from '../lib/format'
import { alpha } from '../lib/theme'

/**
 * 使用 EChartsCoreOption（宽松版）而非 EChartsOption：
 * 页面里大量 option 由 useMemo 拼装，字面量类型会被 TS 放宽成 string，
 * 与 EChartsOption 的联合字面量类型冲突。运行期行为完全一致。
 */
type Option = echarts.EChartsCoreOption

interface ChartProps {
  /** ECharts option；组件内部以 notMerge 方式整体替换，避免脏数据残留 */
  option: Option
  height?: number | string
  className?: string
  style?: CSSProperties
  /** 数据更新时是否显示重绘动画 */
  animate?: boolean
  onReady?: (chart: echarts.ECharts) => void
}

/**
 * ECharts 轻封装。
 * - 按容器尺寸自适应（ResizeObserver），侧边栏折叠 / 窗口缩放都不会错位；
 * - 卸载时 dispose，避免多页面切换泄漏实例。
 */
export function Chart({ option, height = 260, className, style, animate = true, onReady }: ChartProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const instance = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    chartRef.current = instance
    onReady?.(instance)
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(ref.current)
    return () => {
      observer.disconnect()
      instance.dispose()
      chartRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!chartRef.current) return
    chartRef.current.setOption({ animation: animate, ...option }, true)
  }, [option, animate])

  return <div ref={ref} className={cx('w-full', className)} style={{ height, ...style }} />
}

export { alpha } from '../lib/theme'

/** 面积图渐变填充 */
export function areaGradient(hex: string, topOpacity = 0.35, bottomOpacity = 0.02) {
  return {
    type: 'linear' as const,
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: alpha(hex, topOpacity) },
      { offset: 1, color: alpha(hex, bottomOpacity) },
    ],
  }
}

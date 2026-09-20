import type { ReactNode } from 'react'
import { cx } from '../lib/format'

interface CardProps {
  children: ReactNode
  className?: string
  padded?: boolean
}

export function Card({ children, className, padded = true }: CardProps) {
  return (
    <section
      className={cx(
        'rounded-2xl border border-white/[0.06] bg-ink-850/70 shadow-card backdrop-blur-sm',
        padded && 'p-5',
        className,
      )}
    >
      {children}
    </section>
  )
}

interface CardHeaderProps {
  title: string
  subtitle?: string
  extra?: ReactNode
  className?: string
}

export function CardHeader({ title, subtitle, extra, className }: CardHeaderProps) {
  return (
    <header className={cx('mb-4 flex items-start justify-between gap-3', className)}>
      <div>
        <h3 className="text-[15px] font-semibold tracking-wide text-slate-100">{title}</h3>
        {subtitle && <p className="mt-1 text-xs leading-relaxed text-slate-400">{subtitle}</p>}
      </div>
      {extra && <div className="shrink-0">{extra}</div>}
    </header>
  )
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: 'neutral' | 'brand' | 'mint' | 'amber' | 'rose' | 'violet' | 'cyan'
  className?: string
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-slate-500/15 text-slate-300 ring-slate-500/25',
    brand: 'bg-brand-500/15 text-brand-300 ring-brand-500/30',
    mint: 'bg-mint-500/15 text-mint-400 ring-mint-500/30',
    amber: 'bg-amber-500/15 text-amber-400 ring-amber-500/30',
    rose: 'bg-rose-500/15 text-rose-400 ring-rose-500/30',
    violet: 'bg-violet-500/15 text-violet-400 ring-violet-500/30',
    cyan: 'bg-cyan-500/15 text-cyan-400 ring-cyan-500/30',
  }
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** 进度条，用于占比 / 使用率 */
export function ProgressBar({
  value,
  max = 100,
  tone = 'brand',
  height = 6,
  showTrack = true,
}: {
  value: number
  max?: number
  tone?: 'brand' | 'mint' | 'amber' | 'rose' | 'cyan' | 'violet' | 'slate'
  height?: number
  showTrack?: boolean
}) {
  const tones: Record<string, string> = {
    brand: 'bg-brand-500',
    mint: 'bg-mint-500',
    amber: 'bg-amber-500',
    rose: 'bg-rose-500',
    cyan: 'bg-cyan-500',
    violet: 'bg-violet-500',
    slate: 'bg-slate-500',
  }
  const percent = Math.max(0, Math.min(100, (value / (max || 1)) * 100))
  return (
    <div
      className={cx('w-full overflow-hidden rounded-full', showTrack && 'bg-white/[0.06]')}
      style={{ height }}
    >
      <div className={cx('h-full rounded-full transition-all duration-500', tones[tone])} style={{ width: `${percent}%` }} />
    </div>
  )
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      <div className="text-2xl opacity-40">{icon ?? '🗂'}</div>
      <p className="text-sm text-slate-300">{title}</p>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-slate-500">{hint}</p>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-lg bg-white/[0.06]', className)} />
}

export function LoadingBlock({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-xs text-slate-400">
      <span className="h-2 w-2 animate-ping rounded-full bg-brand-400" />
      {label}
    </div>
  )
}

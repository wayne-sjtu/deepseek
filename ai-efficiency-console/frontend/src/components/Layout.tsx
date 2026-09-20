import type { ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { cx } from '../lib/format'
import { dataMode } from '../lib/api'

const NAV_ITEMS = [
  { to: '/overview', label: '用量总览', icon: '◎', desc: '组织级消耗与产出' },
  { to: '/departments', label: '部门效能', icon: '▤', desc: '部门横向对比与下钻' },
  { to: '/members', label: '个人效能', icon: '☰', desc: '人效排行与明细' },
  { to: '/quota', label: '额度管理', icon: '◑', desc: '限量配置与风险预警' },
  { to: '/metrics', label: '指标口径', icon: '❖', desc: '定义、公式与数据来源' },
]

export function Sidebar() {
  const location = useLocation()
  return (
    <aside className="flex w-[212px] shrink-0 flex-col border-r border-white/[0.06] bg-ink-950/60">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-violet-500 text-sm font-bold text-white shadow-glow">
          AI
        </div>
        <div className="leading-tight">
          <p className="text-[13px] font-semibold text-slate-100">AI 效能运营台</p>
          <p className="text-[10px] tracking-wide text-slate-500">EFFICIENCY CONSOLE</p>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3">
        {NAV_ITEMS.map((item) => {
          const active = location.pathname.startsWith(item.to)
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={cx(
                'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors',
                active ? 'bg-brand-500/[0.14] text-slate-50' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200',
              )}
            >
              {active && <span className="absolute left-0 top-2.5 h-5 w-[3px] rounded-full bg-brand-400" />}
              <span className={cx('text-base', active ? 'text-brand-300' : 'text-slate-500')}>{item.icon}</span>
              <span className="flex-1">
                <span className="block font-medium leading-tight">{item.label}</span>
                <span className="block text-[10px] text-slate-500">{item.desc}</span>
              </span>
            </NavLink>
          )
        })}
      </nav>

      <div className="m-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-slate-300">
          <span className={cx('h-1.5 w-1.5 rounded-full', dataMode === 'mock' ? 'bg-amber-400' : 'bg-mint-400')} />
          数据源：{dataMode === 'mock' ? 'Mock' : 'Live OpenAPI'}
        </p>
        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
          接口未就绪阶段使用本地 Python 服务返回样例数据，字段口径与企业接口一致。
        </p>
      </div>
    </aside>
  )
}

export function PageShell({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="animate-fade-up">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-wide text-slate-50">{title}</h1>
          {description && <p className="mt-1 text-xs leading-relaxed text-slate-400">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-rose-500/30 bg-rose-500/[0.08] p-4">
      <p className="text-sm font-medium text-rose-300">数据加载失败</p>
      <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] leading-relaxed text-rose-200/80">{message}</pre>
      <p className="mt-3 text-[11px] text-slate-400">
        提示：先在项目根目录启动 Mock 服务 ——{' '}
        <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-slate-200">
          python3 backend/app/server.py --port 8000
        </code>
      </p>
    </div>
  )
}

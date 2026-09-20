import { Navigate, Route, Routes } from 'react-router-dom'
import { FilterBar } from './components/FilterBar'
import { ErrorBanner, Sidebar } from './components/Layout'
import { useScope } from './lib/ScopeContext'
import OverviewPage from './pages/OverviewPage'
import DepartmentsPage from './pages/DepartmentsPage'
import MembersPage from './pages/MembersPage'
import QuotaPage from './pages/QuotaPage'
import MetricsPage from './pages/MetricsPage'

export default function App() {
  const { error, overview } = useScope()

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="thin-scroll flex-1 overflow-y-auto px-6 pb-10 pt-5">
        <FilterBar />
        {error && !overview && <ErrorBanner message={error} />}
        {error && overview && (
          <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-2 text-[11px] text-amber-200">
            刷新失败，当前展示的是上一次成功获取的数据：{error.split('\n')[0]}
          </div>
        )}
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/departments" element={<DepartmentsPage />} />
          <Route path="/members" element={<MembersPage />} />
          <Route path="/members/:memberId" element={<MembersPage />} />
          <Route path="/quota" element={<QuotaPage />} />
          <Route path="/metrics" element={<MetricsPage />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </main>
    </div>
  )
}

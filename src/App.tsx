import { Routes, Route } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Organizations from './pages/Organizations'
import { AppShell } from './components/layout/AppShell'

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/organizations" element={<Organizations />} />
      </Routes>
    </AppShell>
  )
}

import type { ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Organizations from './pages/Organizations'
import Login from './pages/Login'
import { AppShell } from './components/layout/AppShell'
import { useAdmin } from './contexts/AdminContext'

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAdmin } = useAdmin()
  const location = useLocation()

  if (!isAdmin) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  return <>{children}</>
}

function ShellRoute({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <ShellRoute>
              <Dashboard />
            </ShellRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/organizations"
        element={
          <ProtectedRoute>
            <ShellRoute>
              <Organizations />
            </ShellRoute>
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

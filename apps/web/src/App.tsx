import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { AuthProvider } from './features/auth/AuthProvider'
import { RequireAuth } from './features/auth/RequireAuth'
import { isSupabaseConfigured } from './lib/supabase'
import { ConfigErrorPage } from './pages/ConfigErrorPage'
import { CloudPage } from './pages/CloudPage'
import { DashboardPage } from './pages/DashboardPage'
import { HostingPage } from './pages/HostingPage'
import { LoginPage } from './pages/LoginPage'
import { NotFoundPage } from './pages/NotFoundPage'

const queryClient = new QueryClient({
  // Actualisation automatique : au retour sur l'onglet, à la reconnexion réseau et périodiquement (voir lib/live.ts).
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, refetchOnReconnect: true } },
})

export default function App() {
  if (!isSupabaseConfigured) return <ConfigErrorPage />

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAuth />}>
              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route path="clouds/:cloudId" element={<CloudPage />} />
                <Route path="hostings/:hostingId" element={<HostingPage />} />
              </Route>
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}

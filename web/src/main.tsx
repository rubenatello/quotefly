import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from './components/theme/ThemeProvider.tsx'

const rootElement = document.getElementById('root')!

async function preloadPrerenderedRoute(path: string) {
  if (path === '/') return import('./pages/LandingPage.tsx')
  if (path === '/pricing') return import('./pages/PricingPage.tsx')
  if (path === '/services') return import('./pages/ServicesPage.tsx')
  if (path === '/solutions') return import('./pages/SolutionsPage.tsx')
  if (path === '/solutions/landscaping') return import('./pages/LandscapingSolutionsPage.tsx')
  if (path.startsWith('/solutions/')) return import('./pages/TradeSolutionsPage.tsx')
  if (path === '/about') return import('./pages/AboutPage.tsx')
  if (path === '/support') return import('./pages/SupportPage.tsx')
  if (path === '/privacy') return import('./pages/PrivacyPage.tsx')
  if (path === '/data-privacy') return import('./pages/DataPrivacyPage.tsx')
  if (path === '/terms') return import('./pages/TermsPage.tsx')
  if (path === '/cookies') return import('./pages/CookiePolicyPage.tsx')
  return undefined
}

async function bootstrap() {
  const prerenderedRoute = rootElement.dataset.prerenderedRoute
  if (prerenderedRoute) {
    try {
      // Keep the complete static page visible until its interactive route chunk
      // is ready. This avoids replacing useful content with a loading screen on
      // slow public-page connections while preserving the lightweight app shell.
      await preloadPrerenderedRoute(prerenderedRoute)
    } catch {
      // Let the regular React route boundary retry and surface a useful state.
    }
  }

  createRoot(rootElement).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>,
  )
}

void bootstrap()

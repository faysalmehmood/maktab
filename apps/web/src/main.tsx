import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { Toaster } from './components/ui/sonner';
import { initI18n } from './i18n';

const queryClient = new QueryClient({
  // No background polling: D1 reads are a daily quota (PLAN §8).
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 60_000 } },
});

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

await initI18n();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

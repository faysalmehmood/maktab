import './styles.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { Toaster } from './components/ui/sonner';
import { initI18n } from './i18n';
import { createQueryClient } from './lib/query-client';
import { startLogoutFlush } from './offline/logout';

const queryClient = createQueryClient();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

startLogoutFlush();
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

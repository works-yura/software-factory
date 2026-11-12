// Must run first: library modules read their translated labels when they load.
import './i18n';
import { ThemeProvider } from '@mastra/playground-ui/components/ThemeProvider';
import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { TooltipProvider } from '@mastra/playground-ui/components/Tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';

import { ApiConfigProvider } from '../api/config';
import { LanguageBoundary } from './i18n/LanguageBoundary';
import { createQueryClient } from '../query-client';
import { captureInstallPrompt } from './lib/pwa';
import { serverReachability } from './lib/serverReachability';
import { createAppRouter } from './router';
import './tailwind.css';

// Chromium fires `beforeinstallprompt` once, early in the page load and often
// before the signed-in shell that shows the install banner mounts.
captureInstallPrompt();

// Watch the page's own requests from the first one, so a server restart shows a banner
// (`ServerReachabilityBanner`) instead of requests failing silently.
serverReachability();

// The web app talks to the Mastra server same-origin (`baseUrl=""`): in prod
// the server serves this build itself, and in dev Vite proxies `/api` + `/auth`
// to :4111. The served index.html also carries `window.__MASTRACODE_CONFIG__`
// (injected by the server in prod, by the Vite plugin in dev) so the UI knows
// whether auth is enabled without probing `/auth/me`. A future React Native
// entry mounts the same providers with its own absolute base URL and fetch
// implementation.
const queryClient = createQueryClient();
const router = createAppRouter();

if (import.meta.env.DEV && import.meta.env.VITE_REACT_GRAB === 'true') {
  void import('react-grab');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="mastracode.theme">
      <TooltipProvider delayDuration={0}>
        <QueryClientProvider client={queryClient}>
          <ApiConfigProvider baseUrl="">
            <LanguageBoundary>
              <RouterProvider router={router} />
            </LanguageBoundary>
            <Toaster position="bottom-right" />
          </ApiConfigProvider>
        </QueryClientProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);

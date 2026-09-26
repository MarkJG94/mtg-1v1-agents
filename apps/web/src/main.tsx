import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { SocketProvider } from './live.js';
import { LiveSocket, socketUrl } from './socket.js';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000 } },
});
const socket = new LiveSocket({ url: socketUrl(window.location) });
socket.start();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SocketProvider socket={socket}>
        <App />
      </SocketProvider>
    </QueryClientProvider>
  </StrictMode>,
);

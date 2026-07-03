import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import WorkerPortal from './pages/worker/WorkerPortal';

// The worker is a separate HTML entry. Its router basename must match the URL
// it's actually served at on each host:
//   - GitHub Pages: BASE_URL = '/workflow-poc/'  → '/workflow-poc/worker.html'
//   - Vercel/local: BASE_URL = '/'               → '/worker' (clean rewrite),
//     but the raw '/worker.html' file is also reachable, so honor whichever
//     path the page was actually loaded with.
const base = import.meta.env.BASE_URL;
function resolveBasename() {
  if (base !== '/') return `${base}worker.html`;       // Pages
  const path = window.location.pathname;
  return path.startsWith('/worker.html') ? '/worker.html' : '/worker';  // Vercel/local
}
const workerBasename = resolveBasename();

export default function WorkerApp() {
  return (
    <BrowserRouter basename={workerBasename}>
      <Routes>
        <Route path="/" element={<WorkerPortal />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

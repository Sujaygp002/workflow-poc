import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Lazy-import all handlers (ES modules)
async function loadHandlers() {
  const [
    areaIntake,
    auth,
    orders,
    patientById,
    patients,
    referenceData,
    workItemComplete,
    workItems,
    workflowRunById,
    workflowRuns,
    workflows,
    bulkUpload,
  ] = await Promise.all([
    import('./api/area-intake/index.js'),
    import('./api/auth/index.js'),
    import('./api/orders/index.js'),
    import('./api/patients/[id].js'),
    import('./api/patients/index.js'),
    import('./api/reference-data/index.js'),
    import('./api/work-items/[taskRunId]/complete.js'),
    import('./api/work-items/index.js'),
    import('./api/workflow-runs/[id].js'),
    import('./api/workflow-runs/index.js'),
    import('./api/workflows/index.js'),
    import('./api/workflows/bulk-upload/start.js'),
  ]);

  return {
    areaIntake: areaIntake.default,
    auth: auth.default,
    orders: orders.default,
    patientById: patientById.default,
    patients: patients.default,
    referenceData: referenceData.default,
    workItemComplete: workItemComplete.default,
    workItems: workItems.default,
    workflowRunById: workflowRunById.default,
    workflowRuns: workflowRuns.default,
    workflows: workflows.default,
    bulkUpload: bulkUpload.default,
  };
}

// Wrap a Vercel-style handler for Express. Vercel uses req.query for URL params
// so dynamic-route params are copied from req.params into req.query.
function wrap(handler, paramMap = {}) {
  return (req, res) => {
    for (const [param, queryKey] of Object.entries(paramMap)) {
      req.query[queryKey] = req.params[param];
    }
    return handler(req, res);
  };
}

async function start() {
  const h = await loadHandlers();
  const app = express();

  // Health check for ALB
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // API routes (must come before static/SPA catch-all)
  app.all('/api/area-intake', wrap(h.areaIntake));
  app.all('/api/auth', wrap(h.auth));
  app.all('/api/orders', wrap(h.orders));
  app.all('/api/patients/:id', wrap(h.patientById, { id: 'id' }));
  app.all('/api/patients', wrap(h.patients));
  app.all('/api/reference-data', wrap(h.referenceData));
  app.all('/api/work-items/:taskRunId/complete', wrap(h.workItemComplete, { taskRunId: 'taskRunId' }));
  app.all('/api/work-items', wrap(h.workItems));
  app.all('/api/workflow-runs/:id', wrap(h.workflowRunById, { id: 'id' }));
  app.all('/api/workflow-runs', wrap(h.workflowRuns));
  app.all('/api/workflows/bulk-upload', wrap(h.bulkUpload));
  app.all('/api/workflows', wrap(h.workflows));

  // Serve the built frontend
  const distDir = path.join(__dirname, 'dist');
  app.use(express.static(distDir));

  // SPA routing: /worker* → worker.html, everything else → index.html
  app.get('/worker', (_req, res) => res.sendFile(path.join(distDir, 'worker.html')));
  app.get('/worker/*', (_req, res) => res.sendFile(path.join(distDir, 'worker.html')));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

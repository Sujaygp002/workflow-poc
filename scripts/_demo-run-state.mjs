import { getSql } from '../api/_lib/db.js';
const sql = getSql();
const runId = process.argv[2];
if (runId) {
  const run = await sql`SELECT id, status, source_label, total_items FROM workflow_runs WHERE id=${runId}`;
  console.log('RUN:', JSON.stringify(run));
  const tasks = await sql`SELECT step_id, task_key, actor, status, name FROM workflow_task_runs WHERE run_id=${runId} ORDER BY created_at`;
  console.log('TASKS:');
  for (const t of tasks) console.log('  ', t.status.padEnd(9), t.actor.padEnd(6), (t.name||t.task_key));
} else {
  const runs = await sql`SELECT id, status, source_label, total_items, created_at FROM workflow_runs ORDER BY created_at DESC LIMIT 8`;
  console.log('RECENT_RUNS:');
  for (const r of runs) console.log('  ', r.id, r.status.padEnd(9), r.source_label);
}
process.exit(0);

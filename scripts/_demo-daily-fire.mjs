// Off-camera: fire TODAY's daily run for the phase-1 workflow through the REAL
// tick endpoint by temporarily relaxing the trigger hour gate, then restoring it.
// No app code touched; only the def-row trigger hour is flipped and restored.
import { getSql } from '../api/_lib/db.js';
const sql = getSql();
const WF = 'cc-1783522521545';
const BASE = 'http://localhost:8791';

const mode = process.argv[2] || 'fire';
if (mode === 'relax') {
  await sql`UPDATE workflow_definitions SET definition = jsonb_set(definition, '{trigger,hour}', '0') WHERE id=${WF} AND active=true`;
  console.log('trigger hour -> 0');
} else if (mode === 'restore') {
  await sql`UPDATE workflow_definitions SET definition = jsonb_set(definition, '{trigger,hour}', '12') WHERE id=${WF} AND active=true`;
  console.log('trigger hour -> 12');
} else if (mode === 'fire') {
  await sql`UPDATE workflow_definitions SET definition = jsonb_set(definition, '{trigger,hour}', '0') WHERE id=${WF} AND active=true`;
  const res = await fetch(`${BASE}/api/workflow-runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'tick' }) });
  const body = await res.json();
  await sql`UPDATE workflow_definitions SET definition = jsonb_set(definition, '{trigger,hour}', '12') WHERE id=${WF} AND active=true`;
  console.log('TICK:', JSON.stringify(body));
}
process.exit(0);

import { getSql } from '../api/_lib/db.js';
const BASE='http://localhost:8791';
const sql = getSql();
const runId = process.argv[2];
async function login(){const r=await fetch(`${BASE}/api/auth`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'workerLogin',username:'demo-rcm-coordinator',password:'DemoWorker!2026'})});return (await r.json()).token;}
async function open(tok,id){const r=await fetch(`${BASE}/api/work-items`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({action:'open',taskRunId:id})});return r.json();}
async function complete(tok,runId,id,payload,notes=''){const r=await fetch(`${BASE}/api/work-items/${id}/complete`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({runId,notes,payload})});return {status:r.status,body:await r.json()};}
const tok = await login();
// fill task
let tasks = await sql`SELECT id, name, actor, status FROM workflow_task_runs WHERE run_id=${runId} AND status='active'`;
const fill = tasks.find(t=>/fill/i.test(t.name));
console.log('fill task:', fill?.name, fill?.id);
const of = await open(tok, fill.id);
const fr = {};
for (const a of of.actions) fr[a.id] = a.actionKey==='fill_missing_fields' ? {patient:{patient_info:{sex:'Female'},personal_information:{address:{street:'55 Demo Way, Chicago, IL 60601'}}},order:{},references:{}} : {confirmed:true};
const fd = await complete(tok, runId, fill.id, {actionResults:fr}, 'filled');
console.log('fill complete:', fd.status);
// wait for review
let review=null;
for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,500));const ts=await sql`SELECT id,name,status FROM workflow_task_runs WHERE run_id=${runId} AND status='active'`;review=ts.find(t=>/review/i.test(t.name));if(review)break;}
console.log('review task:', review?.name, review?.id);
const orv = await open(tok, review.id);
const rr={};for(const a of orv.actions)rr[a.id]=a.actionKey==='review_record'?{approved:true}:{confirmed:true};
const rd = await complete(tok, runId, review.id, {actionResults:rr}, 'approved');
console.log('review complete:', rd.status);
await new Promise(r=>setTimeout(r,1500));
const rs = await sql`SELECT status FROM workflow_runs WHERE id=${runId}`;
console.log('run status:', rs[0]?.status);
// proof
const items = await sql`SELECT patient_payload, order_payload FROM workflow_items WHERE run_id=${runId} ORDER BY item_index`;
const last = items[items.length-1];
const mrn = last.patient_payload?.admission_details?.MRN;
const orderNo = last.order_payload?.order_info?.order_number;
const pat = await sql`SELECT id,mrn FROM patients WHERE mrn=${mrn} LIMIT 1`;
const ord = await sql`SELECT id,order_number FROM orders WHERE order_number=${orderNo} LIMIT 1`;
console.log('PROOF patient:', JSON.stringify(pat), 'order:', JSON.stringify(ord));
process.exit(0);

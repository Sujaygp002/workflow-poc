import { getSql } from '../api/_lib/db.js';
const BASE='http://localhost:8791';
const sql = getSql();
const runId = process.argv[2];
const FILL = {
  'patient.patient_info.name':'Demo Patient (mid-run upload)','patient.patient_info.DOB':'1955-04-12',
  'patient.admission_details.MRN':'MRN-MIDRUN-TEST1','patient.patient_info.sex':'Female',
  'patient.personal_information.address.street':'55 Demo Way, Chicago, IL 60601',
  'patient.admission_details.SOC':'2026-06-01','patient.admission_details.EOC':'2026-07-30',
  'patient.admission_details.SOE':'2026-06-01','patient.admission_details.EOE':'2026-07-30',
  'order.order_info.order_number':'O-MIDRUN-TEST1','order.order_info.order_type':'485','order.order_info.order_date':'2026-06-02'};
function fillResult(values){const patient={},order={};const set=(r,path,v)=>{let c=r;for(let i=0;i<path.length-1;i++){c[path[i]]=c[path[i]]||{};c=c[path[i]];}c[path[path.length-1]]=v;};for(const[k,v]of Object.entries(values)){const p=k.split('.');const s=p.shift();if(s==='patient')set(patient,p,v);else if(s==='order')set(order,p,v);}return{patient,order,references:{}};}
async function login(){const r=await fetch(`${BASE}/api/auth`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'workerLogin',username:'demo-rcm-coordinator',password:'DemoWorker!2026'})});return (await r.json()).token;}
async function open(tok,id){return (await fetch(`${BASE}/api/work-items`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({action:'open',taskRunId:id})})).json();}
async function complete(tok,runId,id,payload,notes=''){const r=await fetch(`${BASE}/api/work-items/${id}/complete`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({runId,notes,payload})});return {status:r.status,body:await r.json()};}
const tok=await login();
const fill=(await sql`SELECT id,name FROM workflow_task_runs WHERE run_id=${runId} AND status='active' AND name ILIKE '%fill%' LIMIT 1`)[0];
const of=await open(tok,fill.id);const fr={};for(const a of of.actions)fr[a.id]=a.actionKey==='fill_missing_fields'?fillResult(FILL):{confirmed:true};
console.log('fill:',(await complete(tok,runId,fill.id,{actionResults:fr},'filled')).status);
let review=null;for(let i=0;i<24;i++){await new Promise(r=>setTimeout(r,500));review=(await sql`SELECT id,name FROM workflow_task_runs WHERE run_id=${runId} AND status='active' AND name ILIKE '%review%' LIMIT 1`)[0];if(review)break;}
if(!review){console.log('NO REVIEW - dumping tasks');const ts=await sql`SELECT name,status,output FROM workflow_task_runs WHERE run_id=${runId} ORDER BY created_at`;for(const t of ts)console.log(' ',t.status.padEnd(9),t.name, t.status==='failed'?JSON.stringify(t.output):'');process.exit(0);}
const orv=await open(tok,review.id);const rr={};for(const a of orv.actions)rr[a.id]=a.actionKey==='review_record'?{approved:true}:{confirmed:true};
console.log('review:',(await complete(tok,runId,review.id,{actionResults:rr},'approved')).status);
await new Promise(r=>setTimeout(r,1500));
console.log('run status:',(await sql`SELECT status FROM workflow_runs WHERE id=${runId}`)[0]?.status);
const pat=await sql`SELECT id,mrn FROM patients WHERE mrn='MRN-MIDRUN-TEST1' LIMIT 1`;
const ord=await sql`SELECT id,order_number FROM orders WHERE order_number='O-MIDRUN-TEST1' LIMIT 1`;
console.log('PROOF patient:',JSON.stringify(pat),'order:',JSON.stringify(ord));
process.exit(0);

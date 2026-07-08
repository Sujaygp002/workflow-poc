import { getSql } from '../api/_lib/db.js';
const BASE='http://localhost:8791';const sql=getSql();const runId=process.argv[2];
async function login(){return (await (await fetch(`${BASE}/api/auth`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'workerLogin',username:'demo-rcm-coordinator',password:'DemoWorker!2026'})})).json()).token;}
async function open(tok,id){return (await fetch(`${BASE}/api/work-items`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({action:'open',taskRunId:id})})).json();}
async function complete(tok,runId,id,payload){const r=await fetch(`${BASE}/api/work-items/${id}/complete`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({runId,notes:'',payload})});return {status:r.status,body:await r.json()};}
const tok=await login();
const c=(await sql`SELECT id,name FROM workflow_task_runs WHERE run_id=${runId} AND status='active' AND name ILIKE '%contact%' LIMIT 1`)[0];
const o=await open(tok,c.id);const res={};for(const a of o.actions){if(a.actionKey==='call_agency')res[a.id]={confirmed:true,note:'vm'};else if(a.actionKey==='sms_agency')res[a.id]={confirmed:true,note:'txt'};else if(a.actionKey==='email_agency')res[a.id]={to:'resources@ucodemint.com',subject:'Please upload',body:'Please upload today.',confirmed:true};else res[a.id]={confirmed:true};}
const d=await complete(tok,runId,c.id,{actionResults:res});
console.log('contact complete:',d.status,JSON.stringify(d.body).slice(0,160));
await new Promise(r=>setTimeout(r,1200));
console.log('run status:',(await sql`SELECT status FROM workflow_runs WHERE id=${runId}`)[0]?.status);
process.exit(0);

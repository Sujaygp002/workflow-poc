import { getSql } from '../api/_lib/db.js';
const BASE='http://localhost:8791'; const sql=getSql(); const WF='cc-1783522521545';
async function api(m,u,b){const r=await fetch(`${BASE}${u}`,{method:m,headers:b?{'Content-Type':'application/json'}:{},body:b?JSON.stringify(b):undefined});return {status:r.status,body:await r.json().catch(()=>({}))};}
async function delDaily(){const rs=await sql`SELECT id FROM workflow_runs WHERE source_label LIKE ${'daily:'+WF+':%'}`;for(const r of rs)await api('DELETE',`/api/workflow-runs/${r.id}`);}
async function fire(){await sql`UPDATE workflow_definitions SET definition=jsonb_set(definition,'{trigger,hour}','0') WHERE id=${WF} AND active=true`;const r=await api('POST','/api/workflow-runs',{action:'tick'});await sql`UPDATE workflow_definitions SET definition=jsonb_set(definition,'{trigger,hour}','12') WHERE id=${WF} AND active=true`;return r.body?.daily?.[0]?.runId;}
async function tasks(id){return sql`SELECT id,name,actor,status FROM workflow_task_runs WHERE run_id=${id} ORDER BY created_at`;}
async function wlogin(){return (await api('POST','/api/auth',{action:'workerLogin',username:'demo-rcm-coordinator',password:'DemoWorker!2026'})).body.token;}
async function open(tok,id){return (await fetch(`${BASE}/api/work-items`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({action:'open',taskRunId:id})})).json();}
async function complete(tok,runId,id,payload){const r=await fetch(`${BASE}/api/work-items/${id}/complete`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({runId,notes:'',payload})});return r.status;}
async function upload(){const tk=(await api('POST','/api/auth',{action:'externalLogin',username:'demo-rcm-hhah',password:'DemoAgency!2026'})).body.token;const fs=await import('node:fs');const FormData=(await import('node:buffer')).Blob?globalThis.FormData:null;const fd=new FormData();fd.append('workbook',new Blob([fs.readFileSync('/Users/sujaygp/Desktop/poc/docs/_demo-upload.xlsx')]),'_demo-upload.xlsx');fd.append('unsignedZip',new Blob([fs.readFileSync('/Users/sujaygp/Desktop/poc/docs/_demo-upload-unsigned.zip')]),'_demo-upload-unsigned.zip');fd.append('sourceLabel','demo-upload.xlsx');const r=await fetch(`${BASE}/api/workflows/bulk-upload/start`,{method:'POST',headers:{Authorization:`Bearer ${tk}`},body:fd});return (await r.json()).dailyReconcile;}

// S2: fire, complete contact, delete
await delDaily();
const r2 = await fire();
console.log('S2 run', r2);
const tok = await wlogin();
async function waitActive(id,re){for(let i=0;i<20;i++){const t=(await tasks(id)).find(x=>x.status==='active'&&re.test(x.name));if(t)return t;await new Promise(r=>setTimeout(r,400));}return null;}
const c = await waitActive(r2,/contact/i);
const o = await open(tok,c.id); const res={}; for(const a of o.actions){res[a.id]=a.actionKey==='email_agency'?{to:'resources@ucodemint.com',subject:'x',body:'y',confirmed:true}:{confirmed:true,note:'n'};}
console.log('S2 contact complete', await complete(tok,r2,c.id,{actionResults:res}));
await new Promise(r=>setTimeout(r,1000));
await api('DELETE',`/api/workflow-runs/${r2}`);
console.log('S2 run deleted');

// S3: fire fresh, upload
await delDaily();
const r3 = await fire();
console.log('S3 run', r3);
await new Promise(r=>setTimeout(r,500));
const rec = await upload();
console.log('S3 reconcile:', JSON.stringify(rec));
await new Promise(r=>setTimeout(r,3000));
const ts = await tasks(r3);
console.log('S3 tasks:'); for(const t of ts) console.log(' ',t.status.padEnd(9),t.name);
process.exit(0);

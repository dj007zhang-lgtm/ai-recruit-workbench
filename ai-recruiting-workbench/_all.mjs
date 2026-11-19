import http from 'node:http'
function post(cid){return new Promise((res,rej)=>{const body=JSON.stringify({candidateId:cid});const req=http.request('http://127.0.0.1:64136/api/ai-recruiting/deep-assess',{method:'POST',headers:{'Content-Type':'application/json'}},r=>{let t='';r.on('data',c=>t+=c);r.on('end',()=>{try{res(JSON.parse(t))}catch(e){res({error:t})}})});req.on('error',rej);req.write(body);req.end()})}
const get=()=>new Promise(res=>{http.get('http://127.0.0.1:64136/api/ai-recruiting/workbench',r=>{let t='';r.on('data',c=>t+=c);r.on('end',()=>res(JSON.parse(t)))}).on('error',res)})
const w=await get()
for(const c of w.candidates.filter(c=>c.pid)){const j=await post(c.id); if(j.ok)console.log(c.name.padEnd(8),j.diag.grade,j.diag.score,'|',(j.diag.alignment||[]).map(a=>a.level).join(''),'| 推进',j.advanced||'-');else console.log(c.name,'->',j.reason||j.error)}

import http from 'node:http'
function post(cid){return new Promise((res,rej)=>{const body=JSON.stringify({candidateId:cid});const req=http.request('http://127.0.0.1:64136/api/ai-recruiting/deep-assess',{method:'POST',headers:{'Content-Type':'application/json'}},r=>{let t='';r.on('data',c=>t+=c);r.on('end',()=>{try{res(JSON.parse(t))}catch(e){res({error:t})}})});req.on('error',rej);req.write(body);req.end()})}
const get=()=>new Promise(res=>{http.get('http://127.0.0.1:64136/api/ai-recruiting/workbench',r=>{let t='';r.on('data',c=>t+=c);r.on('end',()=>res(JSON.parse(t)))}).on('error',res)})
const w=await get()
const t=w.candidates.find(c=>c.name==='张义初')
for(let i=1;i<=2;i++){
  const j=await post(t.id)
  if(j.ok){const d=j.diag;console.log('第'+i+'次: grade='+d.grade+' score='+d.score+' 各采样档位='+JSON.stringify(d.sampleLevels)+' 推进='+(j.advanced||'-'))}
  else console.log('第'+i+'次:',j.reason||j.error)
}

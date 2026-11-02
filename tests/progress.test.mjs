import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createProgressHandler } from "../api/progress.mjs";
import { createProgressSync } from "../cloud-sync.mjs";

const campaign = JSON.parse(await readFile(new URL("../days.json", import.meta.url), "utf8"));
const origin = "https://advientochiquito.dpdns.org";
const accessKey = "a".repeat(64);
const env = {
  ALLOWED_ORIGIN:origin, PROGRESS_ACCESS_KEY:accessKey,
  GITHUB_TOKEN:"test-only-private-server-token", GITHUB_DATA_REPOSITORY:"fixture/private-data"
};
const draft = text => ({ opened:true, completed:false, draft:{drink:text} });
const clone = value => JSON.parse(JSON.stringify(value));
const json = (data, status = 200) => new Response(JSON.stringify(data), {status});

function completed(day){
  const mission = day.mission;
  const answers = {};
  if (mission.type === "form"){
    for (const field of mission.fields){
      answers[field.id] = field.type === "checkbox" ? true : field.type === "number" ? "10"
        : mission.checkField === field.id ? mission.answers[0] : field.options ? field.options[0].id : `Prueba ${field.id}`;
    }
  } else if (mission.type === "choice") answers.choice = mission.answer || mission.options[0].id;
  else if (mission.type === "puzzle") answers.answer = mission.answers[0];
  else answers.face = "3";
  return {
    opened:true, completed:true, draft:answers, answers, outcome:mission.success,
    bonus:mission.type === "dice" ? mission.results.find(result => result.face === 3).gold : 0,
    ...(mission.type === "dice" ? {roll:3} : {})
  };
}

function fixture(){
  const store = {file:null, sha:0, writes:0, calls:[], private:true, race:null};
  const request = async (url, options) => {
    store.calls.push({url, options});
    assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    const path = new URL(url).pathname;
    if (path === "/repos/fixture/private-data") return json({private:store.private, archived:false});
    assert.equal(path, `/repos/fixture/private-data/contents/progress/${campaign.campaign}.json`);
    if (options.method !== "PUT"){
      return store.file === null ? json({message:"Not Found"},404) : json({
        type:"file", encoding:"base64", size:Buffer.byteLength(store.file),
        sha:String(store.sha), content:Buffer.from(store.file).toString("base64")
      });
    }
    if (store.race){ const run = store.race; store.race = null; run(); return json({},409); }
    const body = JSON.parse(options.body);
    if ((body.sha || null) !== (store.file === null ? null : String(store.sha))) return json({},409);
    store.file = Buffer.from(body.content,"base64").toString("utf8");
    store.sha++;
    store.writes++;
    return json({},201);
  };
  const handler = createProgressHandler({env, campaign, fetch:request, now:() => new Date("2026-12-24T12:00:00Z")});
  async function call(method = "GET", body, headers = {}){
    const result = {headers:{}};
    const res = {
      statusCode:200,
      setHeader(name,value){ result.headers[name] = value; },
      end(value){ result.status = this.statusCode; result.body = value ? JSON.parse(value) : undefined; }
    };
    await handler({method, body, headers:{
      origin, authorization:`Bearer ${accessKey}`, "content-type":"application/json", ...headers
    }},res);
    return result;
  }
  async function put(changes){
    return call("PUT", {campaign:campaign.campaign, changes});
  }
  return {store, call, put};
}

test("Solo el enlace autorizado puede acceder; CORS no sustituye a la autenticación", async () => {
  const {store,call} = fixture();
  for (const authorization of ["",accessKey,"Bearer incorrecta"]){
    assert.equal((await call("GET",undefined,{authorization})).status,401);
  }
  assert.equal((await call("GET",undefined,{origin:"https://ajeno.example"})).status,403);
  assert.equal(store.calls.length,0);
  const preflight = await call("OPTIONS",undefined,{authorization:""});
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers["Access-Control-Allow-Origin"],origin);
  assert.equal(store.calls.length,0);
  assert.equal((await call("DELETE")).status,405);
});

test("Nunca escribe respuestas en un repositorio público", async () => {
  const {store,put} = fixture();
  store.private = false;
  const result = await put([{day:2,baseRevision:0,state:draft("Privado")}]);
  assert.equal(result.status,503);
  assert.equal(result.body.error,"private_repository_required");
  assert.equal(store.file,null);
});

test("Crea un JSON con los 24 pisos, sin credenciales y sin duplicar commits", async () => {
  const {store,call,put} = fixture();
  const initial = await call();
  assert.equal(initial.body.revision,0);
  assert.deepEqual(initial.body.records,[]);
  const changes = campaign.days.map(day => ({day:day.day,baseRevision:0,state:completed(day)}));
  const result = await put(changes);
  assert.equal(result.status,200);
  assert.equal(result.body.records.length,24);
  assert.equal(result.body.revision,1);
  assert.ok(result.body.records.every(entry => entry.revision === 1));
  assert.ok(!store.file.includes(accessKey) && !store.file.includes(env.GITHUB_TOKEN));
  assert.equal((await put(changes)).status,200);
  assert.equal(store.writes,1);
  assert.equal((await call()).headers["Cache-Control"],"no-store");
});

test("Inicializa el JSON vacío sin respuestas inventadas y sin commits repetidos", async t => {
  const server=fixture(), b=browser(server);
  t.after(()=>b.client.stop());
  await b.client.flush();
  assert.equal(b.statuses.at(-1),"saved");
  assert.deepEqual(JSON.parse(server.store.file).records,[]);
  assert.equal(server.store.writes,1);
  await b.client.flush();
  assert.equal(server.store.writes,1);
});

test("Rechaza datos inválidos antes de escribir", async () => {
  const {store,call,put} = fixture();
  const cases = [
    [{day:25,baseRevision:0,state:draft("Mal")}],
    [{day:2,baseRevision:-1,state:draft("Mal")}],
    [{day:2,baseRevision:0,state:null}],
    [{day:2,baseRevision:0,state:draft("Uno")},{day:2,baseRevision:0,state:draft("Dos")}],
    [{day:3,baseRevision:0,state:{...completed(campaign.days[2]),answers:{choice:"pipo"}}}],
    [{day:1,baseRevision:0,state:{...completed(campaign.days[0]),answers:{strength:"21"}}}]
  ];
  for (const changes of cases) assert.equal((await put(changes)).status,400);
  assert.equal((await call("PUT","{mal")).status,400);
  assert.equal((await call("PUT"," ".repeat(1024*1024+1))).status,413);
  assert.equal((await call("PUT",{},{"content-type":"text/plain"})).status,415);
  assert.equal(store.writes,0);
});

test("Una revisión antigua no reemplaza respuestas nuevas ni deja escrituras parciales", async () => {
  const {store,put} = fixture();
  await put([{day:2,baseRevision:0,state:draft("Primero")}]);
  await put([{day:2,baseRevision:1,state:draft("Más reciente")}]);
  const before = store.file;
  const result = await put([
    {day:4,baseRevision:0,state:{opened:true,completed:false,draft:{talent:"No se guardará parcialmente"}}},
    {day:2,baseRevision:1,state:draft("Antiguo")}
  ]);
  assert.equal(result.status,409);
  assert.equal(store.file,before);
});

test("Conserva respuestas completadas, tiradas y actividades realizadas", async () => {
  const {put,store} = fixture();
  const day1 = completed(campaign.days[0]);
  const day10 = {opened:true,completed:false,draft:{face:"3"},roll:3};
  const day14 = {...completed(campaign.days[13]),executed:true};
  await put([{day:1,baseRevision:0,state:day1},{day:10,baseRevision:0,state:day10},{day:14,baseRevision:0,state:day14}]);
  const before = store.file;
  const changed = clone(day1);
  changed.answers.warName = "Otro nombre";
  changed.draft.warName = "Otro nombre";
  assert.equal((await put([{day:1,baseRevision:1,state:changed}])).status,409);
  assert.equal((await put([{day:10,baseRevision:1,state:{...day10,roll:6}}])).status,409);
  assert.equal((await put([{day:14,baseRevision:1,state:{...day14,executed:false}}])).status,409);
  assert.equal(store.file,before);
});

test("Permite completar únicamente el reparto pendiente de un contrato antiguo", async () => {
  const {put} = fixture();
  const old = completed(campaign.days[0]);
  for (const id of ["strength","wit","charm"]){ delete old.answers[id]; delete old.draft[id]; }
  assert.equal((await put([{day:1,baseRevision:0,state:old}])).status,200);
  const updated = clone(old);
  for (const id of ["strength","wit","charm"]){ updated.answers[id]="10"; updated.draft[id]="10"; }
  assert.equal((await put([{day:1,baseRevision:1,state:updated}])).status,200);
});

test("Reintenta conflictos de GitHub sin perder pisos guardados por otra petición", async () => {
  const {store,put} = fixture();
  await put([{day:2,baseRevision:0,state:draft("Primero")}]);
  store.race = () => {
    const snapshot = JSON.parse(store.file);
    snapshot.revision++;
    snapshot.records.push({day:3,revision:1,state:{opened:true,completed:false,draft:{choice:"chispa"}}});
    store.file=JSON.stringify(snapshot);
    store.sha++;
  };
  const result=await put([{day:4,baseRevision:0,state:{opened:true,completed:false,draft:{talent:"Talento"}}}]);
  assert.equal(result.status,200);
  assert.deepEqual(result.body.records.map(entry=>entry.day),[2,3,4]);
});

test("No sobrescribe un JSON remoto corrupto", async () => {
  const {store,put}=fixture();
  store.file="{copia corrupta";
  const result=await put([{day:2,baseRevision:0,state:draft("No reemplazar")}]);
  assert.equal(result.status,503);
  assert.equal(store.file,"{copia corrupta");
});

function browser(server, local = new Map(), storage = new Map()){
  const statuses=[], tasks=new Map();
  let sequence=0;
  const timers={
    setTimeout(fn,delay){ const id=++sequence; tasks.set(id,{fn,delay}); return id; },
    clearTimeout(id){ tasks.delete(id); }
  };
  let fail=false, loseResponse=false, duringWrite=null, enabled=true;
  const request=async (url,options)=>{
    assert.equal(url,"https://fixture.vercel.app/api/progress");
    assert.equal(options.credentials,"omit");
    assert.equal(options.headers.Authorization,`Bearer ${accessKey}`);
    if(fail) throw new TypeError("Sin conexión");
    const response=await server.call(options.method,options.body,options.headers);
    if(options.method==="PUT"){
      duringWrite?.();
      duringWrite=null;
      if(loseResponse){ loseResponse=false; throw new TypeError("Respuesta perdida"); }
    }
    return response.status===204 ? new Response(null,{status:204}) : json(response.body,response.status);
  };
  const client=createProgressSync({
    endpoint:"https://fixture.vercel.app/api/progress",accessKey,campaign,request,timers,
    enabled:()=>enabled,
    storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
    readRecords:()=>new Map(local),
    restoreMissing(snapshot){ for(const entry of snapshot.records) if(!local.has(entry.day)) local.set(entry.day,entry.state); },
    onStatus:status=>statuses.push(status)
  });
  return {client,local,storage,statuses,tasks,
    offline(value){fail=value;}, loseNextResponse(){loseResponse=true;}, onWrite(fn){duringWrite=fn;},
    disable(){enabled=false;}
  };
}

test("Guardado automático, recuperación de pisos ausentes y copia local intacta", async t=>{
  const server=fixture(), first=browser(server,new Map([[2,draft("Respuesta automática")]]));
  t.after(()=>first.client.stop());
  await first.client.flush();
  assert.equal(first.statuses.at(-1),"saved");
  assert.equal(JSON.parse(server.store.file).records[0].state.draft.drink,"Respuesta automática");
  const second=browser(server);
  t.after(()=>second.client.stop());
  await second.client.flush();
  assert.deepEqual(second.local.get(2),first.local.get(2));
  assert.equal(server.store.writes,1);
});

test("Fallo de red: conserva el progreso y reintenta con espera", async t=>{
  const server=fixture(), b=browser(server,new Map([[2,draft("Fuera de línea")]]));
  t.after(()=>b.client.stop());
  b.offline(true);
  await b.client.flush();
  assert.equal(b.statuses.at(-1),"error");
  assert.equal(b.local.get(2).draft.drink,"Fuera de línea");
  assert.ok([...b.tasks.values()].some(task=>task.delay===5000));
  b.offline(false);
  await b.client.flush();
  assert.equal(b.statuses.at(-1),"saved");
  assert.equal(server.store.writes,1);
});

test("Los cambios durante el envío se guardan después, sin perder la última respuesta", async t=>{
  const server=fixture(), b=browser(server,new Map([[2,draft("Antes")]]));
  t.after(()=>b.client.stop());
  b.onWrite(()=>{b.local.set(2,draft("Durante"));b.client.schedule();});
  await b.client.flush();
  assert.equal(b.statuses.at(-1),"pending");
  await b.client.flush();
  assert.equal(b.statuses.at(-1),"saved");
  assert.equal(JSON.parse(server.store.file).records[0].state.draft.drink,"Durante");
});

test("Recargar después de perder la respuesta no duplica el guardado", async t=>{
  const server=fixture(), first=browser(server,new Map([[2,draft("Confirmación perdida")]]));
  t.after(()=>first.client.stop());
  first.loseNextResponse();
  await first.client.flush();
  assert.equal(first.statuses.at(-1),"error");
  const second=browser(server,first.local,first.storage);
  t.after(()=>second.client.stop());
  await second.client.flush();
  assert.equal(second.statuses.at(-1),"saved");
  assert.equal(server.store.writes,1);
});

test("Los conflictos entre dispositivos conservan ambas versiones, incluso tras recargar", async t=>{
  const server=fixture(), first=browser(server,new Map([[2,draft("Base")]]));
  t.after(()=>first.client.stop());
  await first.client.flush();
  await server.put([{day:2,baseRevision:1,state:draft("Otro dispositivo")}]);
  first.local.set(2,draft("Cambio local"));
  await first.client.flush();
  assert.equal(first.statuses.at(-1),"conflict");
  const second=browser(server,first.local,first.storage);
  t.after(()=>second.client.stop());
  await second.client.flush();
  assert.equal(second.statuses.at(-1),"conflict");
  assert.equal(second.local.get(2).draft.drink,"Cambio local");
  assert.equal(JSON.parse(server.store.file).records[0].state.draft.drink,"Otro dispositivo");
});

test("Cambiar al modo autor cancela la copia antes de cualquier envío", async t=>{
  const server=fixture(), b=browser(server,new Map([[2,draft("Solo prueba")]]));
  t.after(()=>b.client.stop());
  b.client.schedule();
  b.disable();
  await b.client.flush();
  assert.equal(b.statuses.at(-1),"preview");
  assert.equal(server.store.calls.length,0);
  assert.equal(b.tasks.size,0);
});

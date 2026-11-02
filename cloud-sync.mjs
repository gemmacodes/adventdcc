import { sameState, validateSnapshot } from "./campaign-state.mjs";

class SyncError extends Error {
  constructor(status){ super(`Copia privada: HTTP ${status}`); this.status = status; }
}

export function createProgressSync({
  endpoint, accessKey, campaign, storage, readRecords, restoreMissing, onStatus,
  request = globalThis.fetch, timers = globalThis, enabled = () => true
}){
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash){
    throw new Error("La copia privada necesita un endpoint HTTPS.");
  }
  if (!/^[a-zA-Z0-9_-]{43,128}$/.test(accessKey || "")) throw new Error("Falta la clave de acceso a la copia privada.");
  const cacheKey = `dcc_sync_${campaign.campaign}`;
  const saved = storage.getItem(cacheKey);
  let baseline = saved ? JSON.parse(saved) : {
    format:"adventdcc-progress", version:1, campaign:campaign.campaign,
    revision:0, updatedAt:new Date().toISOString(), records:[]
  };
  validateSnapshot(baseline, campaign);
  let timer = null, running = false, stopped = false, again = false, failures = 0, activeRequest = null;

  function stop(){
    stopped = true;
    timers.clearTimeout(timer);
    activeRequest?.abort();
  }

  function active(){
    if (stopped) return false;
    if (enabled()) return true;
    stop();
    onStatus("preview");
    return false;
  }

  async function exchange(method, changes){
    if (!active()) throw new Error("Sincronización desactivada.");
    const controller = new AbortController();
    activeRequest = controller;
    const timeout = timers.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await request(url.href, {
        method, credentials:"omit", cache:"no-store", signal:controller.signal,
        headers:{ Authorization:`Bearer ${accessKey}`, ...(changes ? { "Content-Type":"application/json" } : {}) },
        ...(changes ? { body:JSON.stringify({ campaign:campaign.campaign, changes }) } : {})
      });
      if (!active()) throw new Error("Sincronización desactivada.");
      if (response.status === 409){
        const conflict = await response.json();
        if (conflict.snapshot){
          validateSnapshot(conflict.snapshot, campaign);
          return { snapshot:conflict.snapshot, conflict:true };
        }
      }
      if (!response.ok) throw new SyncError(response.status);
      const snapshot = await response.json();
      validateSnapshot(snapshot, campaign);
      return { snapshot, conflict:false };
    } finally {
      timers.clearTimeout(timeout);
      if (activeRequest === controller) activeRequest = null;
    }
  }

  function reconcile(snapshot, acknowledged = []){
    const remote = validateSnapshot(snapshot, campaign);
    const known = validateSnapshot(baseline, campaign);
    const local = readRecords();
    const conflicts = [], changes = [];
    for (const change of acknowledged){
      const entry = remote.get(change.day);
      if (entry && sameState(entry.state, change.state)) known.set(change.day, entry);
    }
    for (const [day, state] of local){
      const entry = remote.get(day), previous = known.get(day);
      if (entry && sameState(state, entry.state)){
        known.set(day, entry);
      } else if ((entry?.revision || 0) === (previous?.revision || 0)){
        changes.push({ day, state, baseRevision:previous?.revision || 0 });
      } else {
        conflicts.push(day);
      }
    }
    const next = {
      ...snapshot, revision:Math.max(snapshot.revision, baseline.revision),
      records:[...known.values()].sort((a,b) => a.day - b.day)
    };
    storage.setItem(cacheKey, JSON.stringify(next));
    baseline = next;
    return { changes, conflicts };
  }

  function schedule(delay = 1500){
    if (!active()) return;
    onStatus("pending");
    if (running){ again = true; return; }
    timers.clearTimeout(timer);
    timer = timers.setTimeout(flush, delay);
  }

  async function flush(){
    if (!active()) return;
    if (running){ again = true; return; }
    timers.clearTimeout(timer);
    timer = null;
    running = true;
    again = false;
    let retryDelay = null, pending = false;
    onStatus("saving");
    try {
      const initial = await exchange("GET");
      if (!active()) return;
      restoreMissing(initial.snapshot);
      let result = reconcile(initial.snapshot);
      if (result.changes.length || (initial.snapshot.revision === 0 && !initial.snapshot.records.length)){
        const sent = result.changes;
        const response = await exchange("PUT", sent);
        if (!active()) return;
        result = reconcile(response.snapshot, response.conflict ? [] : sent);
      }
      failures = 0;
      pending = result.changes.length > 0;
      onStatus(result.conflicts.length ? "conflict" : pending ? "pending" : "saved");
    } catch(error){
      if (stopped) return;
      console.error("No se pudo confirmar la copia privada.", error.name, error.status || "");
      onStatus(error.status === 409 ? "conflict" : error.status === 401 ? "unauthorized" : "error");
      if (![400,401,403,409,413,415].includes(error.status)){
        retryDelay = Math.min(60000, 5000 * 2 ** Math.min(failures++, 4));
      }
    } finally {
      running = false;
      if (!stopped){
        if (again || pending) schedule(1500);
        else if (retryDelay !== null){
          // Mantener visible el fallo mientras se espera el siguiente intento.
          timer = timers.setTimeout(flush, retryDelay);
        }
      }
    }
  }

  return {
    start(){ schedule(0); },
    schedule,
    flush,
    stop
  };
}

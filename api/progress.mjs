import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sameState, validateCampaignRecord, validateSnapshot, validateTransition } from "../campaign-state.mjs";

const MAX_BYTES = 1024 * 1024;
class HttpError extends Error {
  constructor(status, code){ super(code); this.status = status; }
}

async function readBody(req){
  let source;
  if (req.body !== undefined){
    source = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of req){
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BYTES) throw new HttpError(413, "too_large");
      chunks.push(buffer);
    }
    source = Buffer.concat(chunks).toString("utf8");
  }
  if (!source || Buffer.byteLength(source) > MAX_BYTES) throw new HttpError(413, "too_large");
  try { return JSON.parse(source); }
  catch { throw new HttpError(400, "invalid_json"); }
}

export function createProgressHandler({ env, campaign, fetch:request = globalThis.fetch, now = () => new Date() }){
  return async function handler(req, res){
    const send = (status, data) => {
      res.statusCode = status;
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const key = env.PROGRESS_ACCESS_KEY;
      const repository = env.GITHUB_DATA_REPOSITORY;
      let origin;
      try { origin = new URL(env.ALLOWED_ORIGIN).origin; }
      catch { throw new HttpError(503, "not_configured"); }
      if (!key || !/^[a-zA-Z0-9_-]{43,128}$/.test(key) || !env.GITHUB_TOKEN
          || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository || "")
          || !/^[a-z0-9-]+$/.test(campaign.campaign)){
        throw new HttpError(503, "not_configured");
      }
      if (req.headers.origin !== origin) throw new HttpError(403, "origin_denied");
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
      if (req.method === "OPTIONS"){ send(204); return; }
      if (!["GET","PUT"].includes(req.method)){
        res.setHeader("Allow", "GET, PUT, OPTIONS");
        throw new HttpError(405, "method_not_allowed");
      }
      const supplied = /^Bearer ([a-zA-Z0-9_-]{43,128})$/.exec(req.headers.authorization || "")?.[1] || "";
      const digest = value => createHash("sha256").update(value).digest();
      if (!timingSafeEqual(digest(supplied), digest(key))) throw new HttpError(401, "unauthorized");

      const headers = {
        Authorization:`Bearer ${env.GITHUB_TOKEN}`, Accept:"application/vnd.github+json",
        "X-GitHub-Api-Version":"2022-11-28", "Content-Type":"application/json"
      };
      async function github(path, options = {}){
        const response = await request(`https://api.github.com/repos/${repository}${path}`, {
          ...options, headers, signal:AbortSignal.timeout(4000), cache:"no-store"
        });
        if ([403,429].includes(response.status)){
          res.setHeader("Retry-After", "60");
          throw new HttpError(503, "github_unavailable");
        }
        return response;
      }
      const repoResponse = await github("");
      if (!repoResponse.ok) throw new HttpError(503, "repository_unavailable");
      const repo = await repoResponse.json();
      if (repo.private !== true || repo.archived) throw new HttpError(503, "private_repository_required");
      const path = `/contents/progress/${campaign.campaign}.json`;
      const empty = () => ({
        format:"adventdcc-progress", version:1, campaign:campaign.campaign,
        revision:0, updatedAt:now().toISOString(), records:[]
      });
      async function readSnapshot(){
        const response = await github(`${path}?ref=main`);
        if (response.status === 404) return { snapshot:empty(), sha:null };
        if (!response.ok) throw new HttpError(503, "read_failed");
        const file = await response.json();
        if (file.type !== "file" || file.encoding !== "base64" || file.size > MAX_BYTES || !file.sha){
          throw new HttpError(503, "invalid_stored_data");
        }
        let snapshot;
        try {
          const bytes = Buffer.from(file.content, "base64");
          if (bytes.length > MAX_BYTES) throw new Error("Archivo demasiado grande.");
          snapshot = JSON.parse(bytes.toString("utf8"));
          validateSnapshot(snapshot, campaign);
        } catch { throw new HttpError(503, "invalid_stored_data"); }
        return { snapshot, sha:file.sha };
      }
      if (req.method === "GET"){
        const { snapshot } = await readSnapshot();
        send(200, snapshot);
        return;
      }
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json"){
        throw new HttpError(415, "json_required");
      }
      const body = await readBody(req);
      if (!body || body.campaign !== campaign.campaign || !Array.isArray(body.changes)
          || body.changes.length > campaign.days.length
          || new Set(body.changes.map(entry => entry?.day)).size !== body.changes.length){
        throw new HttpError(400, "invalid_changes");
      }
      for (const change of body.changes){
        const day = campaign.days.find(day => day.day === change?.day);
        if (!day || !Number.isSafeInteger(change.baseRevision) || change.baseRevision < 0){
          throw new HttpError(400, "invalid_changes");
        }
        try { validateCampaignRecord(day, change.state); }
        catch { throw new HttpError(400, "invalid_record"); }
      }
      for (let attempt = 0; attempt < 3; attempt++){
        const { snapshot, sha } = await readSnapshot();
        const records = validateSnapshot(snapshot, campaign);
        let changed = false;
        for (const change of body.changes){
          const previous = records.get(change.day);
          if (previous && sameState(previous.state, change.state)) continue;
          if ((previous?.revision || 0) !== change.baseRevision){
            send(409, { error:"conflict", snapshot });
            return;
          }
          try { validateTransition(campaign.days.find(day => day.day === change.day), previous?.state, change.state); }
          catch { throw new HttpError(409, "progress_regression"); }
          records.set(change.day, { day:change.day, revision:change.baseRevision + 1, state:change.state });
          changed = true;
        }
        if (!changed && sha !== null){ send(200, snapshot); return; }
        const next = {
          ...snapshot, revision:snapshot.revision + 1, updatedAt:now().toISOString(),
          records:[...records.values()].sort((a,b) => a.day - b.day)
        };
        if (!Number.isSafeInteger(next.revision)) throw new HttpError(503, "revision_limit");
        const source = JSON.stringify(next, null, 2) + "\n";
        if (Buffer.byteLength(source) > MAX_BYTES) throw new HttpError(413, "too_large");
        const response = await github(path, {
          method:"PUT",
          body:JSON.stringify({
            message:"Guarda el progreso de la incursión\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>",
            content:Buffer.from(source).toString("base64"), branch:"main", ...(sha ? { sha } : {})
          })
        });
        if ([409,422].includes(response.status)) continue;
        if (!response.ok) throw new HttpError(503, "write_failed");
        send(200, next);
        return;
      }
      res.setHeader("Retry-After", "5");
      throw new HttpError(503, "concurrent_write");
    } catch(error){
      const status = error instanceof HttpError ? error.status : 503;
      const code = error instanceof HttpError ? error.message : "service_unavailable";
      if (status >= 500) console.error("Servicio de copia privada:", code);
      send(status, { error:code });
    }
  };
}

export default async function handler(req, res){
  try {
    const campaign = JSON.parse(await readFile(new URL("../days.json", import.meta.url), "utf8"));
    await createProgressHandler({ env:process.env, campaign })(req, res);
  } catch {
    console.error("No se pudo cargar la campaña del servicio de copia privada.");
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error:"not_configured" }));
  }
}

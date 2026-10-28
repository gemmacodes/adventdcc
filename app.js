// ============================================================
//  DUNGEON CRAWLER — app logic
// ============================================================
const App = (() => {
  const cfg = window.CONFIG || {};
  const LS = window.localStorage;
  let DAYS = [];
  let current = null;
  let typing = false, skipType = false;

  // ---- author / preview mode -------------------------------
  // ?author=1 unlocks every door AND disables notifications (for you to test).
  // ?author=0 clears it.
  (function initAuthor(){
    const p = new URLSearchParams(location.search);
    if (p.get("author") === "1") LS.setItem("dcc_author", "1");
    if (p.get("author") === "0") LS.removeItem("dcc_author");
    // En modo autor empezamos siempre con un descenso limpio: borramos
    // los pisos abiertos/resueltos marcados durante las pruebas.
    if (LS.getItem("dcc_author") === "1"){
      Object.keys(LS).filter(key => /^dcc_(opened|solved)_/.test(key))
        .forEach(key => LS.removeItem(key));
    }
  })();
  const isAuthor = () => LS.getItem("dcc_author") === "1";

  // Vista previa: ?demo=N simula estar descendiendo en el piso N
  // (1..N-1 colapsados, N activo, N+1..24 sellados). Solo en modo autor.
  const DEMO = (() => {
    const v = new URLSearchParams(location.search).get("demo");
    const n = parseInt(v, 10);
    return (isAuthor() && n >= 1 && n <= 24) ? n : null;
  })();

  // Colapso: recordamos qué pisos ya se derrumbaron ante los ojos del
  // Mazmorrero para animar cada derrumbe una sola vez. ?collapse=N fuerza
  // la animación de un piso concreto (vista previa en modo autor).
  const FORCE_COLLAPSE = parseInt(new URLSearchParams(location.search).get("collapse"), 10);
  const collapsedSeen = new Set(
    (LS.getItem("dcc_collapsed_seen") || "").split(",").filter(Boolean).map(Number)
  );
  const saveSeen = () => LS.setItem("dcc_collapsed_seen", [...collapsedSeen].join(","));
  let lastGold = 0;

  // ---- date gating -----------------------------------------
  function unlockedThrough(){
    if (DEMO !== null) return DEMO;
    if (isAuthor()) return 24;
    const now = new Date();
    const y = cfg.decemberYear || now.getFullYear();
    if (now.getFullYear() < y) return 0;
    if (now.getFullYear() > y) return 24;
    if (now.getMonth() < 11) return 0;      // before December
    return Math.min(24, now.getDate());     // December N
  }

  // ---- persistence helpers ---------------------------------
  const k = (s) => `dcc_${s}`;
  const getFlag = (s) => LS.getItem(k(s)) === "1";
  const setFlag = (s) => LS.setItem(k(s), "1");
  const isOpened = (d) => getFlag(`opened_${d}`);
  const isSolved = (d) => getFlag(`solved_${d}`);
  const dayById  = (d) => DAYS.find(x => x.day === d);
  const isCleared = (day) => day.type === "riddle" ? isSolved(day.day) : isOpened(day.day);

  // ---- notifications (ntfy) --------------------------------
  function beacon(text){
    const n = cfg.notify;
    if (!n || !n.enabled || isAuthor()) return;
    if (!n.ntfyTopic || n.ntfyTopic.includes("REPLACE-ME")) return;
    const url = `${n.server || "https://ntfy.sh"}/${n.ntfyTopic}`;
    try {
      // Plain-text body = "simple" CORS request, no preflight needed.
      fetch(url, { method: "POST", body: text, keepalive: true }).catch(()=>{});
    } catch(e){ /* ignore */ }
  }

  // ---- tiny sound (WebAudio, no asset files) ---------------
  let actx = null;
  function tone(freq, dur, type, when, gain){
    try {
      actx = actx || new (window.AudioContext||window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type || "square"; o.frequency.value = freq;
      const t = actx.currentTime + (when||0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain||0.05, t+0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
      o.connect(g); g.connect(actx.destination);
      o.start(t); o.stop(t+dur+0.02);
    } catch(e){}
  }
  // ---- haptic feedback (vibración, solo móvil) -------------
  const haptic = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch(e){} };

  const sndOpen    = () => { tone(520,0.08,"square"); haptic(12); };
  const sndSuccess = () => { tone(660,0.1,"square",0); tone(880,0.12,"square",0.09); tone(1180,0.18,"square",0.2); haptic([25,35,70]); };
  const sndDeny    = () => { tone(180,0.14,"sawtooth",0,0.06); tone(120,0.18,"sawtooth",0.1,0.06); haptic([55,40,55]); };

  // ---- toast -----------------------------------------------
  let toastT;
  function toast(msg){
    const el = document.getElementById("toast");
    el.textContent = msg; el.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(()=>el.classList.remove("show"), 2600);
  }

  // ---- message markup --------------------------------------
  //  *text*  -> gold emphasis     ~text~ -> muted flag
  //  a line starting with ">>" becomes an Objective block
  function esc(s){ return s.replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
  function inline(raw){
    let s = esc(raw);
    s = s.replace(/\*([^*]+)\*/g, '<span class="em">$1</span>');
    s = s.replace(/~([^~]+)~/g, '<span class="flag">$1</span>');
    return s;
  }
  function parse(message){
    return (message || "").split(/\n{2,}/).map(block => {
      const t = block.trim();
      if (t.startsWith(">>")) {
        return { type:"obj", label:"Objetivo", html: inline(t.replace(/^>>\s*/, "")) };
      }
      return { type:"p", html: inline(t.replace(/\n/g, "<br>")) };
    });
  }

  // ---- typewriter ------------------------------------------
  function renderBody(message, animate){
    const host = document.getElementById("msgBody");
    host.innerHTML = "";
    const blocks = parse(message);
    const els = blocks.map(b => {
      let el;
      if (b.type === "obj"){
        el = document.createElement("div"); el.className = "obj";
        el.innerHTML = `<b>${b.label}</b><span class="txt"></span>`;
      } else {
        el = document.createElement("p"); el.innerHTML = `<span class="txt"></span>`;
      }
      host.appendChild(el);
      return el.querySelector(".txt");
    });

    if (!animate){
      els.forEach((t,i)=> t.innerHTML = blocks[i].html);
      return Promise.resolve();
    }

    typing = true; skipType = false;
    return new Promise(async (resolve) => {
      for (let i=0;i<blocks.length;i++){
        await typeInto(els[i], blocks[i].html);
        if (skipType) { for (let j=i;j<blocks.length;j++) els[j].innerHTML = blocks[j].html; break; }
      }
      typing = false; resolve();
    });
  }

  // type HTML char-by-char while keeping tags intact
  function typeInto(target, html){
    return new Promise(res => {
      let i = 0;
      const step = () => {
        if (skipType){ target.innerHTML = html; return res(); }
        i++;
        // advance past whole tags so markup isn't shown mid-type
        if (html[i-1] === "<"){ const close = html.indexOf(">", i); if (close>-1) i = close+1; }
        target.innerHTML = html.slice(0, i) + '<span class="caret">▍</span>';
        if (i < html.length){ setTimeout(step, 12); if (i%3===0) tone(1500,0.006,"square",0,0.012); }
        else { target.innerHTML = html; res(); }
      };
      step();
    });
  }

  // ---- calendar --------------------------------------------
  // Nombre temático del piso (tras el "·"), sin spoilear el título del mensaje.
  function floorName(day){
    const f = day.floor || day.title || "";
    return f.split("·").pop().trim();
  }

  function renderCalendar(){
    document.getElementById("crawlerName").textContent = cfg.crawlerName || "CRAWLER";
    document.getElementById("crawlerId").textContent = "MAZMORRERO N.º " + (cfg.crawlerId || "0");

    const grid = document.getElementById("grid");
    grid.innerHTML = "";
    const through = unlockedThrough();

    // Revelado progresivo: visibles los pisos hasta hoy + 1 piso SELLADO
    // (teaser) que aparece solo cuando el piso activo ya está resuelto.
    const currentDay = DAYS.find(x => x.day === through);
    const currentCleared = DEMO !== null ? false
      : (currentDay ? isCleared(currentDay) : false);
    const showTeaser = DEMO !== null ? true : currentCleared;
    const maxVisible = Math.min(24, through + (showTeaser ? 1 : 0));

    let cleared = 0, gold = 0, activeEl = null;
    DAYS.forEach(day => {
      const d = day.day;
      if (d > maxVisible) return;

      const collapsed = d < through;
      const active = d === through;
      const sealed = d > through;
      const clearedForGold = DEMO !== null ? collapsed : isCleared(day);
      if (clearedForGold){ cleared++; gold += (day.reward && day.reward.gold) || 0; }

      const el = document.createElement("div");
      let cls = "door";
      if (sealed) cls += " locked";
      else if (collapsed) cls += " done";
      else cls += " today";
      const activeDone = active && (DEMO !== null ? false : isCleared(day));
      if (activeDone) cls += " cleared";
      if (collapsed){
        const forced = (d === FORCE_COLLAPSE);
        const newly = !collapsedSeen.has(d);
        if (newly){ collapsedSeen.add(d); saveSeen(); }
        if (forced || (!isAuthor() && newly)){ cls += " collapsing"; haptic([10,25,10]); }
      }
      if (day.type === "riddle" || (day.reward && day.reward.loot)) cls += " loot";
      el.className = cls;

      let state, stat;
      if (sealed){ state = "SELLADO"; stat = "🔒"; }
      else if (collapsed){ state = "COLAPSADO"; stat = "❌"; }
      else if (activeDone){ state = d === 24 ? "JEFE ABATIDO" : "COMPLETADO"; stat = "🏆"; }
      else { state = d === 24 ? "JEFE FINAL" : "DESCENDER"; stat = d === 24 ? "☠️" : "⚡️"; }

      el.innerHTML = active
        ? `<span class="plate">${d}</span>`
          + `<span class="finfo">`
          +   `<span class="fl">PISO ${d}</span>`
          +   `<span class="ftitle">${floorName(day)}</span>`
          +   `<span class="fstate">${state} ${stat}</span>`
          + `</span>`
        : `<span class="plate">${d}</span>`
          + `<span class="finfo"><span class="fl">PISO ${d}</span><span class="fstate">${state}</span></span>`
          + `<span class="stat">${stat}</span>`;

      el.onclick = () => {
        if (sealed){ el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake");
          sndDeny(); toast(`PISO ${d} SELLADO — se abre el ${d} de dic.`); return; }
        openDay(d);
      };
      grid.appendChild(el);
      if (active) activeEl = el;
    });

    // Lleva la vista al descenso actual (el piso recién revelado queda abajo).
    const target = grid.lastElementChild;
    if (target) requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "center" }));

    const pct = Math.round((cleared/24)*100);
    document.getElementById("meterFill").style.width = pct + "%";
    document.getElementById("floorsLabel").textContent = `PISOS COMPLETADOS: ${cleared} / 24`;
    animateCount(document.getElementById("goldLabel"), lastGold, gold, "CRÉDITOS: ");
    lastGold = gold;
    document.getElementById("hint").textContent = isAuthor()
      ? "MODO AUTOR · todos los pisos desbloqueados · notificaciones DESACTIVADAS"
      : "toca un piso iluminado · los pisos bloqueados se abren el día de diciembre que les toca";
  }

  // ---- open a day ------------------------------------------
  function showView(id){
    document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
    document.getElementById(id).classList.add("active");
    window.scrollTo(0,0);
  }

  function openDay(d){
    const day = dayById(d);
    if (!day) return;
    current = day;
    const firstOpen = !isOpened(d);

    document.getElementById("msgFloor").textContent = day.floor || `FLOOR ${d}`;
    document.getElementById("msgTitle").textContent = day.title || "";
    const hd = day.type === "riddle" ? "TRANSMISIÓN CIFRADA" : "NOTIFICACIÓN DEL SISTEMA";
    document.getElementById("msgHdText").textContent = hd;

    // riddle box
    const riddleBox = document.getElementById("riddleBox");
    const solved = isSolved(d);
    if (day.type === "riddle" && !solved){
      riddleBox.hidden = false;
      document.getElementById("ans").value = "";
      document.getElementById("wrong").classList.remove("show");
    } else {
      riddleBox.hidden = true;
    }

    // reward box
    renderReward(day, day.type !== "riddle" || solved);

    showView("message");
    sndOpen();

    // fire the open beacon once
    if (firstOpen){
      if (!isAuthor()) setFlag(`opened_${d}`);
      beacon(`🔓 ${cfg.crawlerName || "El Mazmorrero"} abrió el Piso ${d} — ${day.title || day.floor || ""}`.trim());
    }

    renderBody(day.message, firstOpen);
    renderCalendar(); // reflect "done" state for display days
  }

  function renderReward(day, visible){
    const box = document.getElementById("rewardBox");
    if (!day.reward || !visible){ box.hidden = true; return; }
    box.hidden = false;
    document.getElementById("rewardIcon").textContent = day.type === "riddle" ? "🎁" : "✨";
    document.getElementById("rewardKicker").textContent = "Logro Desbloqueado";
    document.getElementById("rewardName").textContent = day.reward.name || "";
    const bits = [];
    if (day.reward.gold) bits.push(`+${day.reward.gold} créditos`);
    if (day.reward.loot) bits.push(day.reward.loot);
    document.getElementById("rewardDetail").textContent = bits.join(" · ");
  }

  // ---- riddle check ----------------------------------------
  function norm(s){ return (s||"").toLowerCase().trim().replace(/[^\w\s]/g,"").replace(/\s+/g," "); }
  function checkAnswer(){
    if (!current) return;
    const guess = norm(document.getElementById("ans").value);
    const answers = (current.answers || []).map(norm);
    const wrong = document.getElementById("wrong");
    if (guess && answers.includes(guess)){
      if (!isAuthor()) setFlag(`solved_${current.day}`);
      document.getElementById("riddleBox").hidden = true;
      wrong.classList.remove("show");
      renderReward(current, true);
      sndSuccess();
      toast("ACCESO CONCEDIDO");
      beacon(`✅ ${cfg.crawlerName || "El Mazmorrero"} RESOLVIÓ el Piso ${current.day} — ${current.reward && current.reward.name || current.title || ""}`.trim());
      renderCalendar();
    } else {
      wrong.classList.add("show");
      sndDeny();
      const box = document.getElementById("riddleBox");
      box.classList.remove("shake"); void box.offsetWidth;
    }
  }

  function goHome(){ showView("calendar"); renderCalendar(); }

  // tap message to skip typewriter
  document.addEventListener("click", (e)=>{
    if (typing && document.getElementById("message").classList.contains("active")
        && !e.target.closest(".riddle") && !e.target.closest(".ghost") && !e.target.closest(".back")){
      skipType = true;
    }
  });
  // enter key submits riddle
  document.addEventListener("keydown", (e)=>{
    if (e.key === "Enter" && !document.getElementById("riddleBox").hidden) checkAnswer();
  });

  // ---- boot ------------------------------------------------
  // Contador de créditos animado -----------------------------
  function animateCount(el, from, to, prefix){
    if (from === to){ el.textContent = prefix + to.toLocaleString("es-ES"); return; }
    const dur = 750, t0 = performance.now();
    function step(t){
      const p = Math.min(1,(t-t0)/dur);
      const e = p < .5 ? 2*p*p : 1 - Math.pow(-2*p+2,2)/2;
      el.textContent = prefix + Math.round(from + (to-from)*e).toLocaleString("es-ES");
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Booteo del Sistema (una vez por sesión) ------------------
  function runBoot(done){
    const boot = document.getElementById("boot");
    const box  = document.getElementById("bootlines");
    if (!boot || !box){ done && done(); return; }
    const name = (cfg.crawlerName || "Samu").toUpperCase();
    const lines = [
      "> INICIANDO SISTEMA...",
      "> ENLAZANDO CON EL NÚCLEO DE LA MAZMORRA...",
      "> MAZMORRERO " + name + " — IDENTIDAD VERIFICADA",
      "> DESCENSO AUTORIZADO ▸"
    ];
    box.innerHTML = ""; boot.classList.add("show");
    let li = 0, ci = 0, skip = false;
    function finish(){
      boot.classList.add("glitch"); haptic([18,24,18,24,45]);
      setTimeout(()=>{
        boot.classList.remove("glitch");
        boot.classList.add("out"); haptic(60);
        setTimeout(()=>{ boot.classList.remove("show","out"); done && done(); }, 500);
      }, 340);
    }
    boot.onclick = () => { skip = true; };
    function step(){
      if (skip){ box.innerHTML = lines.map(l=>`<div>${l}</div>`).join(""); setTimeout(finish, 220); return; }
      if (li >= lines.length){ setTimeout(finish, 520); return; }
      let cur = box.children[li];
      if (!cur){ cur = document.createElement("div"); box.appendChild(cur); }
      if (ci <= lines[li].length){ cur.textContent = lines[li].slice(0, ci); ci++; setTimeout(step, 20); }
      else { li++; ci = 0; haptic(8); setTimeout(step, 170); }
    }
    step();
  }

  async function init(){
    try {
      const res = await fetch("days.json", { cache: "no-store" });
      const data = await res.json();
      DAYS = (data.days || []).slice().sort((a,b)=>a.day-b.day);
    } catch(e){
      document.getElementById("hint").textContent = "⚠ no se pudo cargar days.json";
      return;
    }
    renderCalendar();
    if ("serviceWorker" in navigator){ navigator.serviceWorker.register("sw.js").catch(()=>{}); }

    // Booteo del Sistema: una vez por pestaña (?boot=1 fuerza repetirlo).
    const force = /[?&]boot=1/.test(location.search);
    if (force) sessionStorage.removeItem("dcc_booted");
    if (!sessionStorage.getItem("dcc_booted")){
      sessionStorage.setItem("dcc_booted", "1");
      runBoot();
    }
  }
  init();

  return { goHome, checkAnswer };
})();

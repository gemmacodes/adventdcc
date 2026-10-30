// ============================================================
//  DUNGEON CRAWLER — app logic
// ============================================================
const App = (() => {
  const cfg = window.CONFIG || {};
  function text(key, values = {}){
    const template = key.split(".").reduce((value, part) => value?.[part], window.STRINGS);
    if (typeof template !== "string") throw new Error(`Texto no definido en strings.js: ${key}`);
    return template.replace(/\{(\w+)\}/g, (_, name) => {
      if (!Object.hasOwn(values, name)) throw new Error(`Falta el valor {${name}} en ${key}`);
      return String(values[name]);
    });
  }

  function applyStrings(){
    document.querySelectorAll("[data-text]").forEach(el => {
      el.textContent = text(el.dataset.text);
    });
    const attributes = { "data-label":"aria-label", "data-title":"title", "data-placeholder":"placeholder" };
    Object.entries(attributes).forEach(([data, attribute]) => {
      document.querySelectorAll(`[${data}]`).forEach(el => el.setAttribute(attribute, text(el.getAttribute(data))));
    });
  }

  const LS = window.localStorage;
  let DAYS = [];
  let campaignId = "";
  const records = new Map(), blockedDays = new Set();
  const attributeKeys = ["strength","wit","charm"];
  let activeLootTab = null;
  let current = null;
  let typing = false, skipType = false;
  let bodyGeneration = 0;
  const profileDefaults = {
    sound:true, haptics:true, typewriter:true,
    reducedMotion:window.matchMedia("(prefers-reduced-motion: reduce)").matches
  };
  const profile = { ...profileDefaults };
  let profileLoadError = false;
  try {
    Object.entries(profileDefaults).forEach(([key, fallback]) => {
      const saved = LS.getItem(`dcc_profile_${key}`);
      if (saved === null) return;
      if (typeof fallback === "boolean" && (saved === "true" || saved === "false")){
        profile[key] = saved === "true";
      } else {
        profileLoadError = true;
        console.warn("Valor de perfil no válido:", key);
      }
    });
  } catch(error){
    profileLoadError = true;
    console.error("No se pudo leer el perfil del mazmorrero.", error);
  }
  document.body.classList.toggle("reduced-motion", profile.reducedMotion);

  // ---- author / preview mode -------------------------------
  // ?author=1 unlocks every door AND disables notifications (for you to test).
  // ?author=0 clears it.
  (function initAuthor(){
    const p = new URLSearchParams(location.search);
    if (p.get("author") === "1") LS.setItem("dcc_author", "1");
    if (p.get("author") === "0") LS.removeItem("dcc_author");
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
  const saveSeen = () => {
    try { LS.setItem("dcc_collapsed_seen", [...collapsedSeen].join(",")); }
    catch(error){ console.warn("No se pudo guardar el registro de colapsos.", error); }
  };
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
  const stateFor = d => records.get(d) || { opened:false, completed:false, draft:{} };
  const isOpened = d => stateFor(d).opened;
  const dayById  = (d) => DAYS.find(x => x.day === d);
  const isCleared = day => stateFor(day.day).completed;
  const availableDays = () => DAYS.filter(day => day.day <= unlockedThrough());
  const completedDays = () => availableDays().filter(isCleared);
  const goldFor = day => isCleared(day) ? day.reward.gold + (stateFor(day.day).bonus || 0) : 0;
  const pendingExecution = day => day.mission.cooperative
    || (day.mission.private && stateFor(day.day).answers?.choice !== "decline");
  const storageKey = d => `dcc_${isAuthor() ? "preview" : "campaign"}_${campaignId}_${d}`;
  const campaignStorage = () => isAuthor() ? window.sessionStorage : LS;

  function attributeBonuses(){
    const bonuses = { strength:0, wit:0, charm:0 };
    for (const day of completedDays()){
      for (const [id, points] of Object.entries(day.reward.attributes || {})) bonuses[id] += points;
    }
    return bonuses;
  }

  function attributeRewardText(attributes){
    return Object.entries(attributes).filter(([, points]) => points > 0).map(([id, points]) =>
      text("message.rewardAttribute", { count:points, attribute:text(`profile.${id}`) }))
      .join(text("message.rewardSeparator"));
  }

  function validPointAllocation(mission, answers){
    const budget = mission.pointBudget;
    if (!budget || !answers) return false;
    return budget.fields.every(id => {
      const field = mission.fields.find(field => field.id === id);
      return typeof answers[id] === "string" && /^\d+$/.test(answers[id])
        && Number(answers[id]) >= field.min && Number(answers[id]) <= field.max;
    }) && budget.fields.reduce((sum, id) => sum + Number(answers[id]), 0) === budget.total;
  }

  function needsPointAllocation(day){
    return isCleared(day) && day.mission.pointBudget && !validPointAllocation(day.mission, stateFor(day.day).answers);
  }

  function loadCampaign(){
    let failed = false;
    for (const day of DAYS){
      try {
        const saved = campaignStorage().getItem(storageKey(day.day));
        if (saved === null) continue;
        const record = JSON.parse(saved);
        const validAnswers = value => value && typeof value === "object" && !Array.isArray(value)
          && Object.values(value).every(item => typeof item === "string" || typeof item === "boolean");
        if (!record || typeof record.opened !== "boolean" || typeof record.completed !== "boolean"
            || !validAnswers(record.draft) || (record.answers !== undefined && !validAnswers(record.answers))
            || (record.completed && (!record.opened || !record.answers || typeof record.outcome !== "string"))
            || (record.bonus !== undefined && (!Number.isInteger(record.bonus) || record.bonus < 0))
            || (record.roll !== undefined && (!Number.isInteger(record.roll) || record.roll < 1 || record.roll > 6))
            || (record.executed !== undefined && typeof record.executed !== "boolean")
            || (record.hints !== undefined && (!Number.isInteger(record.hints) || record.hints < 0))){
          throw new Error(`Registro no válido: piso ${day.day}`);
        }
        if (record.completed && day.mission.pointBudget
            && day.mission.pointBudget.fields.some(id => Object.hasOwn(record.answers, id))
            && !validPointAllocation(day.mission, record.answers)){
          throw new Error(`Reparto de puntos no válido: piso ${day.day}`);
        }
        records.set(day.day, record);
      } catch(error){
        console.error("No se pudo recuperar el registro de la misión.", error);
        blockedDays.add(day.day);
        failed = true;
      }
    }
    if (failed) toast(text("errors.campaignLoad"));
  }

  function saveState(d, patch){
    if (blockedDays.has(d)){ toast(text("mission.storageBlocked")); return false; }
    const next = { ...stateFor(d), ...patch };
    try {
      campaignStorage().setItem(storageKey(d), JSON.stringify(next));
      records.set(d, next);
      return true;
    } catch(error){
      console.error("No se pudo guardar la misión.", error);
      toast(text("errors.campaignSave"));
      return false;
    }
  }

  // ---- notifications (ntfy) --------------------------------
  function beacon(text){
    const n = cfg.notify;
    if (!n || !n.enabled || isAuthor()) return;
    if (!n.ntfyTopic || /REPLACE-ME|CAMBIAME/.test(n.ntfyTopic)) return;
    const url = `${n.server || "https://ntfy.sh"}/${n.ntfyTopic}`;
    try {
      // Plain-text body = "simple" CORS request, no preflight needed.
      fetch(url, { method: "POST", body: text, keepalive: true })
        .then(response => { if (!response.ok) throw new Error(`ntfy: ${response.status}`); })
        .catch(error => { console.error("No se pudo enviar el aviso.", error); toast(window.STRINGS.errors.notification); });
    } catch(error){
      console.error("No se pudo enviar el aviso.", error);
      toast(window.STRINGS.errors.notification);
    }
  }

  // ---- tiny sound (WebAudio, no asset files) ---------------
  let actx = null;
  function tone(freq, dur, type, when, gain){
    if (!profile.sound) return;
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
  const haptic = (p) => { try { if (profile.haptics && navigator.vibrate) navigator.vibrate(p); } catch(e){} };

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
        return { type:"obj", label:text("message.objective"), html: inline(t.replace(/^>>\s*/, "")) };
      }
      return { type:"p", html: inline(t.replace(/\n/g, "<br>")) };
    });
  }

  // ---- typewriter ------------------------------------------
  function renderBody(message, animate){
    const generation = ++bodyGeneration;
    const host = document.getElementById("msgBody");
    host.innerHTML = "";
    const blocks = parse(message);
    const els = blocks.map(b => {
      let el;
      if (b.type === "obj"){
        el = document.createElement("div"); el.className = "obj";
        el.innerHTML = `<b>${esc(b.label)}</b><span class="txt"></span>`;
      } else {
        el = document.createElement("p"); el.innerHTML = `<span class="txt"></span>`;
      }
      host.appendChild(el);
      return el.querySelector(".txt");
    });

    if (!animate || !profile.typewriter || profile.reducedMotion){
      els.forEach((t,i)=> t.innerHTML = blocks[i].html);
      return Promise.resolve();
    }

    typing = true; skipType = false;
    return new Promise(async (resolve) => {
      for (let i=0;i<blocks.length;i++){
        await typeInto(els[i], blocks[i].html, generation);
        if (generation !== bodyGeneration) return resolve();
        if (skipType) { for (let j=i;j<blocks.length;j++) els[j].innerHTML = blocks[j].html; break; }
      }
      typing = false; resolve();
    });
  }

  // type HTML char-by-char while keeping tags intact
  function typeInto(target, html, generation){
    return new Promise(res => {
      let i = 0;
      const step = () => {
        if (generation !== bodyGeneration) return res();
        if (skipType || !profile.typewriter || profile.reducedMotion){ target.innerHTML = html; return res(); }
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

  function renderCalendar(scrollToActive = false){
    document.getElementById("crawlerName").textContent = text("identity.name");
    document.getElementById("crawlerId").textContent = text("common.crawlerId", { id:text("identity.id") });

    const grid = document.getElementById("grid");
    grid.innerHTML = "";
    const through = unlockedThrough();

    // Revelado progresivo: visibles los pisos hasta hoy + 1 piso SELLADO
    // (teaser) que aparece solo cuando el piso activo ya está resuelto.
    const currentDay = DAYS.find(x => x.day === through);
    const currentCleared = currentDay ? isCleared(currentDay) : false;
    const showTeaser = DEMO !== null ? true : currentCleared;
    const maxVisible = Math.min(24, through + (showTeaser ? 1 : 0));

    const cleared = completedDays().length;
    const gold = completedDays().reduce((sum, day) => sum + goldFor(day), 0);
    DAYS.forEach(day => {
      const d = day.day;
      if (d > maxVisible) return;

      const collapsed = d < through;
      const active = d === through;
      const sealed = d > through;
      const el = document.createElement("button");
      el.type = "button";
      el.dataset.day = d;
      let cls = "door";
      if (sealed) cls += " locked";
      else if (collapsed) cls += " done";
      else cls += " today";
      const activeDone = active && isCleared(day);
      if (activeDone) cls += " cleared";
      if (collapsed){
        const forced = (d === FORCE_COLLAPSE);
        const newly = !collapsedSeen.has(d);
        if (newly){ collapsedSeen.add(d); saveSeen(); }
        if (forced || (!isAuthor() && newly)){ cls += " collapsing"; haptic([10,25,10]); }
      }
      if (day.mission.type === "puzzle" || day.reward.physical) cls += " loot";
      el.className = cls;

      let state, stat;
      if (sealed){ state = text("calendar.sealed"); stat = text("calendar.icons.sealed"); }
      else if (collapsed){
        state = text(isCleared(day) ? "calendar.completed" : "calendar.unfinished");
        stat = text(isCleared(day) ? "calendar.icons.completed" : "calendar.icons.collapsed");
      }
      else if (activeDone){ state = text(d === 24 ? "calendar.bossDefeated" : "calendar.completed"); stat = text("calendar.icons.completed"); }
      else {
        state = text(d === 24 ? "calendar.finalBoss" : "calendar.descend");
        stat = text(d === 24 ? "calendar.icons.finalBoss" : "calendar.icons.descend");
      }
      const floorLabel = text("calendar.floor", { day:d });

      el.innerHTML = active
        ? `<span class="plate">${d}</span>`
          + `<span class="finfo">`
          +   `<span class="fl">${esc(floorLabel)}</span>`
          +   `<span class="ftitle">${esc(floorName(day))}</span>`
          +   `<span class="fstate">${esc(state)} ${esc(stat)}</span>`
          + `</span>`
        : `<span class="plate">${d}</span>`
          + `<span class="finfo"><span class="fl">${esc(floorLabel)}</span><span class="fstate">${esc(state)}</span></span>`
          + `<span class="stat">${esc(stat)}</span>`;

      el.onclick = () => {
        if (sealed){ el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake");
          sndDeny(); toast(text("calendar.sealedNotice", { day:d })); return; }
        openDay(d);
      };
      grid.appendChild(el);
    });

    // Lleva la vista al descenso actual (el piso recién revelado queda abajo).
    const target = grid.lastElementChild;
    if (target && scrollToActive) requestAnimationFrame(() => {
      if (document.getElementById("calendar").classList.contains("active")){
        target.scrollIntoView({ behavior: profile.reducedMotion ? "auto" : "smooth", block: "center" });
      }
    });

    const pct = Math.round((cleared/24)*100);
    document.getElementById("meterFill").style.width = pct + "%";
    document.getElementById("floorsLabel").textContent = text("calendar.floors", { count:cleared });
    animateCount(document.getElementById("goldLabel"), lastGold, gold, "calendar.credits");
    lastGold = gold;
    document.getElementById("hint").textContent = text(isAuthor() ? "calendar.authorHint" : through === 0 ? "calendar.empty" : "calendar.hint");
  }

  // ---- open a day ------------------------------------------
  function showView(id){
    bodyGeneration++;
    typing = false;
    skipType = true;
    document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
    document.getElementById(id).classList.add("active");
    document.body.dataset.view = id;
    window.scrollTo(0,0);
  }

  function renderProfile(){
    document.getElementById("profileName").textContent = text("identity.name").toUpperCase();
    document.getElementById("profilePortrait").alt = text("profile.portraitAlt", { name:text("identity.name") });
    document.getElementById("profileId").textContent = text("common.crawlerId", { id:text("identity.id") });
    document.getElementById("profileBadge").textContent = text("profile.badge", {
      title:text("identity.title"), class:text("identity.class")
    });
    const cleared = completedDays();
    const gold = cleared.reduce((sum, day) => sum + goldFor(day), 0);
    document.getElementById("profileFloors").textContent = text("profile.floorCount", { count:cleared.length });
    document.getElementById("profileGold").textContent = gold.toLocaleString("es-ES");
    document.querySelectorAll("[data-profile]").forEach(input => {
      input.checked = profile[input.dataset.profile];
    });
    renderCampaignProfile();
  }

  function openProfile(){
    renderProfile();
    showView("profile");
    document.getElementById("profileHeading").focus({ preventScroll:true });
  }

  document.querySelectorAll("[data-profile]").forEach(input => {
    input.addEventListener("change", () => {
      const key = input.dataset.profile;
      const value = input.checked;
      try {
        LS.setItem(`dcc_profile_${key}`, String(value));
      } catch(error){
        console.error("No se pudo guardar el perfil del mazmorrero.", error);
        input.checked = profile[key];
        toast(text("errors.profileSave"));
        return;
      }
      profile[key] = value;
      document.body.classList.toggle("reduced-motion", profile.reducedMotion);
    });
  });

  function openDay(d){
    const day = dayById(d);
    if (!day || d > unlockedThrough()){ toast(text("mission.unavailable")); return; }
    current = day;
    const firstOpen = !isOpened(d);
    document.getElementById("msgFloor").textContent = day.floor || text("calendar.floor", { day:d });
    document.getElementById("msgTitle").textContent = day.title || "";
    const hd = text(day.mission.type === "puzzle" ? "message.encrypted" : "message.notification");
    document.getElementById("msgHdText").textContent = hd;
    showView("message");
    sndOpen();
    if (firstOpen && saveState(d, { opened:true })){
      beacon(text("notifications.opened", {
        name:text("identity.name"), day:d, title:day.title || day.floor || ""
      }).trim());
    }
    renderBody(day.message, firstOpen);
    renderMission(day);
    renderReward(day, isCleared(day));
    renderCalendar();
  }

  function renderReward(day, visible){
    const box = document.getElementById("rewardBox");
    if (!day.reward || !visible){ box.hidden = true; return; }
    box.hidden = false;
    document.getElementById("rewardIcon").textContent = text(day.reward.physical ? "message.giftIcon" : "message.achievementIcon");
    document.getElementById("rewardKicker").textContent = text("message.achievement");
    document.getElementById("rewardName").textContent = day.reward.name || "";
    const bits = [];
    bits.push(text("message.rewardCredits", { count:goldFor(day) }));
    if (day.reward.attributes) bits.push(attributeRewardText(day.reward.attributes));
    if (day.reward.title) bits.push(day.reward.title);
    if (day.reward.physical && !(day.mission.private && stateFor(day.day).answers?.choice === "decline")){
      bits.push(day.reward.physical);
    }
    document.getElementById("rewardDetail").textContent = bits.join(text("message.rewardSeparator"));
  }

  function node(tag, content, className){
    const el = document.createElement(tag);
    if (content !== undefined) el.textContent = content;
    if (className) el.className = className;
    return el;
  }

  function answerRows(day, answers, fieldIds){
    if (day.mission.private) return [[day.title, day.mission.options.find(option => option.id === answers.choice)?.label || ""]];
    if (day.mission.type === "choice"){
      return [[text("mission.choice"), day.mission.options.find(option => option.id === answers.choice)?.label || ""]];
    }
    if (day.mission.type === "dice") return [[text("mission.dice"), answers.face]];
    if (day.mission.type === "puzzle") return [];
    return (day.mission.fields || []).filter(field => (!fieldIds || fieldIds.includes(field.id))
      && answers[field.id] !== "" && answers[field.id] !== undefined)
      .map(field => [field.label, field.type === "checkbox" ? text("mission.accepted")
        : field.options ? field.options.find(option => option.id === answers[field.id])?.label || ""
        : answers[field.id]]);
  }

  function appendAnswers(host, rows){
    const list = node("dl");
    for (const [label, value] of rows){
      list.append(node("dt", label), node("dd", String(value)));
    }
    host.appendChild(list);
  }

  function appendJournal(host, days){
    if (!days.length){ host.append(node("p", text("profile.emptyJournal"), "profile-note")); return; }
    for (const day of days){
      const state = stateFor(day.day);
      const details = node("details", undefined, "campaign-entry");
      details.append(node("summary", `${text("calendar.floor", { day:day.day })} · ${day.title}`));
      appendAnswers(details, answerRows(day, state.answers));
      details.append(node("p", state.outcome));
      host.append(details);
    }
  }

  function renderCampaignProfile(){
    const completed = completedDays();
    const answersFor = id => completed.some(day => day.day === id) ? stateFor(id).answers : {};
    const contract = answersFor(1), dragon = answersFor(6);
    for (const [id, value] of [
      ["profileWarName", contract.warName ? text("profile.warName", { name:contract.warName }) : ""],
      ["profileMotto", contract.motto || ""]
    ]){
      const el = document.getElementById(id);
      el.textContent = value;
      el.hidden = !value;
    }
    const identity = document.getElementById("campaignIdentity");
    identity.replaceChildren();
    const identityRows = dayById(6) ? answerRows(dayById(6), dragon, ["dragonName","hair"]) : [];
    document.getElementById("identityDetails").hidden = !identityRows.length;
    if (identityRows.length) appendAnswers(identity, identityRows);

    const registration = completed.find(day => day.mission.pointBudget);
    const hasStats = !!registration && validPointAllocation(registration.mission, stateFor(registration.day).answers);
    const bonuses = attributeBonuses();
    const hasBonuses = Object.values(bonuses).some(points => points > 0);
    document.getElementById("profileStats").hidden = !hasStats;
    const earnedAttributes = document.getElementById("profileEarnedAttributes");
    earnedAttributes.hidden = hasStats || !hasBonuses;
    earnedAttributes.textContent = !hasStats && hasBonuses
      ? text("profile.earnedAttributes", { bonuses:attributeRewardText(bonuses) }) : "";
    document.getElementById("profileStatSetup").hidden = !registration || !needsPointAllocation(registration);
    if (hasStats){
      const base = stateFor(registration.day).answers;
      const totals = attributeKeys.map(id => Number(base[id]) + bonuses[id]);
      const scale = Math.max(20, Math.ceil(Math.max(...totals) / 10) * 10);
      for (const id of registration.mission.pointBudget.fields){
        const suffix = id[0].toUpperCase() + id.slice(1);
        const value = Number(base[id]) + bonuses[id];
        document.getElementById(`stat${suffix}Value`).textContent = text("profile.attributeValue", { value });
        const meter = document.getElementById(`stat${suffix}`);
        meter.max = scale;
        meter.value = value;
        document.getElementById(`stat${suffix}Breakdown`).textContent = text("profile.attributeBreakdown", {
          base:base[id], bonus:bonuses[id]
        });
      }
    }
    const facts = [];
    for (const [id, fields] of [[4,["talent"]],[6,["power","skill","weakness"]]]){
      const day = completed.find(day => day.day === id);
      if (day) facts.push(...answerRows(day, stateFor(id).answers, fields));
    }
    document.getElementById("profileAbilities").hidden = !facts.length;
    document.getElementById("attributesCard").hidden = !registration && !facts.length && !hasBonuses;
    const abilities = document.getElementById("campaignAbilities");
    abilities.replaceChildren();
    if (facts.length) appendAnswers(abilities, facts);

    const companion = completed.find(day => day.day === 13);
    document.getElementById("companionCard").hidden = !companion;
    const companionHost = document.getElementById("campaignCompanion");
    companionHost.replaceChildren();
    if (companion){
      const answers = stateFor(13).answers;
      const details = node("details", undefined, "profile-details companion-details");
      const summary = node("summary");
      summary.append(node("strong", answers.companion), node("span", answers.personality, "companion-personality"));
      details.append(summary);
      appendAnswers(details, answerRows(companion, answers, ["ability","flaw"]));
      if (companion.reward.physical) details.append(node("small", `${text("profile.physical")}: ${companion.reward.physical}`));
      companionHost.append(details);
    }

    const titles = document.getElementById("campaignTitles");
    const earnedTitles = completed.filter(day => day.reward.title).reverse();
    document.getElementById("lootTitlesTab").textContent = text("profile.collectionCount", {
      label:text("profile.titles"), count:earnedTitles.length
    });
    renderCollection(titles, earnedTitles, day => node("span", day.reward.title, "title-chip"), "profile.moreTitles", "title-chips");
    if (!earnedTitles.length) titles.append(node("p", text("profile.emptyTitles"), "profile-note"));

    const inventory = document.getElementById("campaignInventory");
    const items = completed.filter(day => day.reward.item && day.day !== 13 && !pendingExecution(day)
      && !(day.mission.private && stateFor(day.day).answers.choice === "decline")).reverse();
    document.getElementById("lootInventoryTab").textContent = text("profile.collectionCount", {
      label:text("profile.inventory"), count:items.length
    });
    renderCollection(inventory, items, day => {
      const entry = node("div", undefined, "inventory-row");
      entry.dataset.inventoryDay = day.day;
      const name = day.day === 20 && stateFor(24).completed && unlockedThrough() >= 24
        ? text("profile.unsealedItem") : day.reward.item;
      entry.append(node("strong", name), node("span", text("calendar.floor", { day:day.day })));
      return entry;
    }, "profile.moreItems");
    if (!items.length) inventory.append(node("p", text("profile.emptyInventory"), "profile-note"));
    document.getElementById("lootCard").hidden = !items.length && !earnedTitles.length;
    if (items.length || earnedTitles.length) selectLootTab(activeLootTab || (earnedTitles.length ? "titles" : "inventory"));

    const plans = completed.filter(pendingExecution);
    document.getElementById("plansCard").hidden = !plans.length;
    const pending = document.getElementById("campaignPlans");
    const executed = document.getElementById("campaignCompletedPlans");
    pending.replaceChildren();
    executed.replaceChildren();
    for (const day of plans){
      const done = stateFor(day.day).executed;
      const entry = node("details", undefined, "inventory-item plan-item");
      const summary = node("summary");
      summary.append(node("strong", day.reward.name), node("small", text(done ? "profile.executed" : "profile.pending")));
      entry.append(summary);
      const rows = answerRows(day, stateFor(day.day).answers,
        day.mission.fields?.filter(field => field.id !== day.mission.checkField).map(field => field.id));
      appendAnswers(entry, rows);
      if (day.reward.physical) entry.append(node("small", `${text("profile.physical")}: ${day.reward.physical}`));
      if (!done){
        const button = node("button", text("profile.markExecuted"), "ghost");
        button.type = "button";
        button.onclick = () => markExecuted(day);
        entry.append(button);
      }
      (done ? executed : pending).append(entry);
    }
    document.getElementById("completedPlans").hidden = !executed.childElementCount;
    document.getElementById("completedPlansSummary").textContent = text("profile.completedPlans", { count:executed.childElementCount });
  }

  function renderCollection(host, items, render, moreKey, className = ""){
    host.replaceChildren();
    const recent = node("div", undefined, className);
    items.slice(0, 3).forEach(item => recent.append(render(item)));
    host.append(recent);
    if (items.length <= 3) return;
    const details = node("details", undefined, "profile-details collection-more");
    details.append(node("summary", text(moreKey, { count:items.length - 3 })));
    const rest = node("div", undefined, className);
    items.slice(3).forEach(item => rest.append(render(item)));
    details.append(rest);
    host.append(details);
  }

  const lootTabs = [...document.querySelectorAll("[data-loot-tab]")];
  function selectLootTab(name, focus = false){
    activeLootTab = name;
    for (const tab of lootTabs){
      const selected = tab.dataset.lootTab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
      if (selected && focus) tab.focus();
    }
  }
  lootTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectLootTab(tab.dataset.lootTab));
    tab.addEventListener("keydown", event => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % lootTabs.length;
      else if (event.key === "ArrowLeft") next = (index + lootTabs.length - 1) % lootTabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = lootTabs.length - 1;
      else return;
      event.preventDefault();
      selectLootTab(lootTabs[next].dataset.lootTab, true);
    });
  });

  document.getElementById("setAttributes").onclick = () => openDay(1);

  function missionAnswers(){
    const answers = {};
    for (const control of document.querySelectorAll("#missionFields [name]")){
      if (control.type === "radio"){
        if (!(control.name in answers)) answers[control.name] = "";
        if (control.checked) answers[control.name] = control.value;
      } else {
        answers[control.name] = control.type === "checkbox" ? control.checked : control.value.trim();
      }
    }
    return answers;
  }

  function updateRequired(answers){
    for (const field of current.mission.fields || []){
      const input = document.getElementById(`mission-${field.id}`);
      input.required = field.required !== false || !!(field.requiredWhen
        && answers[field.requiredWhen.field] === field.requiredWhen.value);
    }
  }

  function updatePointCount(mission, answers){
    if (!mission.pointBudget) return;
    const count = mission.pointBudget.fields.reduce((sum, id) => sum + Number(answers[id] || 0), 0);
    document.getElementById("missionPointCount").textContent = text("mission.pointsAllocated", {
      count, total:mission.pointBudget.total
    });
  }

  function renderMission(day){
    const mission = day.mission, state = stateFor(day.day), done = state.completed;
    const form = document.getElementById("missionForm"), host = document.getElementById("missionFields");
    const settingPoints = needsPointAllocation(day);
    const values = done ? settingPoints ? { ...state.answers, ...state.draft } : state.answers : state.draft;
    form.hidden = blockedDays.has(day.day);
    host.replaceChildren();
    if (day.reward.attributes && !done){
      host.append(node("p", text("mission.attributeReward", {
        bonuses:attributeRewardText(day.reward.attributes)
      }), "mission-bonus"));
    }
    document.getElementById("missionError").hidden = true;
    const recap = document.getElementById("missionRecap");
    recap.replaceChildren();
    if (mission.recap){
      const details = node("details");
      details.append(node("summary", text("mission.recap")));
      const content = node("div", undefined, "campaign-list");
      const previous = completedDays().filter(previousDay => previousDay.day < day.day);
      if (!previous.length) content.append(node("p", text("mission.noRecap")));
      else {
        for (const previousDay of previous){
          content.append(node("p", previousDay.reward.item || previousDay.reward.name));
          if (previousDay.reward.title) content.append(node("small", previousDay.reward.title));
        }
        appendJournal(content, previous);
      }
      details.append(content);
      recap.append(details);
    }
    function addField(field, parent = host){
      const label = node("label", undefined, `mission-field${field.type === "checkbox" ? " checkbox-field" : ""}`);
      const input = node(field.options ? "select" : field.type === "textarea" ? "textarea" : "input");
      input.id = `mission-${field.id}`;
      input.name = field.id;
      label.htmlFor = input.id;
      if (field.options){
        const blank = node("option", text("mission.choice"));
        blank.value = "";
        input.append(blank);
        for (const option of field.options){
          const el = node("option", option.label);
          el.value = option.id;
          input.append(el);
        }
      } else if (input.tagName === "INPUT"){
        input.type = field.type === "checkbox" ? "checkbox" : field.type === "number" ? "number" : "text";
      }
      if (field.maxLength) input.maxLength = field.maxLength;
      if (input.type === "number"){
        input.min = String(field.min ?? 1);
        input.max = String(field.max ?? 6);
        input.step = "1";
      }
      input.required = field.required !== false;
      if (field.id === "answer") input.placeholder = text("message.answerPlaceholder");
      input.disabled = done && !(settingPoints && mission.pointBudget.fields.includes(field.id));
      if (input.type === "checkbox") input.checked = values[field.id] === true;
      else input.value = values[field.id] || "";
      if (field.id === "face" && state.roll){ input.value = state.roll; input.readOnly = true; }
      if (field.type === "checkbox") label.append(input, node("span", field.label));
      else label.append(node("span", field.label), input);
      parent.append(label);
    }
    if (mission.type === "form"){
      let pointFields;
      for (const field of mission.fields){
        if (mission.pointBudget?.fields.includes(field.id)){
          if (!pointFields){
            const group = node("fieldset", undefined, "mission-points");
            group.append(node("legend", text("mission.pointsHeading")));
            group.append(node("p", text("mission.pointsRule", { total:mission.pointBudget.total }), "profile-note"));
            pointFields = node("div", undefined, "point-grid");
            group.append(pointFields);
            const count = node("p", undefined, "point-count");
            count.id = "missionPointCount";
            count.setAttribute("aria-live", "polite");
            group.append(count);
            host.append(group);
          }
          addField(field, pointFields);
        } else addField(field);
      }
    }
    if (mission.type === "puzzle") addField({ id:"answer", label:text("message.answerLabel"), maxLength:200 });
    if (mission.type === "choice"){
      const group = node("fieldset", undefined, "mission-choices");
      group.append(node("legend", text("mission.choice")));
      for (const option of mission.options){
        const label = node("label", undefined, "mission-option");
        const input = node("input");
        input.type = "radio";
        input.name = "choice";
        input.value = option.id;
        input.required = true;
        input.checked = values.choice === option.id;
        input.disabled = done;
        label.append(input, node("span", option.label));
        group.append(label);
      }
      host.append(group);
    }
    if (mission.type === "dice"){
      addField({ id:"face", label:text("mission.dice"), type:"number" });
      if (!done){
        const button = node("button", text("mission.roll"), "ghost");
        button.type = "button";
        button.disabled = !!state.roll;
        button.onclick = () => {
          if (stateFor(day.day).roll) return;
          const roll = Math.floor(Math.random() * 6) + 1;
          if (saveState(day.day, { roll, draft:{ face:String(roll) } })) renderMission(day);
        };
        host.append(button);
      }
      host.append(node("p", text("mission.diceExplain"), "profile-note"));
    }
    const hints = document.getElementById("missionHints");
    hints.replaceChildren();
    for (let index = 0; index < Math.min(state.hints || 0, (mission.hints || []).length); index++){
      hints.append(node("p", `${text("mission.hintCount", { count:index + 1 })}: ${mission.hints[index]}`));
    }
    const hintButton = document.getElementById("hintBtn");
    hintButton.hidden = done || !mission.hints || (state.hints || 0) >= mission.hints.length;
    hintButton.onclick = () => {
      if (saveState(day.day, { hints:(stateFor(day.day).hints || 0) + 1 })) renderMission(day);
    };
    const submit = document.getElementById("missionSubmit");
    submit.hidden = done && !settingPoints;
    submit.textContent = text(settingPoints ? "mission.pointsSubmit"
      : mission.type === "puzzle" ? "mission.puzzleSubmit" : "mission.submit");
    document.getElementById("draftStatus").textContent = text(done ? "mission.saved"
      : isAuthor() ? "mission.authorDraft" : "mission.draft");
    updateRequired(values);
    updatePointCount(mission, values);
    const result = document.getElementById("missionResult");
    result.replaceChildren();
    result.hidden = !done && !blockedDays.has(day.day);
    if (blockedDays.has(day.day)) result.textContent = text("mission.storageBlocked");
    else if (done){
      result.textContent = state.outcome;
      if (pendingExecution(day)){
        result.append(node("p", text(state.executed ? "profile.executed" : "mission.pending")));
        if (!state.executed){
          const button = node("button", text("profile.markExecuted"), "ghost");
          button.type = "button";
          button.onclick = () => markExecuted(day);
          result.append(button);
        }
      }
    }
  }

  function norm(s){
    return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().replace(/\s+/g, " ");
  }

  function submitMission(event){
    event.preventDefault();
    if (!current || current.day > unlockedThrough() || (isCleared(current) && !needsPointAllocation(current))) return;
    const day = current, mission = day.mission;
    const settingPoints = needsPointAllocation(day);
    const answers = settingPoints ? { ...stateFor(day.day).answers, ...missionAnswers() } : missionAnswers();
    updateRequired(answers);
    const form = document.getElementById("missionForm");
    for (const control of form.querySelectorAll("input[type=text],textarea")){
      control.value = control.value.trim();
    }
    if (!form.reportValidity()) return;
    const error = document.getElementById("missionError");
    if (mission.pointBudget && !validPointAllocation(mission, answers)){
      error.textContent = text("mission.pointsInvalid", { total:mission.pointBudget.total });
      error.hidden = false;
      sndDeny();
      return;
    }
    if (settingPoints){
      const previous = stateFor(day.day).answers;
      const updated = { ...previous };
      for (const id of mission.pointBudget.fields) updated[id] = answers[id];
      if (!saveState(day.day, { answers:updated, draft:updated })){
        error.textContent = text("errors.campaignSave");
        error.hidden = false;
        return;
      }
      renderMission(day);
      toast(text("mission.pointsSaved"));
      return;
    }
    const guess = mission.type === "puzzle" ? answers.answer : mission.checkField ? answers[mission.checkField] : null;
    if ((mission.answer && answers.choice !== mission.answer)
        || (guess !== null && !mission.answers.map(norm).includes(norm(guess)))){
      error.textContent = text("message.wrong");
      error.hidden = false;
      sndDeny();
      return;
    }
    let bonus = 0;
    let outcome = mission.success;
    if (mission.type === "choice"){
      const option = mission.options.find(option => option.id === answers.choice);
      if (!option){ error.textContent = text("mission.invalid"); error.hidden = false; return; }
      if (option.result) outcome += "\n\n" + option.result;
    }
    if (mission.type === "dice"){
      const face = stateFor(day.day).roll || Number(answers.face);
      const result = mission.results.find(result => result.face === face);
      if (!result){ error.textContent = text("mission.invalid"); error.hidden = false; return; }
      answers.face = String(face);
      bonus = result.gold;
      outcome += "\n\n" + text("mission.diceResult", { face }) + "\n" + result.text;
    }
    if (mission.portalBonus){
      const portal = stateFor(7);
      bonus = portal.completed ? mission.portalBonus[portal.answers.choice] || 0 : 0;
      outcome += "\n\n" + text(bonus ? "mission.portalBonus" : "mission.noPortal", { count:bonus });
    }
    const patch = { opened:true, completed:true, answers, draft:answers, outcome, bonus };
    if (mission.type === "dice") patch.roll = Number(answers.face);
    if (!saveState(day.day, patch)){
      error.textContent = text("errors.campaignSave");
      error.hidden = false;
      return;
    }
    skipType = true;
    renderMission(day);
    renderReward(day, true);
    renderCalendar();
    sndSuccess();
    toast(text("message.success"));
    beacon(text("notifications.solved", {
      name:text("identity.name"), day:day.day, title:day.title
    }));
  }

  function markExecuted(day){
    if (day.day > unlockedThrough() || !isCleared(day) || !pendingExecution(day) || stateFor(day.day).executed) return;
    if (saveState(day.day, { executed:true })){
      if (document.body.dataset.view === "profile") renderProfile();
      else renderMission(day);
      toast(text("profile.executionDone"));
    }
  }

  document.getElementById("missionForm").addEventListener("submit", submitMission);
  document.getElementById("missionFields").addEventListener("input", () => {
    if (!current || (isCleared(current) && !needsPointAllocation(current))) return;
    const draft = missionAnswers();
    updateRequired(draft);
    updatePointCount(current.mission, draft);
    document.getElementById("missionError").hidden = true;
    const saved = saveState(current.day, { draft });
    document.getElementById("draftStatus").textContent = text(saved
      ? isAuthor() ? "mission.authorDraft" : "mission.draft" : "errors.campaignSave");
  });

  function goHome(){
    const fromProfile = document.getElementById("profile").classList.contains("active");
    showView("calendar");
    renderCalendar(true);
    if (fromProfile) document.getElementById("profileNav").focus({ preventScroll:true });
  }

  // tap message to skip typewriter
  document.addEventListener("click", (e)=>{
    if (typing && document.getElementById("message").classList.contains("active")
        && !e.target.closest(".mission") && !e.target.closest("button")){
      skipType = true;
    }
  });
  // ---- boot ------------------------------------------------
  // Contador de créditos animado -----------------------------
  function animateCount(el, from, to, key){
    if (from === to || profile.reducedMotion){ el.textContent = text(key, { count:to.toLocaleString("es-ES") }); return; }
    const dur = 750, t0 = performance.now();
    function step(t){
      const p = Math.min(1,(t-t0)/dur);
      const e = p < .5 ? 2*p*p : 1 - Math.pow(-2*p+2,2)/2;
      el.textContent = text(key, { count:Math.round(from + (to-from)*e).toLocaleString("es-ES") });
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Booteo del Sistema (una vez por sesión) ------------------
  function runBoot(done){
    if (profile.reducedMotion){ done && done(); return; }
    const boot = document.getElementById("boot");
    const box  = document.getElementById("bootlines");
    if (!boot || !box){ done && done(); return; }
    const name = text("identity.name").toUpperCase();
    const lines = [
      text("boot.starting"),
      text("boot.connecting"),
      text("boot.identity", { name }),
      text("boot.authorized")
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
      if (skip){ box.innerHTML = lines.map(l=>`<div>${esc(l)}</div>`).join(""); setTimeout(finish, 220); return; }
      if (li >= lines.length){ setTimeout(finish, 520); return; }
      let cur = box.children[li];
      if (!cur){ cur = document.createElement("div"); box.appendChild(cur); }
      if (ci <= lines[li].length){ cur.textContent = lines[li].slice(0, ci); ci++; setTimeout(step, 20); }
      else { li++; ci = 0; haptic(8); setTimeout(step, 170); }
    }
    step();
  }

  async function init(){
    applyStrings();
    try {
      const res = await fetch("days.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`days.json: ${res.status}`);
      const data = await res.json();
      if (!/^[a-z0-9-]+$/.test(data.campaign) || !Array.isArray(data.days) || data.days.length !== 24){
        throw new Error("La campaña debe tener un identificador y 24 pisos.");
      }
      const sorted = data.days.slice().sort((a,b)=>a.day-b.day);
      for (let index = 0; index < sorted.length; index++){
        const day = sorted[index], mission = day.mission;
        if (day.day !== index + 1 || typeof day.title !== "string" || typeof day.message !== "string"
            || !mission || !["form","choice","puzzle","dice"].includes(mission.type)
            || typeof mission.success !== "string" || !day.reward
            || !Number.isInteger(day.reward.gold) || day.reward.gold < 0){
          throw new Error(`Configuración no válida en el piso ${index + 1}`);
        }
        const attributes = day.reward.attributes;
        if (attributes !== undefined && (!attributes || typeof attributes !== "object" || Array.isArray(attributes)
            || !Object.keys(attributes).length || Object.entries(attributes).some(([id, points]) =>
              !attributeKeys.includes(id) || !Number.isSafeInteger(points) || points <= 0))){
          throw new Error(`Mejoras de características no válidas: piso ${day.day}`);
        }
        if (mission.type === "form" && (!Array.isArray(mission.fields)
            || new Set(mission.fields.map(field => field.id)).size !== mission.fields.length)){
          throw new Error(`Campos no válidos: piso ${day.day}`);
        }
        if (mission.pointBudget){
          const budget = mission.pointBudget;
          if (mission.type !== "form" || !Number.isInteger(budget.total) || budget.total !== 30
              || !Array.isArray(budget.fields) || budget.fields.join(",") !== "strength,wit,charm"
              || budget.fields.some(id => !mission.fields.some(field => field.id === id
                && field.type === "number" && field.min === 0 && field.max === 20))){
            throw new Error(`Reparto de puntos no válido: piso ${day.day}`);
          }
        }
        if (mission.type === "choice" && (!Array.isArray(mission.options) || !mission.options.length
            || (mission.answer && !mission.options.some(option => option.id === mission.answer)))){
          throw new Error(`Opciones no válidas: piso ${day.day}`);
        }
        if ((mission.type === "puzzle" || mission.checkField) && (!Array.isArray(mission.answers) || !mission.answers.length)){
          throw new Error(`Faltan respuestas: piso ${day.day}`);
        }
        if (mission.type === "dice" && (!Array.isArray(mission.results) || mission.results.length !== 6
            || new Set(mission.results.map(result => result.face)).size !== 6
            || mission.results.some(result => !Number.isInteger(result.face) || result.face < 1 || result.face > 6
              || !Number.isInteger(result.gold) || result.gold < 0 || typeof result.text !== "string"))){
          throw new Error(`Tabla de dado no válida: piso ${day.day}`);
        }
      }
      if (attributeKeys.some(id => !Number.isSafeInteger(sorted.reduce((sum, day) =>
        sum + (day.reward.attributes?.[id] || 0), 20)))){
        throw new Error("Las mejoras de características exceden la precisión admitida.");
      }
      campaignId = data.campaign;
      DAYS = sorted;
    } catch(error){
      console.error("No se pudo cargar la campaña.", error);
      document.getElementById("hint").textContent = text("errors.daysLoad");
      return;
    }
    loadCampaign();
    renderCalendar(true);
    if (profileLoadError) toast(text("errors.profileLoad"));
    if ("serviceWorker" in navigator){
      navigator.serviceWorker.register("sw.js").catch(error => {
        console.error("No se pudo registrar el modo sin conexión.", error);
        toast(text("errors.offline"));
      });
    }

    // Booteo del Sistema: una vez por pestaña (?boot=1 fuerza repetirlo).
    const force = /[?&]boot=1/.test(location.search);
    if (force) sessionStorage.removeItem("dcc_booted");
    if (!sessionStorage.getItem("dcc_booted")){
      sessionStorage.setItem("dcc_booted", "1");
      runBoot();
    }
  }
  init();

  return { goHome, openProfile };
})();

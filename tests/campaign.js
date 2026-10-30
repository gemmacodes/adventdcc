/* Abrir tests/campaign.html desde el servidor local; no requiere dependencias. */
(async () => {
  const results = [];
  window.testResults = { running:true, results };
  const output = document.getElementById("results");
  let frame = document.getElementById("app");
  const base = new URL("../", location.href).href;
  const stamp = Date.now();
  const html = await (await fetch(`${base}index.html?test=${stamp}`)).text();
  const data = await (await fetch(`${base}days.json?test=${stamp}`)).json();
  const key = day => `dcc_campaign_${data.campaign}_${day}`;
  const previewKey = day => `dcc_preview_${data.campaign}_${day}`;
  function assert(condition, label){
    results.push({ label, pass:!!condition });
    output.textContent = results.map(result => `${result.pass ? "OK" : "FALLO"} ${result.label}`).join("\n");
    if (!condition) throw new Error(label);
  }
  function storage(){
    return {
      data:new Map(), failWrite:false,
      getItem(key){ return this.data.get(key) ?? null; },
      setItem(key, value){
        if (this.failWrite && key.includes(data.campaign)) throw new Error("Almacenamiento bloqueado para la prueba");
        this.data.set(key, String(value));
      },
      removeItem(key){ this.data.delete(key); }
    };
  }
  function fresh(author = true, date = "2026-12-24T12:00:00"){
    const local = storage(), session = storage();
    for (const setting of ["sound","haptics","typewriter"]) local.setItem(`dcc_profile_${setting}`, "false");
    local.setItem("dcc_profile_reducedMotion", "true");
    if (author) local.setItem("dcc_author", "1");
    session.setItem("dcc_booted", "1");
    window.fixture = { local, session, date, errors:[], notifications:[] };
  }
  let doc, app;
  async function load(){
    const setup = `<script>
      Object.defineProperty(window, "localStorage", { value:parent.fixture.local });
      Object.defineProperty(window, "sessionStorage", { value:parent.fixture.session });
      const OriginalDate = Date;
      window.Date = class extends OriginalDate {
        constructor(...args){ super(...(args.length ? args : [parent.fixture.date])); }
        static now(){ return new OriginalDate(parent.fixture.date).getTime(); }
      };
      CONFIG.notify.enabled = false;
      Object.defineProperty(navigator, "serviceWorker", { value:{ register:() => Promise.resolve() } });
      console.error = (...args) => parent.fixture.errors.push(args.map(String).join(" "));
      window.addEventListener("error", event => parent.fixture.errors.push(event.message));
      window.addEventListener("unhandledrejection", event => parent.fixture.errors.push(String(event.reason)));
      const originalFetch = window.fetch;
      window.fetch = (...args) => {
        if (args[1]?.method === "POST") parent.fixture.notifications.push(args);
        return originalFetch(...args);
      };
    <\/script>`;
    const source = html.replace("<head>", `<head><base href="${base}">`)
      .replace('<script src="app.js">', `${setup}<script src="app.js">`)
      .replace('href="styles.css"', `href="styles.css?test=${stamp}"`)
      .replace(/src="([^"]+\.js)"/g, `src="$1?test=${stamp}"`)
      .replace("</body>", "<script>window.App = App;<\/script></body>");
    const next = frame.cloneNode(false);
    frame.replaceWith(next);
    frame = next;
    await new Promise(resolve => {
      frame.onload = resolve;
      frame.contentDocument.open();
      frame.contentDocument.write(source);
      frame.contentDocument.close();
    });
    doc = frame.contentDocument;
    app = frame.contentWindow;
    for (let index = 0; index < 150 && !doc.querySelector(".door"); index++){
      if (doc.getElementById("hint").textContent.includes("no se pudo cargar")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!doc.querySelector(".door") && new Date(fixture.date).getMonth() === 11){
      throw new Error("La campaña no arrancó: " + fixture.errors.join("\n"));
    }
  }
  function open(day){
    app.App.goHome();
    doc.querySelector(`[data-day="${day}"]`).click();
  }
  function set(name, value){
    const controls = [...doc.querySelectorAll(`#missionFields [name="${name}"]`)];
    for (const control of controls){
      if (control.type === "radio") control.checked = control.value === value;
      else if (control.type === "checkbox") control.checked = value;
      else control.value = value;
    }
    controls[0].dispatchEvent(new app.Event("input", { bubbles:true }));
  }
  function submit(){ doc.getElementById("missionForm").requestSubmit(); }
  function record(day){
    const store = fixture.local.getItem("dcc_author") === "1" ? fixture.session : fixture.local;
    return JSON.parse(store.getItem(store === fixture.session ? previewKey(day) : key(day)) || "{}");
  }
  function readStats(){
    return Object.fromEntries(["strength","wit","charm"].map(id => {
      const suffix = id[0].toUpperCase() + id.slice(1);
      return [id, Number(doc.getElementById(`stat${suffix}Value`).textContent)];
    }));
  }
  function fill(day){
    const mission = day.mission;
    if (mission.type === "choice") set("choice", mission.answer || mission.options[0].id);
    if (mission.type === "puzzle") set("answer", mission.answers[0]);
    if (mission.type === "dice") set("face", "6");
    if (mission.type === "form"){
      for (const field of mission.fields){
        const value = field.type === "checkbox" ? true
          : field.type === "number" ? "10"
          : mission.checkField === field.id ? mission.answers[0]
          : field.options ? field.options[0].id : `Prueba ${field.id} <texto & seguro>`;
        set(field.id, value);
      }
    }
  }
  try {
    fresh();
    await load();
    app.App.openProfile();
    const portrait = doc.getElementById("profilePortrait");
    await portrait.decode();
    assert(portrait.naturalWidth > 0 && portrait.alt === "Retrato de Samu"
      && !portrait.closest("[aria-hidden=true]"), "El expediente muestra la foto de Samu con texto alternativo accesible");
    assert(!/DRAGONCITO DE ÉLITE|Paco Pecado|Gemma/.test(doc.getElementById("profile").textContent), "Perfil inicial sin premios futuros ni desenlace");
    assert(["attributesCard","companionCard","plansCard","lootCard"].every(id => doc.getElementById(id).hidden), "El perfil inicial no muestra secciones vacías ni características inventadas");
    assert(!doc.querySelector("#profile input[type=range],#campaignJournal,#campaignDossier,[data-profile=nap],[data-profile=cats]"), "La ficha no contiene sliders, historial redundante ni toggles de personaje");
    assert(!doc.getElementById("profileLatestTitle") && !doc.querySelector(".identity .title-chip"), "La cabecera no muestra títulos obtenidos");
    assert(!doc.getElementById("interfaceSettings").open, "Los ajustes están plegados por defecto");
    const settings = doc.getElementById("interfaceSettings");
    settings.open = true;
    const sound = doc.getElementById("settingSound");
    sound.checked = true;
    sound.dispatchEvent(new app.Event("change", { bubbles:true }));
    assert(settings.open && fixture.local.getItem("dcc_profile_sound") === "true", "Cambiar un ajuste lo guarda sin cerrar el desplegable");
    sound.checked = false;
    sound.dispatchEvent(new app.Event("change", { bubbles:true }));
    settings.open = false;
    open(1);
    assert(!record(1).completed && doc.getElementById("rewardBox").hidden, "Abrir no completa la misión ni concede premios");
    submit();
    assert(!record(1).completed, "Los campos obligatorios bloquean el envío vacío");
    set("warName", "Nombre que persiste");
    await load();
    open(1);
    assert(doc.getElementById("mission-warName").value === "Nombre que persiste", "El borrador sobrevive a una recarga");
    fill(data.days[0]);
    for (const [strength,wit,charm] of [[9,10,10],[11,10,10],[-1,11,20],[21,0,9],[9.5,10.5,10]]){
      for (const [id,value] of Object.entries({ strength,wit,charm })) set(id, String(value));
      submit();
      assert(!record(1).completed, `No se acepta el reparto ${strength}/${wit}/${charm}`);
    }
    set("strength", "0"); set("wit", "10"); set("charm", "20");
    await load(); open(1);
    assert(doc.getElementById("mission-strength").value === "0" && doc.getElementById("mission-charm").value === "20", "El borrador de puntos conserva los límites 0 y 20");
    submit();
    assert(record(1).completed && record(1).answers.strength === "0" && record(1).answers.charm === "20", "El reparto exacto de 30 puntos completa el contrato");
    const locked = JSON.stringify(record(1));
    set("strength", "20"); submit();
    assert(JSON.stringify(record(1)) === locked && doc.getElementById("mission-strength").disabled, "Los puntos no pueden volver a editarse después de completar la misión");
    app.App.openProfile();
    assert(doc.getElementById("statStrength").tagName === "METER" && doc.getElementById("statStrength").value === 0
      && doc.getElementById("statCharm").value === 20, "El perfil muestra las puntuaciones de misión como indicadores fijos");
    assert(doc.getElementById("profileWarName").textContent.includes(record(1).answers.warName)
      && doc.getElementById("profileMotto").textContent === record(1).answers.motto, "Identidad y expediente están integrados sin repetir el contrato");
    const earnedAttributes = { strength:0, wit:0, charm:0 };
    for (const day of data.days){
      open(day.day);
      assert(!!doc.querySelector(".mission-bonus") === !!day.reward.attributes,
        `Piso ${day.day}: solo las misiones con mejoras anuncian puntos de característica`);
      if (day.mission.answer || day.mission.type === "puzzle" || day.mission.checkField){
        fill(day);
        if (day.mission.answer) set("choice", day.mission.options.find(option => option.id !== day.mission.answer).id);
        else set(day.mission.checkField || "answer", "incorrecto");
        submit();
        assert(!record(day.day).completed && !doc.getElementById("missionError").hidden, `Piso ${day.day}: el error permite reintentar sin premio`);
        doc.getElementById("hintBtn").click();
        assert(record(day.day).hints === 1, `Piso ${day.day}: pista gratuita guardada`);
      }
      fill(day);
      if (day.day === 10){
        doc.querySelector("#missionFields button").click();
        const roll = record(10).roll;
        doc.querySelector("#missionFields button").click();
        assert(record(10).roll === roll, "El dado virtual solo registra una tirada");
      }
      if (day.day === 18){
        set("plan", "custom");
        set("proposal", "");
        submit();
        assert(!record(18).completed, "Un plan propio requiere escribir la propuesta");
        set("proposal", "Una aventura que nos apetezca");
      }
      submit();
      assert(record(day.day).completed && !doc.getElementById("rewardBox").hidden, `Piso ${day.day}: resolución y recompensa`);
      const saved = JSON.stringify(record(day.day));
      submit();
      assert(JSON.stringify(record(day.day)) === saved, `Piso ${day.day}: sin premio duplicado`);
      for (const [id, points] of Object.entries(day.reward.attributes || {})){
        earnedAttributes[id] += points;
        const label = app.STRINGS.profile[id];
        assert(doc.getElementById("rewardDetail").textContent.includes(`+${points} ${label}`),
          `Piso ${day.day}: la recompensa muestra +${points} ${label}`);
      }
      app.App.openProfile();
      const stats = readStats();
      assert(stats.strength === earnedAttributes.strength && stats.wit === 10 + earnedAttributes.wit
        && stats.charm === 20 + earnedAttributes.charm, `Piso ${day.day}: suma exacta de base y mejoras, sin duplicados`);
      if (day.day === 16) assert(record(16).bonus === 75, "El sello de riqueza afecta a la Bolsa una sola vez");
      if (day.day === 20){
        app.App.openProfile();
        assert(!doc.getElementById("profile").textContent.includes("Paco Pecado"), "El sobre 20 no revela las entradas");
      }
      if (day.day === 23){
        app.App.openProfile();
        assert(!/DRAGONCITO DE ÉLITE|Paco Pecado|Gemma/.test(doc.getElementById("profile").textContent), "Inventario y expediente siguen sin revelar el desenlace");
      }
    }
    app.App.openProfile();
    assert(doc.getElementById("profileFloors").textContent === "24 / 24", "Progreso real de 24 misiones");
    assert(readStats().strength === 3 && readStats().wit === 14 && readStats().charm === 23,
      "La campaña completa concede diez puntos: tres de fuerza, cuatro de ingenio y tres de carisma");
    assert(doc.getElementById("statCharm").value === 23 && doc.getElementById("statCharm").max >= 23
      && doc.getElementById("statCharmBreakdown").textContent.includes("+3"),
      "Las mejoras superan 20 sin recortarse y muestran su desglose");
    assert(record(1).answers.strength === "0" && record(1).answers.wit === "10" && record(1).answers.charm === "20",
      "Las mejoras no modifican el reparto inicial fijado en el contrato");
    assert(doc.getElementById("campaignInventory").textContent.includes("Paco Pecado"), "Las entradas se revelan después de resolver el 24");
    assert(doc.getElementById("campaignTitles").textContent.includes("DRAGONCITO DE ÉLITE"), "Título final obtenido al resolver el 24");
    assert(doc.getElementById("campaignCompanion").textContent.includes("Prueba companion <texto & seguro>"), "Compañero y respuestas se muestran como texto literal");
    assert(!doc.getElementById("campaignCompanion").querySelector("texto"), "Las respuestas no se interpretan como HTML");
    assert(!record(14).executed && !record(18).executed, "Las actividades cooperativas no se realizan al desbloquearlas");
    assert(!doc.querySelector("#campaignInventory button,#campaignInventory a"), "El inventario no contiene navegación a pisos");
    assert(doc.querySelectorAll("#campaignInventory > div > .inventory-row").length === 3
      && !doc.querySelector("#campaignInventory > .collection-more").open, "Solo tres objetos recientes se muestran antes de desplegar el inventario completo");
    assert([...doc.querySelectorAll("#campaignInventory .inventory-row")].every(row =>
      row.children.length === 2 && row.children[0].tagName === "STRONG"
      && row.children[1].textContent === `PISO ${row.dataset.inventoryDay}`)
      && !doc.querySelector("#campaignInventory .inventory-row details,#campaignInventory p"),
      "Cada objeto solo muestra su contenido y el piso, sin descripciones ni desplegables individuales");
    const titlesTab = doc.getElementById("lootTitlesTab"), inventoryTab = doc.getElementById("lootInventoryTab");
    assert(doc.querySelectorAll("#lootCard [role=tab]").length === 2
      && titlesTab.getAttribute("aria-selected") === "true"
      && !doc.getElementById("titlesSection").hidden && doc.getElementById("inventorySection").hidden,
      "Títulos e inventario son pestañas de una misma sección, con un único panel visible");
    inventoryTab.click();
    assert(inventoryTab.getAttribute("aria-selected") === "true" && titlesTab.tabIndex === -1
      && doc.getElementById("titlesSection").hidden && !doc.getElementById("inventorySection").hidden,
      "La pestaña Inventario activa solo su panel y actualiza la navegación accesible");
    for (const [tab,key,target] of [[inventoryTab,"Home",titlesTab],[titlesTab,"End",inventoryTab],
      [inventoryTab,"ArrowRight",titlesTab],[titlesTab,"ArrowLeft",inventoryTab]]){
      tab.dispatchEvent(new app.KeyboardEvent("keydown", { key, bubbles:true, cancelable:true }));
      assert(doc.activeElement === target && target.getAttribute("aria-selected") === "true",
        `Las pestañas admiten navegación de teclado con ${key}`);
    }
    assert(!doc.getElementById("campaignInventory").textContent.includes("Contrato de cocina cooperativa")
      && doc.getElementById("campaignPlans").textContent.includes("Experimento gastronómico"), "Los planes están separados de los objetos");
    const pending = [...doc.querySelectorAll("#campaignPlans button")].find(button => button.textContent === app.STRINGS.profile.markExecuted);
    pending.click();
    assert(record(14).executed && !doc.getElementById("completedPlans").hidden
      && !doc.getElementById("completedPlans").open, "Una actividad realizada se archiva en el desplegable de planes terminados");
    assert(readStats().wit === 14, "Realizar una actividad ya desbloqueada no vuelve a conceder sus puntos");
    assert(!doc.getElementById("inventorySection").hidden && inventoryTab.getAttribute("aria-selected") === "true",
      "Actualizar el perfil conserva la pestaña elegida");
    assert(fixture.local.getItem(key(1)) === null, "El modo autor no modifica el progreso real");
    assert(fixture.errors.length === 0 && fixture.notifications.length === 0, "Recorrido sin errores de ejecución ni notificaciones de prueba");
    for (const width of [280,320,390]){
      frame.style.width = `${width}px`;
      await new Promise(resolve => setTimeout(resolve, 50));
      for (const day of [1,3,5,10,14,18,24]){
        open(day);
        assert(doc.documentElement.scrollWidth <= app.innerWidth, `Piso ${day}: sin desbordamiento a ${width}px`);
      }
      app.App.openProfile();
      assert(doc.documentElement.scrollWidth <= app.innerWidth, `Perfil sin desbordamiento a ${width}px`);
      titlesTab.click();
      assert(doc.documentElement.scrollWidth <= app.innerWidth, `Pestaña Títulos sin desbordamiento a ${width}px`);
      inventoryTab.click();
      assert(doc.documentElement.scrollWidth <= app.innerWidth, `Pestaña Inventario sin desbordamiento a ${width}px`);
      if (width === 390) assert(doc.documentElement.scrollHeight < 1700, "La ficha completa mantiene una altura compacta con 24 misiones resueltas");
    }
    frame.style.width = "390px";
    await load();
    app.App.openProfile();
    assert(doc.getElementById("profileFloors").textContent === "24 / 24" && record(14).executed, "Progreso, decisiones y actividades persisten tras recargar");
    assert(readStats().strength === 3 && readStats().wit === 14 && readStats().charm === 23,
      "Las mejoras persisten al recargar sin reabrir ni repetir las misiones");

    fresh(); await load();
    open(3); set("choice", "pipo"); submit();
    app.App.openProfile();
    assert(doc.getElementById("profileEarnedAttributes").hidden, "Una respuesta incorrecta no concede mejoras");
    open(3); set("choice", "chispa"); submit();
    app.App.openProfile();
    assert(!doc.getElementById("attributesCard").hidden && doc.getElementById("profileStats").hidden
      && doc.getElementById("profileEarnedAttributes").textContent.includes("+1 Ingenio"),
      "Los puntos ganados antes del contrato se conservan sin inventar una base");
    await load();
    open(1); fill(data.days[0]); submit();
    app.App.openProfile();
    assert(readStats().strength === 10 && readStats().wit === 11 && readStats().charm === 10,
      "El reparto inicial suma también las mejoras ganadas anteriormente");
    const future = record(3);
    fixture.local.removeItem("dcc_author");
    fixture.local.setItem(key(3), JSON.stringify(future));
    fixture.date = "2026-12-02T12:00:00";
    await load();
    app.App.openProfile();
    assert(doc.getElementById("attributesCard").hidden, "No se incluyen mejoras de pisos futuros aunque haya registros guardados");
    fixture.date = "2026-12-03T12:00:00";
    await load();
    app.App.openProfile();
    assert(doc.getElementById("profileEarnedAttributes").textContent.includes("+1 Ingenio"),
      "Una misión completada en una versión anterior adquiere su mejora al estar disponible");

    fresh(); await load();
    open(2); fill(data.days[1]); submit();
    app.App.openProfile();
    assert(doc.getElementById("lootInventoryTab").getAttribute("aria-selected") === "true"
      && !doc.getElementById("inventorySection").hidden,
      "Si solo hay objetos, el botín abre directamente el inventario");
    doc.getElementById("lootTitlesTab").click();
    assert(!doc.getElementById("titlesSection").hidden
      && doc.getElementById("campaignTitles").textContent.includes(app.STRINGS.profile.emptyTitles),
      "Una pestaña sin títulos muestra un estado vacío claro");

    for (const choice of ["accept","decline","later"]){
      fresh();
      await load();
      open(19); set("choice", choice); submit();
      app.App.openProfile();
      const hasPlan = !doc.getElementById("plansCard").hidden;
      assert(record(19).completed && record(19).bonus === 0 && hasPlan === (choice !== "decline"), `Privilegio ${choice}: mismo premio y decisión respetada`);
    }
    fresh(); await load();
    open(1); fill(data.days[0]); submit();
    const legacy = record(1);
    for (const id of ["strength","wit","charm"]){ delete legacy.answers[id]; delete legacy.draft[id]; }
    fixture.session.setItem(previewKey(1), JSON.stringify(legacy));
    fixture.local.setItem("dcc_profile_strength", "20");
    await load();
    app.App.openProfile();
    assert(doc.getElementById("profileStats").hidden && !doc.getElementById("profileStatSetup").hidden,
      "Un contrato anterior no hereda puntuaciones arbitrarias de los sliders");
    doc.getElementById("setAttributes").click();
    assert(doc.getElementById("mission-warName").disabled && !doc.getElementById("mission-strength").disabled,
      "El contrato anterior permite fijar únicamente los nuevos puntos");
    set("strength","20"); set("wit","0"); set("charm","10");
    const legacyOutcome = record(1).outcome, legacyGold = record(1).bonus;
    fixture.session.failWrite = true;
    submit();
    assert(!record(1).answers.strength && !doc.getElementById("missionSubmit").hidden,
      "Si falla el guardado del reparto anterior, se puede reintentar sin bloquearlo");
    fixture.session.failWrite = false;
    submit();
    assert(record(1).answers.strength === "20" && record(1).outcome === legacyOutcome
      && record(1).bonus === legacyGold && record(1).answers.warName === legacy.answers.warName,
      "Completar los puntos conserva las respuestas, el desenlace y los premios anteriores");
    await load(); open(1);
    assert(doc.getElementById("mission-strength").disabled && doc.getElementById("missionSubmit").hidden,
      "El reparto complementario queda fijado al recargar");
    assert(fixture.notifications.length === 0, "Fijar características de un contrato anterior no reenvía avisos de misión");

    const corrupt = record(1);
    corrupt.answers.strength = "21";
    fixture.session.setItem(previewKey(1), JSON.stringify(corrupt));
    await load(); open(1);
    assert(doc.getElementById("missionForm").hidden
      && fixture.session.getItem(previewKey(1)) === JSON.stringify(corrupt),
      "Un reparto guardado inválido se informa y se conserva sin sobrescribir");
    for (const [choice, bonus] of [["power",25],["wisdom",50]]){
      fresh(); await load();
      open(7); set("choice", choice); submit();
      open(16); set("choice", "lolo"); submit();
      assert(record(16).bonus === bonus, `Bonus de portal ${choice}: ${bonus}`);
    }
    fresh(); await load();
    open(16); set("choice", "lolo"); submit();
    assert(record(16).completed && record(16).bonus === 0, "Se puede jugar la Bolsa sin completar el portal");
    open(7); set("choice", "wealth"); submit();
    assert(record(16).bonus === 0, "Un portal posterior no modifica un premio ya concedido");
    open(24); set("answer", " GÉMMA! "); submit();
    assert(record(24).completed, "Desenlace accesible sin completar todos los días y con normalización de respuesta");
    assert(!record(20).completed, "El desenlace no inventa la recepción del sobre 20");

    fresh(); await load();
    for (const face of ["0","7","1.5"]){
      open(10); set("face", face); submit();
      assert(!record(10).completed, `Se rechaza la tirada física ${face}`);
    }
    set("face", "3"); submit();
    assert(record(10).roll === 3 && record(10).bonus === 75, "Dado físico: resultado y bonus correctos");
    await load(); open(10);
    assert(doc.getElementById("mission-face").value === "3" && doc.getElementById("mission-face").disabled, "Una tirada completada no puede editarse tras recargar");

    fresh(false); await load();
    open(1); fill(data.days[0]); fixture.local.failWrite = true; submit();
    assert(!record(1).completed && doc.getElementById("rewardBox").hidden, "Un fallo al guardar no concede premios");
    fixture.local.failWrite = false; submit();
    assert(record(1).completed && fixture.local.getItem(key(1)) !== null, "Se puede reintentar el guardado real");
    await load(); open(1);
    assert(record(1).completed && doc.getElementById("mission-warName").disabled, "Persistencia real tras recargar");
    open(3); set("choice", "chispa");
    fixture.local.failWrite = true; submit();
    app.App.openProfile();
    assert(!record(3).completed && readStats().wit === 10, "Un fallo de guardado no concede puntos de característica");
    fixture.local.failWrite = false;
    open(3); submit();
    app.App.openProfile();
    assert(readStats().wit === 11, "Reintentar el guardado concede la mejora una sola vez");
    fixture.local.setItem(key(2), "{registro roto");
    await load(); open(2);
    assert(doc.getElementById("missionForm").hidden && fixture.local.getItem(key(2)) === "{registro roto", "Un registro corrupto se conserva y no se sobrescribe");
    assert(fixture.errors.some(error => error.includes("recuperar")), "Se informa del error de lectura");

    fresh(false, "2026-12-02T12:00:00"); await load();
    assert(doc.querySelectorAll(".door").length === 2, "El día 2 no se muestran pisos futuros");
    open(2); fill(data.days[1]); submit();
    assert(doc.querySelectorAll(".door").length === 3, "Completar el día actual revela solo un teaser");
    open(3);
    assert(doc.getElementById("message").classList.contains("active") === false && !record(3).opened, "El teaser sigue sellado y no puede abrirse");
    fixture.date = "2027-01-02T12:00:00"; await load();
    assert(doc.querySelectorAll(".door").length === 24, "Después de diciembre se puede recuperar cualquier misión");
    fresh(false, "2026-11-30T12:00:00"); await load();
    app.App.openProfile();
    assert(doc.querySelectorAll(".door").length === 0 && doc.getElementById("profileFloors").textContent === "0 / 24", "Antes de diciembre hay perfil pero no misiones desbloqueadas");
    window.testResults.running = false;
    window.testResults.pass = true;
    output.textContent += `\n\n${results.length} comprobaciones correctas.`;
  } catch(error){
    window.testResults.running = false;
    window.testResults.pass = false;
    window.testResults.error = `${error.message}\n${error.stack}`;
    output.textContent += "\n\n" + window.testResults.error;
  }
})();

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
    window.fixture = { local, session, date, errors:[], notifications:[], downloads:[], blobURLs:new Map() };
  }
  let doc, app;
  async function load(){
    const setup = `<script>
      const testFixture = parent.fixture;
      Object.defineProperty(window, "localStorage", { value:testFixture.local });
      Object.defineProperty(window, "sessionStorage", { value:testFixture.session });
      const OriginalDate = Date;
      window.Date = class extends OriginalDate {
        constructor(...args){ super(...(args.length ? args : [testFixture.date])); }
        static now(){ return new OriginalDate(testFixture.date).getTime(); }
      };
      CONFIG.notify.enabled = false;
      if (testFixture.sync){
        CONFIG.sync.endpoint = "https://fixture.vercel.app/api/progress";
        if (testFixture.sync.fragment){
          history.replaceState(null, "", location.href.split("#")[0] + "#backupKey=" + testFixture.sync.fragment);
        }
      }
      Object.defineProperty(navigator, "serviceWorker", { value:{ register:() => Promise.resolve() } });
      console.error = (...args) => testFixture.errors.push(args.map(String).join(" "));
      window.addEventListener("error", event => testFixture.errors.push(event.message));
      window.addEventListener("unhandledrejection", event => testFixture.errors.push(String(event.reason)));
      const originalFetch = window.fetch;
      URL.createObjectURL = blob => {
        const url = "blob:backup-test-" + testFixture.blobURLs.size;
        testFixture.blobURLs.set(url, blob);
        return url;
      };
      URL.revokeObjectURL = url => testFixture.blobURLs.delete(url);
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function(){
        if (this.download){
          testFixture.downloads.push({ filename:this.download, blob:testFixture.blobURLs.get(this.href) });
        } else originalClick.call(this);
      };
      window.fetch = (...args) => {
        if (String(args[0]) === "https://fixture.vercel.app/api/progress"){
          const remote = testFixture.sync;
          const options = args[1];
          remote.requests.push({ method:options.method, body:options.body, authorization:options.headers.Authorization });
          if (remote.fail) return Promise.reject(new TypeError("Sin conexión simulada"));
          if (options.method === "PUT"){
            const changes = JSON.parse(options.body).changes;
            remote.snapshot.revision++;
            for (const change of changes){
              const previous = remote.snapshot.records.findIndex(entry => entry.day === change.day);
              const entry = { day:change.day, revision:change.baseRevision + 1, state:change.state };
              if (previous < 0) remote.snapshot.records.push(entry);
              else remote.snapshot.records[previous] = entry;
            }
          }
          return Promise.resolve(new Response(JSON.stringify(remote.snapshot), {
            status:200, headers:{ "Content-Type":"application/json" }
          }));
        }
        if (args[1]?.method === "POST") testFixture.notifications.push(args);
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
    const makeKey = store === fixture.session ? previewKey : key;
    const saved = store.getItem(makeKey(day));
    if (saved !== null) return JSON.parse(saved);
    const restored = JSON.parse(store.getItem(makeKey("restored")) || '{"records":[]}');
    return restored.records.find(entry => entry.day === day)?.state || {};
  }
  async function exportBackup(){
    const count = fixture.downloads.length;
    doc.getElementById("exportBackup").click();
    assert(fixture.downloads.length === count + 1, "La copia se prepara como descarga local");
    return JSON.parse(await fixture.downloads.at(-1).blob.text());
  }
  function chooseFile(file){
    const transfer = new app.DataTransfer();
    transfer.items.add(file);
    const input = doc.getElementById("backupFile");
    input.files = transfer.files;
    input.dispatchEvent(new app.Event("change", { bubbles:true }));
  }
  async function chooseBackup(data, raw = false){
    chooseFile(new app.File([raw ? data : JSON.stringify(data)], "copia.json", { type:"application/json" }));
    for (let index = 0; index < 100 && doc.getElementById("backupStatus").dataset.state === "busy"; index++){
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (doc.getElementById("backupStatus").dataset.state === "busy") throw new Error("La lectura de la copia no terminó.");
  }
  function privateBackup({ key = true, fragment = false, records = [] } = {}){
    const token = "b".repeat(64);
    fixture.sync = {
      requests:[], fragment:fragment ? token : null,
      snapshot:{
        format:"adventdcc-progress", version:1, campaign:data.campaign,
        revision:Math.max(0, ...records.map(entry => entry.revision)), updatedAt:"2026-12-24T12:00:00Z", records
      }
    };
    if (key && !fragment) fixture.local.setItem(`dcc_sync_access_${data.campaign}`, token);
  }
  async function waitSync(state){
    for (let index = 0; index < 200; index++){
      if (doc.querySelector("[data-sync-status]").dataset.state === state) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`La copia privada no alcanzó el estado ${state}: ${doc.querySelector("[data-sync-status]").textContent}`);
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
    await Promise.all(["campaign-state.mjs","cloud-sync.mjs","character-cards.mjs"].map(async name => {
      const response = await fetch(`${base}${name}`, { cache:"reload" });
      if (!response.ok) throw new Error(`${name}: ${response.status}`);
      await response.text();
    }));
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
    assert(doc.querySelectorAll("#campaignCharacters .character-entry").length === 4
      && !doc.getElementById("characterAuthorNote").hidden
      && doc.querySelectorAll('#campaignCharacters [data-unlocked="true"]').length === 0,
      "El autor previsualiza las cuatro cartas sin registrarlas en el progreso de Samu");
    const characterCollection = doc.getElementById("charactersCard");
    const carousel = doc.getElementById("campaignCharacters");
    assert(!carousel.querySelector(".profile-note") && app.getComputedStyle(carousel).scrollbarWidth === "none",
      "Las cartas no muestran etiquetas de vista previa ni barra de desplazamiento bajo las ilustraciones");
    const previousCharacter = doc.getElementById("characterPrevious");
    const nextCharacter = doc.getElementById("characterNext");
    const characterDossier = doc.getElementById("characterDossier");
    const characterPosition = () => doc.getElementById("characterPosition").textContent;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(characterCollection.tagName === "DIV" && !characterCollection.querySelector(":scope > summary")
      && carousel.getBoundingClientRect().height > 0,
      "La colección muestra las cartas al entrar en el perfil sin tener que desplegarla");
    const firstCard = carousel.querySelector(".character-slot");
    assert(firstCard.offsetWidth > carousel.clientWidth * .8 && firstCard.offsetWidth < carousel.clientWidth * .9
      && carousel.scrollWidth > carousel.clientWidth,
      "El carrusel muestra una carta grande y una parte de la siguiente dentro de su propio desplazamiento");
    assert(previousCharacter.disabled && !nextCharacter.disabled && characterPosition() === "CARTA REGISTRADA 1/4",
      "Las flechas y el indicador comienzan en la primera carta sin retroceso disponible");
    nextCharacter.click();
    assert(characterPosition() === "CARTA REGISTRADA 2/4" && carousel.scrollLeft > 0
      && carousel.querySelector('[aria-current="true"]').dataset.characterDay === "9",
      "La flecha siguiente desplaza y selecciona la segunda carta sin cambiar el progreso");
    characterDossier.open = true;
    assert(doc.getElementById("characterDossierLabel").textContent.includes("Chiquito")
      && characterDossier.textContent.includes(data.days[8].character.note),
      "El expediente de la carta seleccionada se abre debajo del carrusel");
    carousel.focus({ preventScroll:true });
    for (const [key, expected] of [["ArrowRight",3],["End",4],["Home",1],["ArrowLeft",1]]){
      carousel.dispatchEvent(new app.KeyboardEvent("keydown", { key, bubbles:true, cancelable:true }));
      assert(characterPosition() === `CARTA REGISTRADA ${expected}/4` && doc.activeElement === carousel,
        `El carrusel responde a ${key} sin mover el foco ni rebasar sus límites`);
    }
    assert(!characterDossier.open, "Cambiar de carta pliega el expediente anterior");
    const thirdCard = carousel.children[2];
    carousel.scrollTo({ left:thirdCard.offsetLeft - firstCard.offsetLeft, behavior:"auto" });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert(characterPosition() === "CARTA REGISTRADA 3/4" && doc.getElementById("characterDossierLabel").textContent.includes("Lolo"),
      "El desplazamiento horizontal nativo actualiza el indicador y el expediente de la carta");
    carousel.dispatchEvent(new app.KeyboardEvent("keydown", { key:"End", bubbles:true, cancelable:true }));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert(nextCharacter.disabled && !previousCharacter.disabled && characterPosition() === "CARTA REGISTRADA 4/4"
      && Math.abs(carousel.scrollLeft - (carousel.lastElementChild.offsetLeft - firstCard.offsetLeft)) < 2,
      "La última carta se alinea completa y no existe avance circular ni movimiento automático");
    carousel.dispatchEvent(new app.KeyboardEvent("keydown", { key:"Home", bubbles:true, cancelable:true }));
    characterCollection.open = false;
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
      assert(doc.getElementById("missionCharacter").hidden === !day.character,
        `Piso ${day.day}: solo presenta una carta cuando corresponde`);
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
      if (day.character){
        assert(doc.getElementById("characterStatus").textContent.includes(day.character.name)
          && doc.getElementById("characterInstruction").hidden
          && doc.getElementById("missionCharacter").classList.contains("character-reveal"),
          `Piso ${day.day}: completar revela la carta y anuncia el aliado registrado`);
      }
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
      assert(doc.querySelectorAll('#campaignCharacters [data-unlocked="true"]').length
        === data.days.filter(item => item.character && item.day <= day.day).length,
        `Piso ${day.day}: colección calculada sin registros ni recompensas adicionales`);
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
      for (const day of [1,3,5,9,10,12,14,18,23,24]){
        open(day);
        assert(doc.documentElement.scrollWidth <= app.innerWidth, `Piso ${day}: sin desbordamiento a ${width}px`);
      }
      app.App.openProfile();
      assert(doc.documentElement.scrollWidth <= app.innerWidth, `Perfil sin desbordamiento a ${width}px`);
      titlesTab.click();
      assert(doc.documentElement.scrollWidth <= app.innerWidth, `Pestaña Títulos sin desbordamiento a ${width}px`);
      inventoryTab.click();
      assert(doc.documentElement.scrollWidth <= app.innerWidth, `Pestaña Inventario sin desbordamiento a ${width}px`);
      const collection = doc.getElementById("charactersCard");
      assert(collection.tagName === "DIV" && !collection.querySelector(":scope > summary")
        && doc.getElementById("campaignCharacters").getBoundingClientRect().height > 0,
        `La colección permanece visible y no es desplegable a ${width}px`);
      if (width === 390){
        const heading = app.getComputedStyle(collection.querySelector("h2"));
        const attributes = app.getComputedStyle(doc.querySelector("#attributesCard h2"));
        const loot = app.getComputedStyle(doc.querySelector("#lootCard h2"));
        assert(Number(heading.fontWeight) >= 600 && heading.fontWeight === attributes.fontWeight
          && heading.fontWeight === loot.fontWeight && heading.fontSize === loot.fontSize,
          "El título de la colección usa la misma negrita y tamaño que características y botín");
      }
      assert(!doc.getElementById("lootCard").hidden
        && doc.getElementById("lootCard").getBoundingClientRect().bottom <= collection.getBoundingClientRect().top,
        `El botín de incursión aparece encima de la colección de cartas a ${width}px`);
      assert(doc.documentElement.scrollWidth <= app.innerWidth, `Galería de cartas sin desbordamiento a ${width}px`);
      assert(doc.querySelector(".character-controls").getBoundingClientRect().bottom
        <= doc.getElementById("campaignCharacters").getBoundingClientRect().top
        && !doc.getElementById("characterCount"),
        `Las flechas y el indicador están sobre las cartas sin un contador duplicado a ${width}px`);
      const nameplateCenters = { marujito:.555, chiquito:.58, lolo:.61, tombi:.56 };
      for (const art of doc.querySelectorAll("#campaignCharacters .character-art")){
        const name = art.querySelector(".character-name > span");
        const image = art.querySelector("img");
        const id = image.getAttribute("src").split("/").at(-1).replace(".webp", "");
        const range = doc.createRange();
        range.selectNodeContents(name);
        const bounds = range.getBoundingClientRect(), frame = art.getBoundingClientRect();
        assert(Math.abs(bounds.x + bounds.width / 2 - (frame.x + frame.width * nameplateCenters[id])) < 1
          && Math.abs(bounds.y + bounds.height / 2 - (frame.y + frame.height * .07)) < 1,
          `El nombre de ${id} se centra en su propia placa a ${width}px`);
      }
      for (const caption of doc.querySelectorAll("#campaignCharacters .character-plate > span")){
        assert(caption.getBoundingClientRect().height <= caption.parentElement.clientHeight + 1
          && caption.scrollWidth <= caption.clientWidth + 1,
          `El título de la carta se lee completo dentro de su placa a ${width}px`);
        const art = caption.closest(".character-art"), frame = art.getBoundingClientRect();
        const range = doc.createRange();
        range.selectNodeContents(caption);
        const bounds = range.getBoundingClientRect();
        assert(Math.abs(bounds.y + bounds.height / 2 - (frame.y + frame.height * .875)) < 1,
          `El título de ${art.querySelector(".character-name").textContent} se centra verticalmente en el hueco de la ilustración a ${width}px`);
      }
      doc.getElementById("characterDossier").open = true;
      assert(doc.documentElement.scrollWidth <= app.innerWidth, `Expedientes de cartas sin desbordamiento a ${width}px`);
      const strip = doc.getElementById("campaignCharacters");
      strip.dispatchEvent(new app.KeyboardEvent("keydown", { key:"End", bubbles:true, cancelable:true }));
      assert(doc.getElementById("characterPosition").textContent === "CARTA REGISTRADA 4/4"
        && doc.documentElement.scrollWidth <= app.innerWidth,
        `La última carta y sus controles caben a ${width}px`);
      strip.dispatchEvent(new app.KeyboardEvent("keydown", { key:"Home", bubbles:true, cancelable:true }));
    }
    frame.style.width = "390px";
    await load();
    app.App.openProfile();
    assert(doc.getElementById("profileFloors").textContent === "24 / 24" && record(14).executed, "Progreso, decisiones y actividades persisten tras recargar");
    assert(readStats().strength === 3 && readStats().wit === 14 && readStats().charm === 23,
      "Las mejoras persisten al recargar sin reabrir ni repetir las misiones");

    assert(doc.getElementById("backupSettings").hidden
      && app.getComputedStyle(doc.getElementById("backupSettings")).display === "none",
      "El perfil tampoco muestra una sección de copias manuales en el modo autor");
    const fullBackup = await exportBackup();
    const fullGold = doc.getElementById("profileGold").textContent;
    assert(fullBackup.format === "adventdcc-backup" && fullBackup.version === 1
      && fullBackup.mode === "preview" && fullBackup.campaign === data.campaign
      && fullBackup.records.length === 24 && Number.isFinite(Date.parse(fullBackup.exportedAt)),
      "La copia identifica su formato, campaña, fecha y modo y contiene los 24 pisos");
    assert(fullBackup.records.every(({day,state}) => JSON.stringify(state) === JSON.stringify(record(day))),
      "La exportación conserva respuestas, borradores, pistas, tirada, bonus y actividades exactamente");
    assert(Object.keys(fullBackup).sort().join(",") === "campaign,exportedAt,format,mode,records,version"
      && !JSON.stringify(fullBackup).includes("dcc_profile_"),
      "La copia no exporta ajustes, claves de navegador ni configuración de notificaciones");
    assert(fixture.downloads.at(-1).filename === "adventdcc-preview-2026-12-24.json"
      && fixture.downloads.at(-1).blob.type === "application/json",
      "La descarga usa JSON y un nombre fechado que identifica las pruebas");

    fresh(); await load(); app.App.openProfile();
    await chooseBackup(fullBackup);
    assert(!doc.getElementById("restorePreview").hidden && !doc.getElementById("restoreBackup").disabled
      && !fixture.session.getItem(previewKey("restored")),
      "Seleccionar una copia muestra la revisión sin guardar todavía");
    doc.getElementById("cancelRestore").click();
    assert(doc.getElementById("restorePreview").hidden && !fixture.session.getItem(previewKey("restored")),
      "Cancelar la revisión no modifica el progreso");
    await chooseBackup(fullBackup);
    doc.getElementById("restoreBackup").click();
    assert(fullBackup.records.every(({day,state}) => JSON.stringify(state) === JSON.stringify(record(day)))
      && doc.getElementById("profileFloors").textContent === "24 / 24",
      "Restaurar una copia vacía recupera exactamente todos los registros");
    assert(readStats().strength === 3 && readStats().wit === 14 && readStats().charm === 23
      && doc.getElementById("profileGold").textContent === fullGold,
      "Las características y monedas restauradas se calculan una sola vez");
    assert(fixture.local.getItem(key("restored")) === null && fixture.notifications.length === 0,
      "La restauración de pruebas no toca el progreso real ni envía avisos");
    await load(); app.App.openProfile();
    assert(record(14).executed && record(10).roll === fullBackup.records[9].state.roll
      && JSON.stringify(record(1).answers) === JSON.stringify(fullBackup.records[0].state.answers),
      "La restauración persiste al recargar, con actividad realizada, dado y respuestas intactos");
    const reexported = await exportBackup();
    assert(JSON.stringify(reexported.records) === JSON.stringify(fullBackup.records),
      "La exportación posterior incluye los registros restaurados");
    const restoredOnce = fixture.session.getItem(previewKey("restored"));
    await chooseBackup(fullBackup);
    assert(doc.getElementById("restoreBackup").disabled
      && doc.getElementById("backupStatus").textContent === app.STRINGS.backup.noChanges
      && fixture.session.getItem(previewKey("restored")) === restoredOnce,
      "Repetir la copia no escribe nada ni duplica los premios");
    doc.getElementById("cancelRestore").click();
    open(18);
    doc.querySelector("#missionResult button").click();
    assert(record(18).executed && fixture.session.getItem(previewKey(18))
      && !JSON.parse(restoredOnce).records.find(entry => entry.day === 18).state.executed,
      "Una actividad importada se puede realizar sin modificar la instantánea original");
    await load();
    assert(record(18).executed, "Los cambios posteriores tienen prioridad sobre la copia restaurada al recargar");
    app.App.openProfile();
    for (const width of [280,320,390]){
      frame.style.width = `${width}px`;
      doc.getElementById("backupSettings").open = true;
      await chooseBackup(fullBackup);
      assert(doc.documentElement.scrollWidth <= app.innerWidth, `Copias y revisión sin desbordamiento a ${width}px`);
    }
    frame.style.width = "390px";
    assert(fixture.errors.length === 0, "La exportación y restauración válidas no producen errores");

    fresh(); await load();
    const existing = { opened:true, completed:false, draft:{ warName:"Este borrador no se reemplaza" } };
    const empty = { opened:false, completed:false, draft:{} };
    fixture.session.setItem(previewKey(1), JSON.stringify(existing));
    fixture.session.setItem(previewKey(3), JSON.stringify(empty));
    await chooseBackup(fullBackup);
    const openedOnly = { opened:true, completed:false, draft:{} };
    fixture.session.setItem(previewKey(2), JSON.stringify(openedOnly));
    doc.getElementById("restoreBackup").click();
    const additions = JSON.parse(fixture.session.getItem(previewKey("restored"))).records;
    assert(additions.length === 21 && !additions.some(entry => [1,2,3].includes(entry.day))
      && JSON.stringify(record(1)) === JSON.stringify(existing)
      && JSON.stringify(record(2)) === JSON.stringify(openedOnly)
      && JSON.stringify(record(3)) === JSON.stringify(empty),
      "Se conservan borradores, registros vacíos y pisos abiertos incluso si aparecieron después de la revisión");
    assert(doc.getElementById("backupStatus").textContent.includes("21")
      && doc.getElementById("backupStatus").textContent.includes("3"),
      "El resultado informa de las cantidades reales añadidas y conservadas");
    await load();
    assert(JSON.stringify(record(1)) === JSON.stringify(existing) && record(24).completed,
      "La mezcla de datos existentes e importados persiste sin sobrescribir respuestas");

    fresh(); await load();
    await chooseBackup(fullBackup);
    fixture.session.failWrite = true;
    doc.getElementById("restoreBackup").click();
    assert(!fixture.session.getItem(previewKey("restored"))
      && !record(1).completed && !record(24).completed
      && doc.getElementById("backupStatus").dataset.state === "error"
      && !doc.getElementById("restoreBackup").disabled,
      "Un fallo de escritura no deja una restauración parcial y permite reintentar");
    fixture.session.failWrite = false;
    doc.getElementById("restoreBackup").click();
    assert(record(1).completed && record(24).completed, "Reintentar guarda la restauración completa");

    fresh(); await load();
    const invalidCopies = [
      ["JSON roto", "{dato roto", true],
      ["Formato", { ...fullBackup, format:"otro" }],
      ["Versión", { ...fullBackup, version:2 }],
      ["Campaña", { ...fullBackup, campaign:"otra" }],
      ["Modo", { ...fullBackup, mode:"campaign" }],
      ["Fecha", { ...fullBackup, exportedAt:"no es una fecha" }],
      ["Duplicado", { ...fullBackup, records:[fullBackup.records[0], fullBackup.records[0]] }],
      ["Piso desconocido", { ...fullBackup, records:[{ ...fullBackup.records[0], day:25 }] }],
      ["Estado ilegible", { ...fullBackup, records:[{ day:1, state:null }] }],
      ["Respuesta incorrecta", { ...fullBackup, records:[{ day:3, state:{
        ...fullBackup.records[2].state, answers:{choice:"pipo"}
      }}] }],
      ["Reparto inválido", { ...fullBackup, records:[{ day:1, state:{
        ...fullBackup.records[0].state, answers:{ ...fullBackup.records[0].state.answers, strength:"21" }
      }}] }],
      ["Dado incoherente", { ...fullBackup, records:[{ day:10, state:{ ...fullBackup.records[9].state, bonus:999 } }] }],
      ["Archivo demasiado grande", " ".repeat(1024 * 1024 + 1), true]
    ];
    for (const [label,copy,raw] of invalidCopies){
      await chooseBackup(copy, raw);
      assert(doc.getElementById("backupStatus").dataset.state === "error"
        && doc.getElementById("restorePreview").hidden && !fixture.session.getItem(previewKey("restored")),
        `${label}: se rechaza la copia sin escribir registros`);
    }
    const partialBackup = { ...fullBackup, records:[
      { day:2, state:{ opened:true, completed:false, draft:{ drink:"Una receta a medias" } } },
      { day:10, state:{ opened:true, completed:false, draft:{ face:"3" }, roll:3 } },
      { day:5, state:{ opened:true, completed:false, draft:{ answer:"Todavía no" }, hints:1 } }
    ] };
    await chooseBackup(partialBackup);
    doc.getElementById("restoreBackup").click();
    await load(); open(2);
    assert(doc.getElementById("mission-drink").value === "Una receta a medias" && !record(2).completed,
      "Los borradores sin completar se recuperan como borradores");
    open(10);
    assert(doc.getElementById("mission-face").readOnly && doc.getElementById("mission-face").value === "3",
      "Restaurar una tirada pendiente no permite volver a tirar");
    open(5);
    assert(record(5).hints === 1 && doc.getElementById("missionHints").textContent.includes(data.days[4].mission.hints[0]),
      "Las pistas usadas se recuperan sin resolver la misión");
    await chooseBackup(fullBackup);
    doc.getElementById("restoreBackup").click();
    assert(JSON.parse(fixture.session.getItem(previewKey("restored"))).records.length === 24
      && !record(2).completed && record(2).draft.drink === "Una receta a medias"
      && !record(10).completed && record(10).roll === 3 && record(5).hints === 1,
      "Una segunda copia añade solo los pisos ausentes y conserva los registros ya restaurados");

    fresh(); await load();
    const originalFileText = app.File.prototype.text;
    let finishOldRead;
    app.File.prototype.text = () => new Promise(resolve => { finishOldRead = resolve; });
    chooseFile(new app.File(["lectura pendiente"], "anterior.json", { type:"application/json" }));
    app.File.prototype.text = originalFileText;
    await chooseBackup(partialBackup);
    finishOldRead(JSON.stringify(fullBackup));
    await new Promise(resolve => setTimeout(resolve, 20));
    doc.getElementById("restoreBackup").click();
    assert(JSON.parse(fixture.session.getItem(previewKey("restored"))).records.length === 3,
      "Una lectura antigua no sustituye la copia seleccionada después");
    const beforeReadFailure = fixture.session.getItem(previewKey("restored"));
    app.File.prototype.text = () => Promise.reject(new Error("Fallo de lectura simulado"));
    await chooseBackup(fullBackup);
    app.File.prototype.text = originalFileText;
    assert(doc.getElementById("backupStatus").textContent === app.STRINGS.backup.readError
      && doc.getElementById("restorePreview").hidden
      && fixture.session.getItem(previewKey("restored")) === beforeReadFailure,
      "Un fallo al leer el archivo se informa y no modifica los datos existentes");

    fresh(); await load();
    const legacyBackup = JSON.parse(JSON.stringify(fullBackup));
    legacyBackup.records = [legacyBackup.records[0]];
    for (const id of ["strength","wit","charm"]){
      delete legacyBackup.records[0].state.answers[id];
      delete legacyBackup.records[0].state.draft[id];
    }
    await chooseBackup(legacyBackup);
    doc.getElementById("restoreBackup").click();
    app.App.openProfile();
    assert(record(1).completed && !doc.getElementById("profileStatSetup").hidden,
      "Se pueden restaurar contratos antiguos y fijar después sus puntos");

    fresh(false, "2026-12-02T12:00:00"); await load();
    await chooseBackup(fullBackup);
    assert(doc.getElementById("backupStatus").textContent === app.STRINGS.backup.wrongMode
      && !fixture.local.getItem(key("restored")), "El modo real rechaza las copias del modo autor");
    await chooseBackup({ ...fullBackup, mode:"campaign" });
    doc.getElementById("restoreBackup").click();
    app.App.openProfile();
    doc.querySelector('[data-day="3"]').click();
    assert(doc.getElementById("profileFloors").textContent === "2 / 24"
      && doc.querySelectorAll(".door").length === 3 && doc.querySelector('[data-day="3"]').classList.contains("locked")
      && !doc.getElementById("message").classList.contains("active")
      && !doc.getElementById("profile").textContent.includes("Paco Pecado"),
      "Restaurar no adelanta el calendario ni revela recompensas de pisos futuros");
    const realBackup = await exportBackup();
    assert(realBackup.mode === "campaign" && realBackup.records.length === 24
      && fixture.session.getItem(previewKey("restored")) === null && fixture.notifications.length === 0,
      "Las copias reales usan almacenamiento local y conservan también los registros futuros sin enviar avisos");
    fixture.local.setItem(key(2), "{registro roto");
    await load();
    const downloadCount = fixture.downloads.length, beforeRestore = fixture.local.getItem(key("restored"));
    doc.getElementById("exportBackup").click();
    await chooseBackup(realBackup);
    assert(fixture.downloads.length === downloadCount && doc.getElementById("backupStatus").dataset.state === "error"
      && fixture.local.getItem(key(2)) === "{registro roto" && fixture.local.getItem(key("restored")) === beforeRestore,
      "Los datos corruptos no se sobrescriben ni se omiten silenciosamente en una exportación");

    fresh(); fixture.session.setItem(previewKey("restored"), "{copia rota"); await load();
    open(2);
    assert(doc.getElementById("missionForm").hidden
      && fixture.session.getItem(previewKey("restored")) === "{copia rota",
      "Una instantánea corrupta se informa y se preserva sin permitir sobrescribir pisos afectados");

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
    assert(doc.querySelectorAll("#campaignCharacters .character-sealed").length === 4
      && !doc.querySelector("#campaignCharacters img")
      && !/Marujito|Lolo|Chiquito|Tombi/.test(doc.getElementById("campaignCharacters").textContent),
      "Las cartas bloqueadas usan siluetas genéricas sin nombres, textos ni ilustraciones futuras");
    doc.getElementById("characterNext").click();
    assert(doc.getElementById("characterDossier").hidden
      && !/Marujito|Lolo|Chiquito|Tombi/.test(doc.getElementById("characterDossier").textContent),
      "Navegar entre siluetas no permite abrir expedientes ni descubrir identidades");

    fresh(false); await load();
    open(5);
    assert(doc.getElementById("characterStatus").textContent === app.STRINGS.cards.introduction
      && !doc.getElementById("characterInstruction").hidden && !record(5).completed,
      "Entrar en el piso presenta a Marujito, pero no registra su carta");
    set("answer", data.days[4].mission.answers[0]);
    fixture.local.failWrite = true; submit();
    app.App.openProfile();
    assert(doc.querySelectorAll("#campaignCharacters .character-entry").length === 0,
      "Un fallo de guardado no desbloquea cartas");
    fixture.local.failWrite = false;
    open(5); submit();
    const completedCard = JSON.stringify(record(5));
    submit();
    app.App.openProfile();
    assert(doc.querySelectorAll("#campaignCharacters .character-entry").length === 1
      && doc.querySelectorAll("#campaignCharacters .character-sealed").length === 3
      && doc.getElementById("characterPosition").textContent === "CARTA REGISTRADA 1/4"
      && JSON.stringify(record(5)) === completedCard,
      "Marujito se registra una sola vez; los otros tres personajes siguen sin identificarse");
    assert(!doc.getElementById("characterDossier").hidden
      && doc.getElementById("characterDossierLabel").textContent.includes("Marujito"),
      "Una carta registrada ofrece su expediente en el carrusel");
    doc.getElementById("characterDossier").open = true;
    doc.getElementById("characterNext").click();
    assert(doc.getElementById("characterDossier").hidden && !doc.getElementById("characterDossier").open
      && doc.getElementById("characterDossierContent").childElementCount === 0
      && doc.getElementById("characterPosition").textContent === "CARTA SELLADA 2/4",
      "Pasar de una carta registrada a otra sellada cierra y vacía el expediente");
    await load(); open(5);
    assert(!doc.getElementById("missionCharacter").classList.contains("character-reveal")
      && doc.getElementById("characterStatus").textContent === app.STRINGS.cards.registered,
      "Reabrir una misión conserva la carta sin repetir su celebración");
    fixture.date = "2026-12-04T12:00:00"; await load();
    app.App.openProfile();
    assert(!doc.querySelector("#campaignCharacters img")
      && doc.querySelectorAll('#campaignCharacters [data-unlocked="true"]').length === 0,
      "Un registro de un piso futuro no revela su personaje antes de fecha");
    fixture.date = "2026-12-05T12:00:00"; await load();
    app.App.openProfile();
    assert(doc.querySelectorAll("#campaignCharacters .character-entry").length === 1
      && doc.getElementById("campaignCharacters").textContent.includes("Marujito"),
      "La colección se recupera del progreso existente al estar disponible el piso");

    fresh(false); privateBackup({fragment:true}); await load(); await waitSync("saved");
    assert(!app.location.hash.includes("backupKey")
      && fixture.local.getItem(`dcc_sync_access_${data.campaign}`) === "b".repeat(64)
      && !JSON.stringify(app.CONFIG).includes("b".repeat(64)),
      "El enlace personal activa la copia sin incluir la clave en la configuración pública ni conservarla en la URL");
    app.App.openProfile();
    assert(doc.getElementById("backupSettings").hidden,
      "Samu no ve controles de descarga, importación ni gestión manual de copias");
    open(2);
    set("drink","Primera versión"); set("drink","Última versión");
    await waitSync("saved");
    assert(fixture.sync.snapshot.records.find(entry => entry.day === 2).state.draft.drink === "Última versión"
      && fixture.sync.requests.filter(request => request.method === "PUT" && JSON.parse(request.body).changes.length).length === 1,
      "Escribir guarda localmente y envía automáticamente la última respuesta, agrupando las pulsaciones");
    fill(data.days[1]); submit();
    await waitSync("saved");
    const remoteDay2 = JSON.parse(JSON.stringify(fixture.sync.snapshot.records.find(entry => entry.day === 2)));
    assert(remoteDay2.state.completed && record(2).completed
      && fixture.sync.requests.every(request => request.authorization === `Bearer ${"b".repeat(64)}`),
      "Completar una misión actualiza la copia privada con autenticación y conserva el progreso local");
    const writesBeforeReload = fixture.sync.requests.filter(request => request.method === "PUT").length;
    await load(); await waitSync("saved");
    assert(fixture.sync.requests.filter(request => request.method === "PUT").length === writesBeforeReload,
      "Recargar no reenvía ni duplica respuestas ya copiadas");

    fresh(false); privateBackup({key:false}); await load(); await waitSync("missingKey");
    assert(fixture.sync.requests.length === 0 && doc.getElementById("backupSettings").hidden,
      "Sin enlace personal no se consulta ni modifica la copia privada");
    fresh(); privateBackup(); await load(); await waitSync("preview");
    open(2); set("drink","Solo prueba");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert(fixture.sync.requests.length === 0 && doc.getElementById("backupSettings").hidden,
      "El modo autor no muestra copias manuales ni envía progreso de prueba, aunque exista una clave real");

    fresh(false); privateBackup({records:[remoteDay2]}); await load(); await waitSync("saved");
    open(2);
    assert(record(2).completed && doc.getElementById("mission-drink").value === remoteDay2.state.answers.drink
      && fixture.sync.requests.every(request => request.method === "GET"),
      "Un navegador nuevo recupera automáticamente los pisos ausentes sin volver a conceder premios");
    assert(fixture.errors.length === 0 && fixture.notifications.length === 0,
      "La copia y recuperación automáticas no producen errores ni notificaciones de misión");

    fresh(false); privateBackup({records:[{day:5,revision:1,state:JSON.parse(completedCard)}]});
    await load(); await waitSync("saved");
    app.App.openProfile();
    assert(doc.querySelectorAll('#campaignCharacters [data-unlocked="true"]').length === 1
      && doc.getElementById("campaignCharacters").textContent.includes("Marujito"),
      "Restaurar una misión desde la copia privada recupera su carta sin guardar otra colección");
    open(5);
    assert(doc.getElementById("characterStatus").textContent === app.STRINGS.cards.registered
      && !doc.getElementById("missionCharacter").classList.contains("character-reveal"),
      "La carta recuperada se muestra registrada sin celebrar ni volver a conceder el premio");

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

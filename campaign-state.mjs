export function normalizeAnswer(value){
  return (value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().replace(/\s+/g, " ");
}

export function sameState(left, right){
  function ordered(value){
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === "object"){
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
    }
    return value;
  }
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

export function validPointAllocation(mission, answers){
  const budget = mission.pointBudget;
  if (!budget || !answers) return false;
  return budget.fields.every(id => {
    const field = mission.fields.find(field => field.id === id);
    return typeof answers[id] === "string" && /^\d+$/.test(answers[id])
      && Number(answers[id]) >= field.min && Number(answers[id]) <= field.max;
  }) && budget.fields.reduce((sum, id) => sum + Number(answers[id]), 0) === budget.total;
}

export function validateRecord(day, record){
  const validAnswers = value => value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === "boolean" || (typeof item === "string" && item.length <= 20000));
  if (!record || Array.isArray(record) || typeof record.opened !== "boolean" || typeof record.completed !== "boolean"
      || !validAnswers(record.draft) || (record.answers !== undefined && !validAnswers(record.answers))
      || (record.completed && (!record.opened || !record.answers || typeof record.outcome !== "string"))
      || (record.outcome !== undefined && (typeof record.outcome !== "string" || record.outcome.length > 20000))
      || (record.bonus !== undefined && (!Number.isSafeInteger(record.bonus) || record.bonus < 0))
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
}

export function validateCampaignRecord(day, record){
  validateRecord(day, record);
  const allowed = ["opened","completed","draft","answers","outcome","bonus","roll","executed","hints"];
  const mission = day.mission;
  const answerIds = mission.type === "form" ? mission.fields.map(field => field.id)
    : [mission.type === "choice" ? "choice" : mission.type === "dice" ? "face" : "answer"];
  if (Object.keys(record).some(key => !allowed.includes(key))
      || [record.draft, record.answers].filter(Boolean).some(value => Object.keys(value).some(key => !answerIds.includes(key)))
      || (record.hints || 0) > (mission.hints || []).length
      || (record.roll !== undefined && mission.type !== "dice")
      || (record.executed && (!record.completed || !(mission.cooperative || (mission.private && record.answers.choice !== "decline"))))){
    throw new Error("Registro incompatible con la misión.");
  }
  if (!record.completed) return;
  const answers = record.answers;
  if (mission.type === "form"){
    const legacyPoints = mission.pointBudget && mission.pointBudget.fields.every(id => !Object.hasOwn(answers, id));
    for (const field of mission.fields){
      if (legacyPoints && mission.pointBudget.fields.includes(field.id)) continue;
      const value = answers[field.id];
      const required = field.required !== false || !!(field.requiredWhen && answers[field.requiredWhen.field] === field.requiredWhen.value);
      if (!required && (value === undefined || value === "")) continue;
      const valid = field.type === "checkbox" ? typeof value === "boolean" && (!required || value)
        : typeof value === "string" && (!required || !!value.trim())
          && (!field.maxLength || value.length <= field.maxLength)
          && (!field.options || field.options.some(option => option.id === value))
          && (field.type !== "number" || (/^\d+$/.test(value) && Number(value) >= field.min && Number(value) <= field.max));
      if (!valid) throw new Error(`Respuesta no válida: ${field.id}`);
    }
  }
  if (mission.type === "choice" && (!mission.options.some(option => option.id === answers.choice)
      || (mission.answer && mission.answer !== answers.choice))){
    throw new Error("Elección no válida.");
  }
  const guess = mission.type === "puzzle" ? answers.answer : mission.checkField ? answers[mission.checkField] : null;
  if (guess !== null && (typeof guess !== "string" || !mission.answers.map(normalizeAnswer).includes(normalizeAnswer(guess)))){
    throw new Error("Respuesta de acertijo no válida.");
  }
  const bonus = record.bonus || 0;
  if (mission.type === "dice"){
    const result = mission.results.find(result => result.face === Number(answers.face));
    if (!result || record.roll !== result.face || bonus !== result.gold) throw new Error("Tirada no válida.");
  } else if (mission.portalBonus ? ![0, ...Object.values(mission.portalBonus)].includes(bonus) : bonus !== 0){
    throw new Error("Bonificación no válida.");
  }
}

export function validateTransition(day, previous, next){
  validateCampaignRecord(day, next);
  if (!previous) return;
  if ((previous.opened && !next.opened) || (previous.completed && !next.completed)
      || (previous.executed && !next.executed) || (previous.roll && previous.roll !== next.roll)
      || (next.hints || 0) < (previous.hints || 0)){
    throw new Error("El progreso no puede retroceder.");
  }
  if (!previous.completed) return;
  const oldAnswers = { ...previous.answers }, newAnswers = { ...next.answers };
  const budget = day.mission.pointBudget;
  const legacy = budget && budget.fields.every(id => !Object.hasOwn(oldAnswers, id));
  if (legacy){
    for (const id of budget.fields){ delete oldAnswers[id]; delete newAnswers[id]; }
  }
  if (!sameState(oldAnswers, newAnswers) || previous.outcome !== next.outcome
      || (previous.bonus || 0) !== (next.bonus || 0) || !sameState(next.draft, next.answers)){
    throw new Error("Las respuestas completadas no se pueden reemplazar.");
  }
}

export function validateSnapshot(data, campaign){
  if (!data || data.format !== "adventdcc-progress" || data.version !== 1 || data.campaign !== campaign.campaign
      || !Number.isSafeInteger(data.revision) || data.revision < 0
      || typeof data.updatedAt !== "string" || !Number.isFinite(Date.parse(data.updatedAt))
      || !Array.isArray(data.records) || data.records.length > campaign.days.length){
    throw new Error("Copia privada no válida.");
  }
  const records = new Map();
  for (const entry of data.records){
    const day = entry && campaign.days.find(day => day.day === entry.day);
    if (!day || records.has(entry.day) || !Number.isSafeInteger(entry.revision)
        || entry.revision < 1 || entry.revision > data.revision){
      throw new Error("Versión de registro no válida.");
    }
    validateCampaignRecord(day, entry.state);
    records.set(entry.day, entry);
  }
  return records;
}

const ids = new Set(["lolo", "marujito", "chiquito", "tombi"]);
const limits = { id:20, name:40, title:120, image:80, description:2000, relationship:2000, note:2000 };

export function validateCharacter(character){
  if (!character || typeof character !== "object" || Array.isArray(character)
      || Object.keys(character).length !== Object.keys(limits).length
      || Object.entries(limits).some(([key, max]) =>
        typeof character[key] !== "string" || !character[key].trim() || character[key].length > max)
      || !ids.has(character.id) || character.image !== `assets/cards/${character.id}.webp`){
    throw new Error("La carta debe tener un personaje, una ilustración local y todos sus textos válidos.");
  }
}

export function validateCharacters(days){
  const seen = new Set();
  for (const day of days){
    if (day.character === undefined) continue;
    validateCharacter(day.character);
    if (seen.has(day.character.id)) throw new Error("Una carta no puede aparecer en varios pisos.");
    seen.add(day.character.id);
  }
}

export function characterEntries(days, through, completed){
  return days.filter(day => day.character).map(day => ({
    day, character:day.character, unlocked:day.day <= through && completed(day)
  }));
}

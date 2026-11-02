import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateCharacter, validateCharacters, characterEntries } from "../character-cards.mjs";

const { days } = JSON.parse(await readFile(new URL("../days.json", import.meta.url), "utf8"));
const cards = days.filter(day => day.character);

test("las cuatro cartas corresponden a sus pisos e ilustraciones locales", async () => {
  validateCharacters(days);
  assert.deepEqual(cards.map(day => [day.day, day.character.id]),
    [[5,"marujito"],[9,"chiquito"],[12,"lolo"],[23,"tombi"]]);
  for (const day of cards){
    const image = await readFile(new URL(`../${day.character.image}`, import.meta.url));
    assert.equal(image.toString("ascii", 0, 4), "RIFF");
    assert.equal(image.toString("ascii", 8, 12), "WEBP");
    assert.ok(image.length < 150000);
    assert.ok(!day.character.name.includes("Gemma"));
  }
});

test("abrir o completar un piso futuro no registra una carta disponible", () => {
  assert.equal(characterEntries(days, 24, () => false).filter(entry => entry.unlocked).length, 0);
  assert.equal(characterEntries(days, 4, () => true).filter(entry => entry.unlocked).length, 0);
  assert.deepEqual(characterEntries(days, 12, day => [5,12,23].includes(day.day))
    .filter(entry => entry.unlocked).map(entry => entry.character.id), ["marujito","lolo"]);
  assert.equal(characterEntries(days, 24, () => true).filter(entry => entry.unlocked).length, 4);
});

test("la colección se deriva sin añadir ni modificar datos de progreso", () => {
  const completed = new Set([23]);
  const initial = JSON.stringify(days);
  const first = characterEntries(days, 24, day => completed.has(day.day));
  const second = characterEntries(days, 24, day => completed.has(day.day));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(days), initial);
  assert.deepEqual(first.filter(entry => entry.unlocked).map(entry => entry.character.id), ["tombi"]);
  completed.delete(23);
  assert.equal(characterEntries(days, 24, day => completed.has(day.day)).some(entry => entry.unlocked), false);
});

test("se rechazan cartas duplicadas, imágenes externas y textos incompletos", () => {
  const original = cards[0].character;
  for (const changed of [
    { ...original, image:"https://example.com/carta.webp" },
    { ...original, id:"desconocido" },
    { ...original, name:"" },
    { ...original, title:"x".repeat(121) },
    { ...original, note:null },
    { ...original, extra:"no permitido" }
  ]) assert.throws(() => validateCharacter(changed));
  assert.throws(() => validateCharacters([...days, cards[0]]));
});

test("el itinerario sitúa el regreso, la casa rural y el cierre familiar sin adelantar a Tombi", () => {
  assert.match(days[1].message, /Corea del Sur → Barcelona/);
  assert.match(days[1].message, /Hoy vuelves a Barcelona/);
  assert.ok(!days[1].message.includes("Sigues en Corea"));
  for (const day of days.filter(day => day.day >= 5 && day.day <= 8)){
    assert.match(day.message, /rural/);
    assert.match(day.message, /El Ejido/);
  }
  for (const day of days.filter(day => day.day >= 9 && day.day <= 19)) assert.match(day.message, /Barcelona/);
  for (const day of days.filter(day => day.day >= 20)) assert.match(day.message, /familia/);
  assert.ok(days.filter(day => day.day < 20).every(day => !day.character || day.character.id !== "tombi"));
  assert.match(days[19].reward.physical, /antes de partir/);
  assert.match(days[23].mission.success, /Si no llevaste el sobre/);
  assert.ok(days.filter(day => day.day < 24).every(day => !JSON.stringify(day).includes("Paco Pecado")));
});

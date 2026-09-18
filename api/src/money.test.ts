import assert from "node:assert/strict";
import test from "node:test";
import { Decimal } from "decimal.js";
import { coherent, lireMontant, q, texte, tvaAttendue } from "./money.js";

test("lit les montants abimes par l'OCR", () => {
  assert.equal(lireMontant("34 828.0!")?.toString(), "34828");
  assert.equal(lireMontant("3 840,00")?.toString(), "3840");
  assert.equal(lireMontant("-12 273.54")?.toString(), "-12273.54");
  assert.equal(lireMontant("illisible"), null);
});

test("calcule la TVA sans flottant", () => {
  assert.equal(tvaAttendue(new Decimal("3200"), 20).toFixed(2), "640.00");
  assert.equal(tvaAttendue(new Decimal("2515.80"), 10).toFixed(2), "251.58");
});

test("controle la coherence HT + TVA = TTC", () => {
  const d = (v: string) => new Decimal(v);
  assert.ok(coherent(d("3200"), d("640"), d("3840")));
  assert.ok(coherent(d("34828.01"), d("6965.60"), d("41793.61")));
  assert.ok(!coherent(d("21076.91"), d("4"), d("25292.29")));
});

test("stocke les montants en chaine a deux decimales", () => {
  assert.equal(texte(q("1807380.175")), "1807380.18");
  assert.equal(texte(null), null);
});

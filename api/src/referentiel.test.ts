import assert from "node:assert/strict";
import test from "node:test";
import {
  FOURNISSEURS,
  fichiersPieces,
  fichiersReleves,
  identifierFournisseur,
  normaliser,
} from "./referentiel.js";

test("charge les quinze fournisseurs du referentiel", () => {
  assert.equal(FOURNISSEURS.size, 15);
});

test("identifie un fournisseur malgre l'accent et l'OCR", () => {
  assert.equal(identifierFournisseur("BUREAU VERITAS, MAROC")?.fournisseur, "BUREAU VERITAS MAROC");
  assert.equal(identifierFournisseur("ENERGIE PLUS\nICE 008")?.tauxTvaHabituel, 14);
  assert.equal(identifierFournisseur("STE NOUVELLE NEGOCE"), null);
});

test("normalise les libelles bancaires", () => {
  assert.equal(normaliser("VIR SOMAFER SARL — REGROUPEMENT"), "VIR SOMAFER SARL REGROUPEMENT");
});

test("trouve le corpus sur le disque", () => {
  assert.equal(fichiersPieces().length, 107);
  assert.equal(fichiersReleves().length, 6);
});

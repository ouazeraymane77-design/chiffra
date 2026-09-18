/**
 * Les scenarios que le jury annonce, transformes en tests.
 * Ils tournent sur le corpus fourni, sans Redis ni Postgres ni modele.
 */
import assert from "node:assert/strict";
import test, { before, describe } from "node:test";
import { Decimal } from "decimal.js";
import { auditer, expositionTotale, type Anomalie } from "./audit.js";
import { ingerer, SOURCES_SURES, FACTEUR_INVRAISEMBLABLE, type Piece } from "./ingest.js";
import { q, tvaAttendue } from "./money.js";
import { rapprocher, type Rapprochement } from "./reconcile.js";
import { fichiersPieces } from "./referentiel.js";

let pieces: Piece[];
let resultat: Rapprochement;
let anomalies: Anomalie[];

const famillesDe = (docId: string) =>
  new Set(anomalies.filter((a) => a.docId === docId).map((a) => a.famille));

before(async () => {
  pieces = [];
  for (const chemin of fichiersPieces()) pieces.push(await ingerer(chemin));
  resultat = rapprocher(pieces);
  anomalies = auditer(pieces);
}, { timeout: 180_000 });

describe("lecture honnete", () => {
  test("une piece illisible ne produit aucun montant", () => {
    for (const piece of pieces.filter((p) => p.statut !== "traite")) {
      assert.ok(piece.motif, `${piece.docId} sans motif`);
      assert.equal(piece.ttc, null, `${piece.docId} porte un montant invente`);
    }
  });

  test("aucun montant lu sur image ne depasse l'historique du tiers", () => {
    for (const piece of pieces) {
      if (piece.statut !== "traite" || !piece.fiche) continue;
      if (SOURCES_SURES.includes(piece.sourceExtraction!)) continue;
      const plafond = piece.fiche.montantMoyenTtc.times(FACTEUR_INVRAISEMBLABLE);
      assert.ok(
        piece.ttc!.abs().lessThanOrEqualTo(plafond),
        `${piece.docId} retenu a ${piece.ttc} alors que le plafond est ${plafond}`
      );
    }
  });

  test("une facture normale est laissee tranquille", () => {
    assert.equal(famillesDe("DOC-002").size, 0);
  });

  test("un taux reduit legitime n'est pas signale", () => {
    assert.ok(!famillesDe("DOC-078").has("tva_erronee"));
  });
});

describe("controles fiscaux", () => {
  test("doublon exact detecte et jamais fusionne", () => {
    const doublons = anomalies.filter((a) => a.famille === "doublon_exact");
    assert.ok(doublons.length > 0);
    assert.ok(doublons.every((a) => a.pieceLiee));
  });

  test("quasi-doublon signale avec une confiance intermediaire", () => {
    const probables = anomalies.filter((a) => a.famille === "doublon_probable");
    assert.ok(probables.length > 0);
    assert.ok(probables.every((a) => a.confiance > 0 && a.confiance < 1));
  });

  test("TVA au mauvais taux chiffree par le code", () => {
    const parId = new Map(pieces.map((p) => [p.docId, p]));
    const erreurs = anomalies.filter((a) => a.famille === "tva_erronee");
    assert.ok(erreurs.length > 0);
    for (const a of erreurs) {
      const piece = parId.get(a.docId)!;
      const attendu = tvaAttendue(piece.ht!.abs(), piece.fiche!.tauxTvaHabituel)
        .minus(piece.tva!.abs())
        .abs();
      assert.equal(a.expositionMad.toFixed(2), q(attendu).toFixed(2));
    }
  });

  test("piece hors exercice detectee", () => {
    const hors = anomalies.filter((a) => a.famille === "hors_periode");
    assert.ok(hors.length > 0);
    assert.ok(hors.every((a) => a.date! < "2026-01-01" || a.date! > "2026-06-30"));
  });

  test("tiers absent du referentiel detecte", () => {
    assert.ok(anomalies.some((a) => a.famille === "tiers_inconnu"));
  });

  test("au moins cinq familles d'anomalies (EX-04)", () => {
    assert.ok(new Set(anomalies.map((a) => a.famille)).size >= 5);
  });
});

describe("rapprochement bancaire", () => {
  test("les lignes hors achats ne sont jamais rapprochees (regle 12)", () => {
    const ignorees = resultat.lignes.filter((l) => l.horsAchats);
    assert.ok(ignorees.length > 0);
    assert.ok(ignorees.every((l) => l.affectations.length === 0));
  });

  test("le taux de rapprochement est calcule sur le reel", () => {
    const attendu =
      Math.round((1000 * resultat.facturesRapprochees) / resultat.facturesRapprochables) / 10;
    assert.equal(resultat.tauxRapprochement, attendu);
    assert.ok(resultat.tauxRapprochement < 100, "un taux de 100 % cacherait le reste");
  });

  test("un paiement partiel laisse un solde du", () => {
    const partiels = pieces.filter((p) => p.rapprochement === "partiel");
    assert.ok(partiels.length > 0);
    for (const piece of partiels) {
      assert.ok(piece.resteDu!.greaterThan(0));
      assert.equal(
        q(piece.montantPaye!.plus(piece.resteDu!)).toFixed(2),
        q(piece.ttc!).toFixed(2)
      );
    }
  });

  test("le residuel bancaire est calcule par le code", () => {
    for (const ligne of resultat.lignes) {
      const affecte = ligne.affectations.reduce(
        (somme, a) => somme.plus(a.montant),
        new Decimal(0)
      );
      assert.equal(
        q(affecte.plus(ligne.resteAAffecter)).toFixed(2),
        q(ligne.debit).toFixed(2)
      );
    }
  });
});

describe("chiffrage et apprentissage", () => {
  test("une meme piece n'est jamais comptee deux fois", () => {
    const parPiece = new Map<string, Decimal>();
    for (const a of anomalies) {
      const actuelle = parPiece.get(a.docId);
      if (!actuelle || a.expositionMad.greaterThan(actuelle)) {
        parPiece.set(a.docId, a.expositionMad);
      }
    }
    const attendu = [...parPiece.values()].reduce((t, m) => t.plus(m), new Decimal(0));
    assert.equal(expositionTotale(anomalies).toFixed(2), q(attendu).toFixed(2));
  });

  test("un rejet abaisse la confiance des cas suivants (EX-06)", () => {
    const cible = anomalies.find((a) => a.famille === "doublon_probable")!;
    const apres = auditer(pieces, [
      { fournisseur: cible.fournisseur, famille: cible.famille, verdict: "rejete" },
    ]);
    const revu = apres.find((a) => a.docId === cible.docId && a.famille === cible.famille)!;
    assert.ok(revu.confiance < cible.confiance);
  });
});

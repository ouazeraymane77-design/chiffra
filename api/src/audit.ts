/**
 * Agent Auditor — applique le referentiel fiscal et chiffre l'exposition.
 *
 * Aucun appel au modele. Chaque anomalie porte la regle qui la fonde, une
 * exposition en dirhams calculee en Decimal, et un niveau de confiance abaisse
 * par les rejets deja prononces (EX-06).
 *
 * Convention d'exposition : le risque, c'est la TVA que l'administration peut
 * refuser en deduction, ou le redressement d'assiette. Jamais le TTC entier.
 */
import { Decimal } from "decimal.js";
import { q, tvaAttendue, ZERO, type Montant } from "./money.js";
import type { Piece } from "./ingest.js";
import { lireDate } from "./reconcile.js";
import { PERIODE_DEBUT, PERIODE_FIN } from "./referentiel.js";

const ECART_DOUBLON_JOURS = 7;
const FACTEUR_ABERRANT = new Decimal(10);

export type Famille =
  | "doublon_exact"
  | "doublon_probable"
  | "tva_erronee"
  | "tva_incoherente"
  | "hors_periode"
  | "tiers_inconnu"
  | "montant_aberrant"
  | "ice_manquant"
  | "document_non_traite";

const FAMILLES: Record<Famille, { libelle: string; regle: string }> = {
  doublon_exact: { libelle: "Doublon exact", regle: "regle 6" },
  doublon_probable: { libelle: "Doublon probable", regle: "regle 5" },
  tva_erronee: { libelle: "TVA au mauvais taux", regle: "taux par categorie" },
  tva_incoherente: { libelle: "TVA incoherente avec la base HT", regle: "regle 2" },
  hors_periode: { libelle: "Piece hors exercice", regle: "regle 4" },
  tiers_inconnu: { libelle: "Tiers absent du referentiel", regle: "regle 3" },
  montant_aberrant: { libelle: "Montant aberrant", regle: "regle 7" },
  ice_manquant: { libelle: "ICE fournisseur absent", regle: "regle 3" },
  document_non_traite: { libelle: "Document non exploitable", regle: "EX-08" },
};

export interface Anomalie {
  docId: string;
  fichier: string;
  famille: Famille;
  libelle: string;
  regle: string;
  fournisseur: string | null;
  date: string | null;
  numero: string | null;
  ttc: string | null;
  expositionMad: Montant;
  confiance: number;
  detail: string;
  pieceLiee: string | null;
  statutRevue: "a_arbitrer" | "masquee_apres_rejets";
  apprentissage?: string;
  action?: string;
  actionSource?: string;
}

export interface Decision {
  fournisseur: string | null;
  famille: string;
  verdict: "valide" | "rejete";
}

function anomalie(
  piece: Piece,
  famille: Famille,
  exposition: Montant,
  confiance: number,
  detail: string,
  pieceLiee: string | null = null
): Anomalie {
  return {
    docId: piece.docId,
    fichier: piece.fichier,
    famille,
    libelle: FAMILLES[famille].libelle,
    regle: FAMILLES[famille].regle,
    fournisseur: piece.tiersLibelle,
    date: piece.date,
    numero: piece.numero,
    ttc: piece.ttc ? piece.ttc.toFixed(2) : null,
    expositionMad: q(exposition),
    confiance: Math.round(confiance * 100) / 100,
    detail,
    pieceLiee,
    statutRevue: "a_arbitrer",
  };
}

// ------------------------------------------------------------ controles piece

export function controlerPiece(piece: Piece): Anomalie[] {
  const anomalies: Anomalie[] = [];

  if (piece.statut !== "traite") {
    anomalies.push(
      anomalie(
        piece,
        "document_non_traite",
        ZERO,
        1,
        `Lecture impossible : ${piece.motif}. Aucun montant n'a ete retenu, ` +
          `la piece reste dans la file humaine.`
      )
    );
    return anomalies;
  }

  const { fiche, ht, tva, ttc, tauxTva } = piece;
  const tvaAbs = tva ? tva.abs() : null;

  // Tiers absent du referentiel (regle 3).
  if (!fiche) {
    anomalies.push(
      anomalie(
        piece,
        "tiers_inconnu",
        tvaAbs ?? ZERO,
        0.9,
        `« ${piece.tiersLibelle} » ne figure pas dans le referentiel ` +
          `fournisseurs. La deduction de TVA est a justifier.`
      )
    );
  }

  // ICE fournisseur (regles 1 et 3).
  if (!piece.iceFournisseur) {
    anomalies.push(
      anomalie(
        piece,
        "ice_manquant",
        tvaAbs ?? ZERO,
        0.95,
        "Aucun ICE fournisseur lisible sur la piece : elle n'ouvre pas droit " +
          "a deduction en l'etat."
      )
    );
  }

  // Taux de TVA face a la categorie du fournisseur.
  if (fiche && tauxTva !== null && ht) {
    if (tauxTva !== fiche.tauxTvaHabituel) {
      const ecart = tvaAttendue(ht.abs(), fiche.tauxTvaHabituel)
        .minus(tvaAbs ?? ZERO)
        .abs();
      anomalies.push(
        anomalie(
          piece,
          "tva_erronee",
          ecart,
          0.95,
          `TVA a ${tauxTva} % alors que la categorie « ${fiche.categorie} » ` +
            `releve du taux de ${fiche.tauxTvaHabituel} %. Redressement ` +
            `d'assiette calcule sur une base HT de ${q(ht.abs()).toFixed(2)} MAD.`
        )
      );
    }
  }

  // Coherence interne : TVA = HT x taux.
  if (tauxTva !== null && ht && tva) {
    const ecart = tva.abs().minus(tvaAttendue(ht.abs(), tauxTva)).abs();
    if (ecart.greaterThan("0.02")) {
      anomalies.push(
        anomalie(
          piece,
          "tva_incoherente",
          ecart,
          0.85,
          `La TVA portee (${q(tva.abs()).toFixed(2)} MAD) ne correspond pas a ` +
            `${tauxTva} % de la base HT (${tvaAttendue(ht.abs(), tauxTva).toFixed(2)} MAD).`
        )
      );
    }
  }

  // Periode (regle 4).
  if (piece.date && (piece.date < PERIODE_DEBUT || piece.date > PERIODE_FIN)) {
    anomalies.push(
      anomalie(
        piece,
        "hors_periode",
        tvaAbs ?? ZERO,
        1,
        `Piece datee du ${piece.date}, hors exercice ${PERIODE_DEBUT} au ` +
          `${PERIODE_FIN} : non imputable.`
      )
    );
  }

  // Montant aberrant (regle 7).
  if (fiche && ttc) {
    const plafond = q(fiche.montantMoyenTtc.times(FACTEUR_ABERRANT));
    if (ttc.abs().greaterThan(plafond)) {
      anomalies.push(
        anomalie(
          piece,
          "montant_aberrant",
          tvaAbs ?? ZERO,
          0.8,
          `TTC de ${q(ttc.abs()).toFixed(2)} MAD contre une moyenne historique ` +
            `de ${fiche.montantMoyenTtc.toFixed(2)} MAD (plafond ${plafond.toFixed(2)} MAD).`
        )
      );
    }
  }
  return anomalies;
}

// ------------------------------------------------------------------ doublons

/** Regles 5 et 6. On ne fusionne jamais : on signale avec une confiance. */
export function detecterDoublons(pieces: Piece[]): Anomalie[] {
  const anomalies: Anomalie[] = [];
  const parTiers = new Map<string, Piece[]>();

  for (const piece of pieces) {
    if (piece.statut !== "traite" || !piece.ttc || piece.typePiece !== "facture") continue;
    const cle = piece.tiersLibelle ?? "";
    parTiers.set(cle, [...(parTiers.get(cle) ?? []), piece]);
  }

  for (const groupe of parTiers.values()) {
    const ordonne = [...groupe].sort((a, b) =>
      `${a.date}${a.docId}`.localeCompare(`${b.date}${b.docId}`)
    );
    for (let i = 0; i < ordonne.length; i += 1) {
      for (let j = i + 1; j < ordonne.length; j += 1) {
        const a = ordonne[i];
        const b = ordonne[j];
        if (!q(a.ttc!).equals(q(b.ttc!))) continue;
        const da = lireDate(a.date);
        const db = lireDate(b.date);
        if (!da || !db) continue;
        const ecart = Math.abs(Math.round((db.getTime() - da.getTime()) / 86_400_000));

        if (a.numero === b.numero && ecart === 0) {
          anomalies.push(
            anomalie(
              b,
              "doublon_exact",
              b.tva?.abs() ?? ZERO,
              1,
              `Piece identique a ${a.docId} : meme numero ${a.numero}, meme ` +
                `date, meme TTC ${q(a.ttc!).toFixed(2)} MAD. TVA deduite deux fois.`,
              a.docId
            )
          );
        } else if (ecart < ECART_DOUBLON_JOURS) {
          anomalies.push(
            anomalie(
              b,
              "doublon_probable",
              b.tva?.abs() ?? ZERO,
              0.75,
              `Meme tiers et meme TTC (${q(b.ttc!).toFixed(2)} MAD) que ` +
                `${a.docId}, a ${ecart} jours d'ecart (numeros ${a.numero} et ` +
                `${b.numero}). A confirmer avant rejet : aucune fusion automatique.`,
              a.docId
            )
          );
        }
      }
    }
  }
  return anomalies;
}

// ------------------------------------------------- boucle de revue humaine

/**
 * EX-06 : un rejet deja prononce sur un couple (tiers, famille) abaisse la
 * confiance des cas suivants ; trois rejets les masquent par defaut.
 */
export function appliquerDecisions(anomalies: Anomalie[], decisions: Decision[]): Anomalie[] {
  const compte = new Map<string, { valide: number; rejete: number }>();
  for (const d of decisions) {
    const cle = `${d.fournisseur}::${d.famille}`;
    const stats = compte.get(cle) ?? { valide: 0, rejete: 0 };
    stats[d.verdict] += 1;
    compte.set(cle, stats);
  }

  for (const a of anomalies) {
    const stats = compte.get(`${a.fournisseur}::${a.famille}`);
    if (!stats) continue;
    if (stats.rejete > 0) {
      a.confiance = Math.round(Math.max(0.05, a.confiance - 0.25 * stats.rejete) * 100) / 100;
      a.apprentissage = `${stats.rejete} rejet(s) deja prononce(s) sur ce motif pour ce tiers`;
      if (stats.rejete >= 3) a.statutRevue = "masquee_apres_rejets";
    }
    if (stats.valide > 0) {
      a.confiance = Math.round(Math.min(1, a.confiance + 0.05 * stats.valide) * 100) / 100;
    }
  }
  return anomalies;
}

/**
 * Une piece peut porter plusieurs anomalies — ICE absent et montant aberrant,
 * par exemple — mais c'est la meme TVA qui est en jeu. Le total retient donc,
 * par piece, la plus forte exposition et non leur somme.
 */
export function expositionTotale(anomalies: Anomalie[]): Montant {
  const parPiece = new Map<string, Montant>();
  for (const a of anomalies) {
    const actuelle = parPiece.get(a.docId);
    if (!actuelle || a.expositionMad.greaterThan(actuelle)) {
      parPiece.set(a.docId, a.expositionMad);
    }
  }
  return q([...parPiece.values()].reduce((total, m) => total.plus(m), ZERO));
}

export function auditer(pieces: Piece[], decisions: Decision[] = []): Anomalie[] {
  const anomalies = [
    ...pieces.flatMap(controlerPiece),
    ...detecterDoublons(pieces),
  ];
  appliquerDecisions(anomalies, decisions);
  anomalies.sort((x, y) => {
    const ecart = y.expositionMad.comparedTo(x.expositionMad);
    return ecart !== 0 ? ecart : y.confiance - x.confiance;
  });
  return anomalies;
}

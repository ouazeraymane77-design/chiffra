/**
 * Mise en forme du rapport rendu a l'interface.
 *
 * Les montants sortent en chaines a deux decimales, comme ils sont stockes en
 * `numeric` dans Postgres : aucun flottant ne traverse l'API.
 */
import type { Anomalie, Famille } from "./audit.js";
import type { EtapeJournal } from "./graph.js";
import type { Piece } from "./ingest.js";
import type { Rapprochement } from "./reconcile.js";

export interface AnomaliePubliee {
  doc_id: string;
  fichier: string;
  famille: Famille;
  libelle: string;
  regle: string;
  fournisseur: string | null;
  date: string | null;
  numero: string | null;
  ttc: string | null;
  exposition_mad: string;
  confiance: number;
  detail: string;
  piece_liee: string | null;
  statut_revue: string;
  action?: string;
  action_source?: string;
  apprentissage?: string;
}

export interface Rapport {
  execution_id: number;
  genere_le: string;
  pieces_total: number;
  pieces_traitees: number;
  pieces_non_traitees: number;
  taux_lecture: number;
  taux_rapprochement: number;
  factures_rapprochees: number;
  factures_rapprochables: number;
  lignes_ignorees_regle_12: number;
  total_reste_du: string;
  exposition_totale_mad: string;
  anomalies: AnomaliePubliee[];
  non_traitees: { doc_id: string; fichier: string; motif: string | null; tiers: string | null }[];
  residuels_bancaires: Rapprochement["residuelsAArbitrer"];
  journal: EtapeJournal[];
  synthese: string | null;
}

const publier = (a: Anomalie): AnomaliePubliee => ({
  doc_id: a.docId,
  fichier: a.fichier,
  famille: a.famille,
  libelle: a.libelle,
  regle: a.regle,
  fournisseur: a.fournisseur,
  date: a.date,
  numero: a.numero,
  ttc: a.ttc,
  exposition_mad: a.expositionMad.toFixed(2),
  confiance: a.confiance,
  detail: a.detail,
  piece_liee: a.pieceLiee,
  statut_revue: a.statutRevue,
  action: a.action,
  action_source: a.actionSource,
  apprentissage: a.apprentissage,
});

export function construireRapport(
  executionId: number,
  etat: {
    pieces: Piece[];
    rapprochement: Rapprochement | null;
    anomalies: Anomalie[];
    expositionTotale: string;
    synthese: string | null;
    journal: EtapeJournal[];
  }
): Rapport {
  const traitees = etat.pieces.filter((p) => p.statut === "traite");
  const rappro = etat.rapprochement;
  return {
    execution_id: executionId,
    genere_le: new Date().toISOString(),
    pieces_total: etat.pieces.length,
    pieces_traitees: traitees.length,
    pieces_non_traitees: etat.pieces.length - traitees.length,
    taux_lecture: etat.pieces.length
      ? Math.round((1000 * traitees.length) / etat.pieces.length) / 10
      : 0,
    taux_rapprochement: rappro?.tauxRapprochement ?? 0,
    factures_rapprochees: rappro?.facturesRapprochees ?? 0,
    factures_rapprochables: rappro?.facturesRapprochables ?? 0,
    lignes_ignorees_regle_12: rappro?.lignesIgnoreesRegle12 ?? 0,
    total_reste_du: rappro?.totalResteDu.toFixed(2) ?? "0.00",
    exposition_totale_mad: etat.expositionTotale,
    anomalies: etat.anomalies.map(publier),
    non_traitees: etat.pieces
      .filter((p) => p.statut !== "traite")
      .map((p) => ({
        doc_id: p.docId,
        fichier: p.fichier,
        motif: p.motif,
        tiers: p.tiersLibelle,
      })),
    residuels_bancaires: rappro?.residuelsAArbitrer ?? [],
    journal: etat.journal,
    synthese: etat.synthese,
  };
}

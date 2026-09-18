/** Contrat de donnees entre l'API Python et l'interface.
 *  Le typage sert de contrat : si un agent change sa sortie, le front ne
 *  compile plus. */

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

export interface Anomalie {
  doc_id: string;
  fichier: string | null;
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

export interface PieceNonTraitee {
  doc_id: string;
  fichier: string;
  motif: string;
  tiers: string | null;
}

export interface ResiduelBancaire {
  ligne_id: string;
  date: string;
  libelle: string;
  debit: string;
  residuel: string;
  pieces_affectees: string[];
}

export interface EtapeJournal {
  etape: string;
  horodatage: string;
  etat: Record<string, unknown>;
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
  anomalies: Anomalie[];
  non_traitees: PieceNonTraitee[];
  residuels_bancaires: ResiduelBancaire[];
  journal: EtapeJournal[];
  synthese: string | null;
}

export type Verdict = "valide" | "rejete";

export interface ReponseRevue {
  enregistre: boolean;
  decisions_sur_ce_motif: number;
  effet: string;
}

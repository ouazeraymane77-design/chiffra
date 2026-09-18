/**
 * Agent Reconciler — rapproche les pieces d'achat et les lignes bancaires.
 *
 * Zero appel au modele : ce fichier est de l'arithmetique sur des Decimal.
 * Regles appliquees (regles-fiscales.md) :
 *   9.  un paiement intervient jusqu'a 60 jours apres la date de facture
 *   10. une ligne bancaire peut couvrir plusieurs factures (paiement groupe)
 *   11. un paiement peut etre partiel : le solde reste du
 *   12. salaires, frais bancaires et reglements clients ne se rapprochent pas
 */
import { basename } from "node:path";
import { Decimal } from "decimal.js";
import { lireMontant, q, ZERO, type Montant } from "./money.js";
import type { Piece } from "./ingest.js";
import {
  fichiersReleves,
  identifierFournisseur,
  LIBELLES_HORS_ACHATS,
  lireCsv,
  normaliser,
} from "./referentiel.js";

const DELAI_MAX_JOURS = 60;
const TOLERANCE_MATCH = new Decimal("0.02");
const TAILLE_GROUPE_MAX = 5;
const CANDIDATS_MAX = 24; // borne le cout des combinaisons

export interface Affectation {
  docId: string;
  montant: Montant;
  mode: "exact" | "groupe" | "groupe_multi_tiers" | "partiel";
  confiance: number;
}

export interface LigneBancaire {
  ligneId: string;
  releve: string;
  date: string;
  libelle: string;
  debit: Montant;
  credit: Montant;
  solde: Montant | null;
  tiers: string | null;
  horsAchats: boolean;
  regroupementAnnonce: boolean;
  resteAAffecter: Montant;
  affectations: Affectation[];
}

export interface Rapprochement {
  lignes: LigneBancaire[];
  tauxRapprochement: number;
  facturesRapprochables: number;
  facturesRapprochees: number;
  lignesBancaires: number;
  lignesIgnoreesRegle12: number;
  totalResteDu: Montant;
  residuelsAArbitrer: {
    ligneId: string;
    date: string;
    libelle: string;
    debit: string;
    residuel: string;
    piecesAffectees: string[];
  }[];
}

export function lireDate(texte: string | null): Date | null {
  if (!texte) return null;
  const d = new Date(`${texte.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function joursEntre(debut: Date, fin: Date): number {
  return Math.round((fin.getTime() - debut.getTime()) / 86_400_000);
}

/** "VIR SOMAFER SARL REGROUPEMENT" -> "SOMAFER SARL". */
export function tiersDeLibelle(libelle: string): string {
  let t = normaliser(libelle);
  for (const mot of ["VIR", "VIREMENT", "CHQ", "CHEQUE", "PRLV", "REGROUPEMENT", "ACOMPTE"]) {
    t = t.split(mot).join(" ");
  }
  return t.split(/\s+/).filter(Boolean).join(" ");
}

export function chargerReleves(): LigneBancaire[] {
  const lignes: LigneBancaire[] = [];
  for (const fichier of fichiersReleves()) {
    const nom = basename(fichier, ".csv");
    lireCsv(fichier).forEach((ligne, i) => {
      const debit = lireMontant(ligne.debit_mad) ?? ZERO;
      const libelle = ligne.libelle.trim();
      const fiche = identifierFournisseur(libelle);
      const horsAchats =
        debit.isZero() ||
        LIBELLES_HORS_ACHATS.some((mot) => libelle.toUpperCase().includes(mot));
      lignes.push({
        ligneId: `${nom}-${String(i).padStart(3, "0")}`,
        releve: nom,
        date: ligne.date.slice(0, 10),
        libelle,
        debit: q(debit),
        credit: q(lireMontant(ligne.credit_mad) ?? ZERO),
        solde: lireMontant(ligne.solde_mad),
        tiers: horsAchats ? null : (fiche?.fournisseur ?? tiersDeLibelle(libelle)),
        horsAchats,
        regroupementAnnonce: libelle.toUpperCase().includes("REGROUPEMENT"),
        resteAAffecter: q(debit),
        affectations: [],
      });
    });
  }
  return lignes;
}

/** Le paiement tombe-t-il dans les 60 jours suivant la facture ? */
function dansLaFenetre(piece: Piece, ligne: LigneBancaire): boolean {
  if (piece.statut !== "traite" || piece.typePiece !== "facture") return false;
  const dFacture = lireDate(piece.date);
  const dLigne = lireDate(ligne.date);
  if (!dFacture || !dLigne) return false;
  const ecart = joursEntre(dFacture, dLigne);
  return ecart >= 0 && ecart <= DELAI_MAX_JOURS;
}

function payable(piece: Piece, ligne: LigneBancaire): boolean {
  if (normaliser(piece.tiersLibelle) !== normaliser(ligne.tiers)) return false;
  return dansLaFenetre(piece, ligne);
}

/** Toutes les combinaisons de `taille` elements. */
function* combinaisons<T>(source: T[], taille: number): Generator<T[]> {
  if (taille === 0) {
    yield [];
    return;
  }
  for (let i = 0; i <= source.length - taille; i += 1) {
    for (const reste of combinaisons(source.slice(i + 1), taille - 1)) {
      yield [source[i], ...reste];
    }
  }
}

export function rapprocher(pieces: Piece[], lignes = chargerReleves()): Rapprochement {
  const restant = new Map<string, Montant>();
  const parId = new Map<string, Piece>();
  for (const piece of pieces) {
    parId.set(piece.docId, piece);
    if (piece.statut === "traite" && piece.typePiece === "facture" && piece.ttc) {
      restant.set(piece.docId, q(piece.ttc));
    }
  }

  const affecter = (
    ligne: LigneBancaire,
    docId: string,
    montant: Montant,
    mode: Affectation["mode"],
    confiance: number
  ) => {
    ligne.affectations.push({ docId, montant: q(montant), mode, confiance });
    ligne.resteAAffecter = q(ligne.resteAAffecter.minus(montant));
    restant.set(docId, q(restant.get(docId)!.minus(montant)));
  };

  const candidats = (ligne: LigneBancaire, memeTiers: boolean): string[] =>
    [...restant.entries()]
      .filter(([id, r]) => {
        if (r.lessThanOrEqualTo(0)) return false;
        const piece = parId.get(id)!;
        return memeTiers ? payable(piece, ligne) : dansLaFenetre(piece, ligne);
      })
      .map(([id]) => id)
      .sort((a, b) => (parId.get(a)!.date ?? "").localeCompare(parId.get(b)!.date ?? ""))
      .slice(0, CANDIDATS_MAX);

  const ouvertes = () => lignes.filter((l) => !l.horsAchats && l.resteAAffecter.greaterThan(0));

  // Passe 1 : le debit egale exactement une facture ouverte.
  for (const ligne of ouvertes()) {
    for (const docId of candidats(ligne, true)) {
      if (restant.get(docId)!.minus(ligne.resteAAffecter).abs().lessThanOrEqualTo(TOLERANCE_MATCH)) {
        affecter(ligne, docId, restant.get(docId)!, "exact", 1);
        break;
      }
    }
  }

  // Passe 2 : le debit couvre plusieurs factures du meme tiers (regle 10).
  for (const ligne of ouvertes()) {
    const groupe = chercherGroupe(candidats(ligne, true), ligne, restant);
    if (groupe) for (const docId of groupe) affecter(ligne, docId, restant.get(docId)!, "groupe", 0.9);
  }

  // Passe 2b : un virement annonce « REGROUPEMENT » peut couvrir plusieurs
  // fournisseurs a la fois. On n'ouvre cette porte que pour ces lignes-la.
  for (const ligne of ouvertes()) {
    if (!ligne.regroupementAnnonce) continue;
    const groupe = chercherGroupe(candidats(ligne, false), ligne, restant);
    if (groupe)
      for (const docId of groupe)
        affecter(ligne, docId, restant.get(docId)!, "groupe_multi_tiers", 0.8);
  }

  // Passe 3 : paiement partiel, le solde reste du (regle 11).
  for (const ligne of ouvertes()) {
    for (const docId of candidats(ligne, true)) {
      if (ligne.resteAAffecter.lessThanOrEqualTo(0)) break;
      const montant = Decimal.min(ligne.resteAAffecter, restant.get(docId)!);
      if (montant.greaterThan(0)) affecter(ligne, docId, montant, "partiel", 0.7);
    }
  }

  // Report du solde sur chaque piece.
  for (const piece of pieces) {
    const solde = restant.get(piece.docId);
    if (!solde) {
      piece.rapprochement = "sans_objet";
      piece.resteDu = null;
      continue;
    }
    piece.montantPaye = q(piece.ttc!.minus(solde));
    piece.resteDu = q(solde);
    piece.rapprochement = solde.lessThanOrEqualTo(TOLERANCE_MATCH)
      ? "rapproche"
      : piece.montantPaye.greaterThan(0)
        ? "partiel"
        : "non_rapproche";
  }

  const rapprochables = pieces.filter((p) =>
    ["rapproche", "partiel", "non_rapproche"].includes(p.rapprochement ?? "")
  );
  const rapprochees = rapprochables.filter((p) => p.rapprochement === "rapproche");
  const lignesAchats = lignes.filter((l) => !l.horsAchats);

  return {
    lignes,
    tauxRapprochement: rapprochables.length
      ? Math.round((1000 * rapprochees.length) / rapprochables.length) / 10
      : 0,
    facturesRapprochables: rapprochables.length,
    facturesRapprochees: rapprochees.length,
    lignesBancaires: lignes.length,
    lignesIgnoreesRegle12: lignes.filter((l) => l.horsAchats).length,
    totalResteDu: q(
      rapprochables.reduce((total, p) => total.plus(p.resteDu ?? ZERO), ZERO)
    ),
    residuelsAArbitrer: lignesAchats
      .filter((l) => l.resteAAffecter.greaterThan(0))
      .map((l) => ({
        ligneId: l.ligneId,
        date: l.date,
        libelle: l.libelle,
        debit: l.debit.toFixed(2),
        residuel: l.resteAAffecter.toFixed(2),
        piecesAffectees: l.affectations.map((a) => a.docId),
      })),
  };
}

function chercherGroupe(
  ouverts: string[],
  ligne: LigneBancaire,
  restant: Map<string, Montant>
): string[] | null {
  for (let taille = 2; taille <= TAILLE_GROUPE_MAX; taille += 1) {
    for (const groupe of combinaisons(ouverts, taille)) {
      const total = groupe.reduce((somme, id) => somme.plus(restant.get(id)!), ZERO);
      if (total.minus(ligne.resteAAffecter).abs().lessThanOrEqualTo(TOLERANCE_MATCH)) {
        return groupe;
      }
    }
  }
  return null;
}

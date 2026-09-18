/** Chargement des referentiels fournis : fournisseurs, plan comptable, periode. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import { q } from "./money.js";

export const DOSSIER_DONNEES = process.env.DATA_DIR ?? "/srv/data";

export const PERIODE_DEBUT = "2026-01-01";
export const PERIODE_FIN = "2026-06-30";

/** Regle 12 : ces lignes bancaires ne se rapprochent d'aucune facture d'achat. */
export const LIBELLES_HORS_ACHATS = [
  "SALAIRE",
  "FRAIS DE TENUE",
  "AGIOS",
  "COMMISSION",
  "REGLEMENT CLIENT",
  "INTERETS",
];

export interface Fournisseur {
  fournisseur: string;
  ice: string;
  categorie: string;
  tauxTvaHabituel: number;
  compteComptable: string;
  recurrent: boolean;
  montantMoyenTtc: Decimal;
}

/** Lecteur CSV minimal : en-tete en premiere ligne, guillemets gerees. */
export function lireCsv(chemin: string): Record<string, string>[] {
  const brut = readFileSync(chemin, "utf8").replace(/^\uFEFF/, "");
  const lignes = brut.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const entetes = decouper(lignes[0]);
  return lignes.slice(1).map((ligne) => {
    const cellules = decouper(ligne);
    return Object.fromEntries(entetes.map((e, i) => [e, cellules[i] ?? ""]));
  });
}

function decouper(ligne: string): string[] {
  const cellules: string[] = [];
  let courante = "";
  let entreGuillemets = false;
  for (let i = 0; i < ligne.length; i += 1) {
    const c = ligne[i];
    if (c === '"') {
      if (entreGuillemets && ligne[i + 1] === '"') {
        courante += '"';
        i += 1;
      } else entreGuillemets = !entreGuillemets;
    } else if (c === "," && !entreGuillemets) {
      cellules.push(courante.trim());
      courante = "";
    } else courante += c;
  }
  cellules.push(courante.trim());
  return cellules;
}

/** Majuscules sans accents ni ponctuation, pour comparer des noms. */
export function normaliser(texte: string | null | undefined): string {
  if (!texte) return "";
  return String(texte)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function chargerFournisseurs(): Map<string, Fournisseur> {
  const table = new Map<string, Fournisseur>();
  for (const ligne of lireCsv(join(DOSSIER_DONNEES, "referentiel-fournisseurs.csv"))) {
    const fiche: Fournisseur = {
      fournisseur: ligne.fournisseur,
      ice: ligne.ice,
      categorie: ligne.categorie,
      tauxTvaHabituel: Number.parseInt(ligne.taux_tva_habituel, 10),
      compteComptable: ligne.compte_comptable,
      recurrent: ligne.recurrent === "oui",
      montantMoyenTtc: q(ligne.montant_moyen_ttc_mad),
    };
    table.set(normaliser(fiche.fournisseur), fiche);
  }
  return table;
}

export const FOURNISSEURS = chargerFournisseurs();

export const PLAN_COMPTABLE = new Map(
  lireCsv(join(DOSSIER_DONNEES, "plan-comptable.csv")).map((l) => [
    l.compte,
    l.libelle,
  ])
);

/**
 * Cherche un fournisseur du referentiel dans le texte d'une piece.
 * Renvoie null si aucun ne correspond : l'Auditor levera un tiers inconnu.
 */
export function identifierFournisseur(texte: string): Fournisseur | null {
  const cible = normaliser(texte);
  let meilleur: Fournisseur | null = null;
  let longueur = 0;
  for (const [cle, fiche] of FOURNISSEURS) {
    if (cible.includes(cle) && cle.length > longueur) {
      meilleur = fiche;
      longueur = cle.length;
    }
  }
  if (meilleur) return meilleur;

  // Tolerance OCR : un mot rare suffit (VERITAS, SOMAFER, IMPRIMERIE...).
  for (const [cle, fiche] of FOURNISSEURS) {
    const mots = cle.split(" ").filter((m) => m.length >= 6);
    if (mots.some((m) => cible.includes(m))) return fiche;
  }
  return null;
}

export function fichiersPieces(): string[] {
  const dossier = join(DOSSIER_DONNEES, "factures");
  return readdirSync(dossier)
    .filter((f) => /\.(pdf|jpe?g|png)$/i.test(f))
    .sort()
    .map((f) => join(dossier, f));
}

export function fichiersReleves(): string[] {
  const dossier = join(DOSSIER_DONNEES, "releves");
  return readdirSync(dossier)
    .filter((f) => /^releve-.*\.csv$/i.test(f))
    .sort()
    .map((f) => join(dossier, f));
}

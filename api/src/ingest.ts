/**
 * Agent Ingestor — normalise n'importe quelle entree en piece structuree.
 *
 * Escalade explicite, du moins cher au plus cher. Chaque niveau qui echoue
 * passe la main au suivant ; si tous echouent, le document sort en
 * « non traite » avec un motif (EX-08). Aucun montant n'est invente.
 *
 *   1. couche texte du PDF      pdftotext, gratuit, exact
 *   2. OCR de l'image           tesseract, gratuit, bruite
 *   3. export Excel du cabinet  source de secours structuree
 *   4. lecture par le modele    gpt-4.1 vision, payant, dernier recours
 *   5. non traite               file humaine
 *
 * Les montants lus sont ensuite verifies par du code : HT + TVA doit egaler
 * TTC, la TVA doit decouler du taux porte, et le TTC doit rester dans l'ordre
 * de grandeur historique du tiers.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { Decimal } from "decimal.js";
import * as XLSX from "xlsx";
import { coherent, lireMontant, q, tvaAttendue, type Montant } from "./money.js";
import {
  DOSSIER_DONNEES,
  identifierFournisseur,
  type Fournisseur,
} from "./referentiel.js";

const executer = promisify(execFile);

export type SourceExtraction =
  | "couche_texte_pdf"
  | "ocr"
  | "export_excel_cabinet"
  | "lecture_modele";

/**
 * La couche texte d'un PDF et l'export du cabinet sont exacts. L'OCR et le
 * modele travaillent sur une image degradee : leurs montants sont confrontes a
 * l'historique du tiers avant d'etre retenus.
 */
export const SOURCES_SURES: SourceExtraction[] = [
  "couche_texte_pdf",
  "export_excel_cabinet",
];

export const FACTEUR_INVRAISEMBLABLE = new Decimal(10);

export interface Piece {
  docId: string;
  fichier: string;
  statut: "traite" | "non_traite";
  motif: string | null;
  sourceExtraction: SourceExtraction | null;
  typePiece: "facture" | "avoir";
  numero: string | null;
  date: string | null;
  iceFournisseur: string | null;
  tiersLibelle: string | null;
  fiche: Fournisseur | null;
  tauxTva: number | null;
  ht: Montant | null;
  tva: Montant | null;
  ttc: Montant | null;
  champsReconstruits: string[];
  lecturePartielle: Record<string, string>;
  texteBrut: string;
  /** Rempli par le Reconciler. */
  rapprochement?: "rapproche" | "partiel" | "non_rapproche" | "sans_objet";
  montantPaye?: Montant | null;
  resteDu?: Montant | null;
}

interface Champs {
  typePiece: "facture" | "avoir";
  numero: string | null;
  date: string | null;
  iceFournisseur: string | null;
  tiersLibelle: string | null;
  fiche: Fournisseur | null;
  tauxTva: number | null;
  ht: Montant | null;
  tva: Montant | null;
  ttc: Montant | null;
  champsReconstruits: string[];
  reconstructionNonVerifiee?: boolean;
}

// ------------------------------------------------------------------ regexes

// L'OCR confond chiffres et lettres dans le numero de piece ("FA-2026-0C 06").
const RE_NUMERO =
  /\b(FACTURE|AVOIR|FACTUR[E3]|AV0IR)\s*N?[°o0]?\s*:?\s*([A-Z]{2}\s?[-—]\s?[\dOoIlSB]{4}\s?[-—]\s?[\dOoIlSB\s]{3,6})/i;
const RE_DATE = /\b(?:Date|Datc|Dale)\s*:?\s*(\d{4})\s*-\s*(\d{2})\s*-\s*(\d{2})/i;
const RE_ICE_CLIENT = /ICE\s*client\s*:?\s*([0-9OoIlCSB]{10,20})/i;
const RE_ICE = /\bICE\s*:?\s*([0-9OoIlCSB]{10,20})/gi;
const RE_TAUX = /TVA\s*:?\s*(\d{1,2})\s*%/;

// Un montant commence par un chiffre ou un signe : sinon la regex attraperait
// l'en-tete du tableau ("Total HT" suivi d'un saut de ligne).
const MONTANT = "(-?\\s?\\d[\\d\\s.,]*)";
const RE_HT = new RegExp(`\\w{0,2}TAL\\s*H\\.?T\\.?\\s*:?\\s*${MONTANT}`, "gi");
const RE_TVA = new RegExp(`TVA\\s*\\d{1,2}\\s*%\\s*:?\\s*${MONTANT}`, "g");
const RE_TTC = new RegExp(
  `(?:Net\\s*[àa]\\s*payer\\s*T\\.?T\\.?C|\\w{0,2}TAL\\s*T\\.?T\\.?C\\.?)\\s*:?\\s*${MONTANT}`,
  "gi"
);

/** Transpositions ASCII : une cle non-ASCII ne survit pas a un changement
 *  d'encodage, et les tirets longs sont normalises avant. */
const TRANSPOSITION: Record<string, string> = {
  O: "0",
  I: "1",
  L: "1",
  C: "0",
  S: "5",
  B: "8",
};

function transposer(brut: string): string {
  return brut
    .toUpperCase()
    .split("")
    .map((c) => TRANSPOSITION[c] ?? c)
    .join("");
}

/** Remet un numero de piece dans sa forme XX-AAAA-NNNN. */
export function normaliserNumero(brut: string): string | null {
  const t = transposer(brut.replace(/\s/g, "").replace(/[\u2013\u2014]/g, "-"));
  const m = t.match(/([A-Z]{2})-?(\d{4})-?(\d{3,4})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3].padStart(4, "0")}`;
}

function dernier(texte: string, regex: RegExp): string | null {
  regex.lastIndex = 0;
  let trouve: string | null = null;
  for (const m of texte.matchAll(regex)) trouve = m[1];
  return trouve;
}

// --------------------------------------------------------------- extraction

export async function textePdf(chemin: string): Promise<string> {
  try {
    const { stdout } = await executer("pdftotext", ["-layout", chemin, "-"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

export async function texteOcr(chemin: string): Promise<string> {
  try {
    if (extname(chemin).toLowerCase() === ".pdf") {
      // pdftoppm rend la premiere page en PNG sur la sortie standard,
      // que tesseract lit directement : aucun fichier temporaire.
      const { stdout } = await executer(
        "sh",
        [
          "-c",
          `pdftoppm -png -r 200 -f 1 -l 1 "${chemin}" | tesseract stdin stdout -l fra+eng 2>/dev/null`,
        ],
        { maxBuffer: 16 * 1024 * 1024 }
      );
      return stdout;
    }
    const { stdout } = await executer(
      "sh",
      [`-c`, `tesseract "${chemin}" stdout -l fra+eng 2>/dev/null`],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    return stdout;
  } catch {
    return "";
  }
}

let exportExcel: Map<string, Record<string, unknown>> | null = null;

function lireExportExcel(): Map<string, Record<string, unknown>> {
  if (exportExcel) return exportExcel;
  exportExcel = new Map();
  try {
    const chemin = join(DOSSIER_DONNEES, "factures", "export-achats-T2.xlsx");
    const classeur = XLSX.read(readFileSync(chemin), { type: "buffer", cellDates: true });
    const feuille = classeur.Sheets[classeur.SheetNames[0]];
    for (const ligne of XLSX.utils.sheet_to_json<Record<string, unknown>>(feuille)) {
      if (ligne.id) exportExcel.set(String(ligne.id), ligne);
    }
  } catch {
    // L'export est une commodite : son absence n'empeche rien.
  }
  return exportExcel;
}

// ------------------------------------------------------------------ parsing

/** Applique les regex. Ne juge pas, ne repare pas : lit. */
export function champsDepuisTexte(texte: string): Champs {
  const champs: Champs = {
    typePiece: "facture",
    numero: null,
    date: null,
    iceFournisseur: null,
    tiersLibelle: null,
    fiche: null,
    tauxTva: null,
    ht: null,
    tva: null,
    ttc: null,
    champsReconstruits: [],
  };

  const numero = texte.match(RE_NUMERO);
  if (numero) {
    champs.typePiece = numero[1].toLowerCase().startsWith("av") ? "avoir" : "facture";
    champs.numero = normaliserNumero(numero[2]);
  }

  const date = texte.match(RE_DATE);
  if (date) champs.date = `${date[1]}-${date[2]}-${date[3]}`;

  const iceClient = texte.match(RE_ICE_CLIENT);
  RE_ICE.lastIndex = 0;
  for (const m of texte.matchAll(RE_ICE)) {
    if (iceClient && m.index === iceClient.index) continue;
    const brut = transposer(m[1]);
    if (brut.length >= 12 && /^\d+$/.test(brut)) {
      champs.iceFournisseur = brut;
      break;
    }
  }

  const taux = texte.match(RE_TAUX);
  if (taux) champs.tauxTva = Number.parseInt(taux[1], 10);

  // La derniere occurrence : le pied de facture, pas une ligne de detail.
  champs.ht = lireMontant(dernier(texte, RE_HT));
  champs.tva = lireMontant(dernier(texte, RE_TVA));
  champs.ttc = lireMontant(dernier(texte, RE_TTC));

  const fiche = identifierFournisseur(texte.slice(0, 400) || texte);
  champs.fiche = fiche;
  // Nom tel qu'il est ecrit sur la piece : sert a rapprocher et a nommer un
  // tiers absent du referentiel, qu'on ne veut pas afficher comme « inconnu ».
  champs.tiersLibelle = fiche?.fournisseur ?? null;
  if (!champs.tiersLibelle) {
    for (const ligne of texte.split(/\r?\n/).slice(0, 6)) {
      const propre = ligne.trim();
      if (
        propre.length >= 3 &&
        propre.length <= 60 &&
        !/^(ICE|FACTURE|AVOIR|DATE)/i.test(propre)
      ) {
        champs.tiersLibelle = propre;
        break;
      }
    }
  }
  return champs;
}

/**
 * Repare un montant abime par l'OCR, par le code et seulement si c'est sur.
 * Toute reconstruction est tracee, et refusee si elle ne colle pas au taux.
 */
export function reparer(champs: Champs): Champs {
  let { ht, tva, ttc } = champs;
  const taux = champs.tauxTva;
  let reconstruits: string[] = [];

  if (coherent(ht, tva, ttc)) {
    if (!q(ht!).plus(q(tva!)).equals(q(ttc!))) {
      // Ecart d'un centime : un chiffre a ete mal lu, le code tranche.
      champs.ht = q(ttc!.minus(tva!));
      champs.champsReconstruits = ["ht"];
    } else champs.champsReconstruits = [];
    return champs;
  }

  if (ht && tva && !ttc) {
    ttc = q(ht.plus(tva));
    reconstruits = ["ttc"];
  } else if (ht && ttc && !tva) {
    tva = q(ttc.minus(ht));
    reconstruits = ["tva"];
  } else if (tva && ttc && !ht) {
    ht = q(ttc.minus(tva));
    reconstruits = ["ht"];
  } else if (ht && taux && !tva && !ttc) {
    tva = tvaAttendue(ht, taux);
    ttc = q(ht.plus(tva));
    reconstruits = ["tva", "ttc"];
  } else if (ht && tva && ttc && taux) {
    // Les trois sont la mais ne tombent pas juste : un chiffre est abime. On
    // ne garde la reparation que si le couple restant colle au taux.
    if (tva.minus(tvaAttendue(q(ttc.minus(tva)), taux)).abs().lessThanOrEqualTo("0.05")) {
      ht = q(ttc.minus(tva));
      reconstruits = ["ht"];
    } else if (tva.minus(tvaAttendue(ht, taux)).abs().lessThanOrEqualTo("0.05")) {
      ttc = q(ht.plus(tva));
      reconstruits = ["ttc"];
    }
  }

  champs.ht = ht;
  champs.tva = tva;
  champs.ttc = ttc;
  champs.champsReconstruits = reconstruits;

  // Un trou comble par soustraction peut masquer un chiffre mal lu. On ne
  // garde la piece que si la TVA reconstituee colle au taux porte.
  if (reconstruits.length > 0 && taux && ht && tva) {
    if (tva.abs().minus(tvaAttendue(ht.abs(), taux)).abs().greaterThan(1)) {
      champs.reconstructionNonVerifiee = true;
    }
  }
  return champs;
}

/** Un montant lu sur une image est confronte a l'historique du tiers. */
export function vraisemblable(champs: Champs): boolean {
  if (!champs.fiche || !champs.ttc) return true;
  const plafond = champs.fiche.montantMoyenTtc.times(FACTEUR_INVRAISEMBLABLE);
  return champs.ttc.abs().lessThanOrEqualTo(plafond);
}

export function complet(champs: Champs | null): boolean {
  if (!champs) return false;
  if (champs.reconstructionNonVerifiee) return false;
  if (!champs.numero || !champs.date || !champs.ttc) return false;
  return coherent(champs.ht, champs.tva, champs.ttc);
}

function depuisExcel(docId: string): Champs | null {
  const ligne = lireExportExcel().get(docId);
  if (!ligne) return null;
  const fiche = identifierFournisseur(String(ligne.fournisseur ?? ""));
  const date =
    ligne.date instanceof Date
      ? ligne.date.toISOString().slice(0, 10)
      : String(ligne.date ?? "").slice(0, 10);
  return {
    typePiece: "facture",
    numero: String(ligne.numero ?? ""),
    date,
    iceFournisseur: String(ligne.ice ?? ""),
    tiersLibelle: fiche?.fournisseur ?? String(ligne.fournisseur ?? ""),
    fiche,
    tauxTva: ligne.taux_tva ? Number(ligne.taux_tva) : null,
    ht: q(String(ligne.ht)),
    tva: q(String(ligne.tva)),
    ttc: q(String(ligne.ttc)),
    champsReconstruits: [],
  };
}

function piecePar(docId: string, fichier: string): Piece {
  return {
    docId,
    fichier,
    statut: "non_traite",
    motif: null,
    sourceExtraction: null,
    typePiece: "facture",
    numero: null,
    date: null,
    iceFournisseur: null,
    tiersLibelle: null,
    fiche: null,
    tauxTva: null,
    ht: null,
    tva: null,
    ttc: null,
    champsReconstruits: [],
    lecturePartielle: {},
    texteBrut: "",
  };
}

function appliquer(piece: Piece, champs: Champs, source: SourceExtraction): Piece {
  return {
    ...piece,
    statut: "traite",
    sourceExtraction: source,
    typePiece: champs.typePiece,
    numero: champs.numero,
    date: champs.date,
    iceFournisseur: champs.iceFournisseur,
    tiersLibelle: champs.tiersLibelle,
    fiche: champs.fiche,
    tauxTva: champs.tauxTva,
    ht: champs.ht,
    tva: champs.tva,
    ttc: champs.ttc,
    champsReconstruits: champs.champsReconstruits,
  };
}

export type LecteurModele = (
  chemin: string,
  texteOcr: string
) => Promise<Partial<Champs> | null>;

/** Retourne une piece structuree avec sa source et son statut. */
export async function ingerer(
  chemin: string,
  lecteurModele?: LecteurModele
): Promise<Piece> {
  const docId = basename(chemin, extname(chemin));
  let piece = piecePar(docId, basename(chemin));

  const tentatives: [SourceExtraction, string][] = [];
  if (extname(chemin).toLowerCase() === ".pdf") {
    const brut = await textePdf(chemin);
    if (brut.trim().length > 50) tentatives.push(["couche_texte_pdf", brut]);
  }
  if (tentatives.length === 0) tentatives.push(["ocr", await texteOcr(chemin)]);

  let partiel: Champs | null = null;
  let invraisemblable: Champs | null = null;

  for (const [source, texte] of tentatives) {
    const champs = reparer(champsDepuisTexte(texte));
    if (complet(champs)) {
      if (SOURCES_SURES.includes(source) || vraisemblable(champs)) {
        return { ...appliquer(piece, champs, source), texteBrut: texte };
      }
      invraisemblable = champs;
    }
    piece.texteBrut = texte;
    partiel ??= champs;
  }

  const secours = depuisExcel(docId);
  if (complet(secours)) return appliquer(piece, secours!, "export_excel_cabinet");

  if (lecteurModele && !invraisemblable) {
    const lu = await lecteurModele(chemin, piece.texteBrut);
    if (lu) {
      const champs = reparer({ ...(partiel as Champs), ...lu });
      if (complet(champs)) {
        if (vraisemblable(champs)) return appliquer(piece, champs, "lecture_modele");
        invraisemblable = champs;
      }
    }
  }

  if (invraisemblable) {
    piece.lecturePartielle = { ttc_lu: invraisemblable.ttc!.toFixed(2) };
    piece.tiersLibelle = invraisemblable.tiersLibelle;
    piece.fiche = invraisemblable.fiche;
    piece.motif =
      `montant lu sur l'image invraisemblable pour ce tiers : ` +
      `${invraisemblable.ttc!.toFixed(2)} MAD contre une moyenne de ` +
      `${invraisemblable.fiche!.montantMoyenTtc.toFixed(2)} MAD`;
    return piece;
  }

  // Une piece non traitee ne porte aucun montant : ce qui a ete entrevu est
  // range a part, visible pour le comptable, jamais utilise par les calculs.
  if (partiel) {
    piece.numero = partiel.numero;
    piece.date = partiel.date;
    piece.tiersLibelle = partiel.tiersLibelle;
    piece.fiche = partiel.fiche;
    piece.iceFournisseur = partiel.iceFournisseur;
    for (const [cle, valeur] of Object.entries({
      ht: partiel.ht,
      tva: partiel.tva,
      ttc: partiel.ttc,
    })) {
      if (valeur) piece.lecturePartielle[cle] = valeur.toFixed(2);
    }
  }

  const manquants = (["numero", "date", "ttc"] as const).filter(
    (c) => !partiel?.[c]
  );
  piece.motif = manquants.length
    ? `champs illisibles : ${manquants.join(", ")}`
    : partiel?.reconstructionNonVerifiee
      ? "montants incoherents apres lecture : la TVA reconstituee ne correspond pas au taux porte sur la piece"
      : "montants incoherents apres lecture (HT + TVA != TTC)";
  return piece;
}

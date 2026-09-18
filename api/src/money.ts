/**
 * Arithmetique monetaire. Tout montant du projet passe par ici.
 *
 * Le cahier des charges impose decimal.js et un stockage en `numeric` cote
 * Postgres : aucun montant ne transite par un flottant, et aucun n'est calcule
 * par le modele.
 */
import { Decimal } from "decimal.js";

// 2 decimales, arrondi comptable (0,005 monte).
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export const ZERO = new Decimal(0);
export const TOLERANCE = new Decimal("0.02");

export type Montant = Decimal;

/** Arrondit a deux decimales. */
export function q(valeur: Decimal.Value): Montant {
  return new Decimal(valeur).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Lit un montant dans du texte brut ou de l'OCR.
 * Gere les espaces insecables, la virgule decimale, le signe negatif des
 * avoirs, et les caracteres parasites colles aux chiffres ("34 828.0!").
 */
export function lireMontant(texte: string | null | undefined): Montant | null {
  if (texte === null || texte === undefined) return null;
  let t = String(texte).replace(/\u00a0|\u202f/g, " ").trim();
  const negatif = t.startsWith("-") || t.startsWith("(");
  t = t.replace(/[^0-9.,]/g, "");
  if (!t) return null;

  // Separateur decimal : dernier . ou , suivi d'un ou deux chiffres.
  const decimale = t.match(/[.,](\d{1,2})$/);
  let valeur: string;
  if (decimale) {
    const entier = t.slice(0, decimale.index).replace(/[^0-9]/g, "");
    valeur = `${entier || "0"}.${decimale[1]}`;
  } else {
    valeur = t.replace(/[^0-9]/g, "");
  }
  if (!valeur) return null;

  try {
    const montant = new Decimal(valeur);
    return negatif ? montant.neg() : montant;
  } catch {
    return null;
  }
}

/** TVA theorique pour une base HT et un taux entier. */
export function tvaAttendue(ht: Decimal.Value, taux: number): Montant {
  return q(new Decimal(ht).times(taux).dividedBy(100));
}

/** HT + TVA vaut-il TTC, a la tolerance d'arrondi pres ? */
export function coherent(
  ht: Montant | null,
  tva: Montant | null,
  ttc: Montant | null
): boolean {
  if (!ht || !tva || !ttc) return false;
  return q(ht).plus(q(tva)).minus(q(ttc)).abs().lessThanOrEqualTo(TOLERANCE);
}

/** Forme d'echange et de stockage : une chaine, jamais un flottant. */
export const texte = (montant: Montant | null): string | null =>
  montant === null ? null : q(montant).toFixed(2);

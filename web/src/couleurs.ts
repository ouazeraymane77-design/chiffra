import type { Famille } from "./types";

/** Une couleur par famille d'anomalie, reprise de la feuille de style.
 *  La bande d'exposition et les etiquettes partagent ce vocabulaire. */
export const COULEUR: Record<Famille, string> = {
  doublon_exact: "var(--f-doublon-exact)",
  doublon_probable: "var(--f-doublon-probable)",
  tva_erronee: "var(--f-tva-erronee)",
  tva_incoherente: "var(--f-tva-incoherente)",
  hors_periode: "var(--f-hors-periode)",
  tiers_inconnu: "var(--f-tiers-inconnu)",
  montant_aberrant: "var(--f-montant-aberrant)",
  ice_manquant: "var(--f-ice-manquant)",
  document_non_traite: "var(--f-non-traite)",
};

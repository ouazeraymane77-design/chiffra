/**
 * Agent Explainer — traduit une anomalie chiffree en action concrete.
 *
 * Le modele recoit des montants deja calcules. Il ne lui est jamais demande
 * d'additionner ni de comparer deux nombres : la consigne le lui interdit et
 * les chiffres sont dans l'invite.
 */
import type { Anomalie, Famille } from "./audit.js";
import { appeler, modeleDisponible } from "./llm.js";

const CONSIGNE =
  "Tu es un collaborateur de cabinet comptable marocain. On te donne une " +
  "anomalie deja detectee et deja chiffree par le systeme comptable. Ecris " +
  "l'action a mener, en deux phrases maximum, en francais, a l'imperatif. " +
  "Reprends les montants tels quels : ne recalcule rien, n'invente aucun " +
  "chiffre, n'ajoute aucune formule de politesse.";

const PAR_DEFAUT: Record<Famille, string> = {
  doublon_exact:
    "Annuler la seconde saisie et retirer la TVA deduite en double avant la prochaine declaration.",
  doublon_probable:
    "Comparer les deux pieces avec le fournisseur avant toute annulation : les numeros different.",
  tva_erronee:
    "Demander une facture rectificative au fournisseur et corriger la TVA deduite.",
  tva_incoherente:
    "Verifier la piece d'origine : la TVA portee ne decoule pas de la base HT.",
  hors_periode:
    "Sortir la piece de l'exercice et la rattacher a la periode dont elle releve.",
  tiers_inconnu:
    "Creer la fiche du tiers et obtenir son ICE avant de deduire la TVA.",
  montant_aberrant: "Faire valider le montant par le responsable avant paiement.",
  ice_manquant:
    "Reclamer une facture portant l'ICE du fournisseur : sans elle, pas de deduction.",
  document_non_traite:
    "Reprendre la piece a la main ou en demander un exemplaire lisible.",
};

/**
 * Ajoute l'action a mener. Sans modele disponible, la formulation de repli est
 * utilisee : le produit ne depend pas du LLM pour fonctionner.
 */
export async function expliquer(anomalie: Anomalie, avecModele: boolean): Promise<Anomalie> {
  anomalie.action = PAR_DEFAUT[anomalie.famille];
  anomalie.actionSource = "modele_par_defaut";
  if (!avecModele || !modeleDisponible()) return anomalie;

  const invite =
    `Anomalie : ${anomalie.libelle} (${anomalie.regle})\n` +
    `Piece : ${anomalie.docId} n° ${anomalie.numero} du ${anomalie.date}, ` +
    `tiers ${anomalie.fournisseur}\n` +
    `Constat du systeme : ${anomalie.detail}\n` +
    `Exposition calculee par le code : ${anomalie.expositionMad.toFixed(2)} MAD\n` +
    `Confiance : ${anomalie.confiance}`;

  const texte = await appeler(
    [
      { role: "system", content: CONSIGNE },
      { role: "user", content: invite },
    ],
    "rapide",
    160
  );
  if (texte && texte.trim()) {
    anomalie.action = texte.trim();
    anomalie.actionSource = "gpt-4.1";
  }
  return anomalie;
}

const CONSIGNE_SYNTHESE =
  "Tu es l'associe d'un cabinet comptable marocain. On te remet le resultat " +
  "d'un controle automatise : tous les chiffres ci-dessous ont ete calcules " +
  "par le code, ils sont exacts et tu dois les reprendre tels quels. Ecris " +
  "une note de cinq lignes au maximum pour le collaborateur : par quoi " +
  "commencer, et ce qui reste a traiter a la main. Ne recalcule aucun total.";

/** Seul appel au modele de raisonnement : la lecture d'ensemble du dossier. */
export async function synthetiser(rapport: {
  piecesTotal: number;
  piecesTraitees: number;
  piecesNonTraitees: number;
  tauxRapprochement: number;
  expositionTotaleMad: string;
  totalResteDu: string;
  anomalies: Anomalie[];
}): Promise<string | null> {
  if (!modeleDisponible()) return null;
  const invite =
    `Pieces deposees : ${rapport.piecesTotal}, lues : ${rapport.piecesTraitees}, ` +
    `laissees a la main : ${rapport.piecesNonTraitees}\n` +
    `Taux de rapprochement bancaire : ${rapport.tauxRapprochement} %\n` +
    `Exposition totale chiffree : ${rapport.expositionTotaleMad} MAD\n` +
    `Reste du aux fournisseurs : ${rapport.totalResteDu} MAD\n\n` +
    "Principales anomalies :\n" +
    rapport.anomalies
      .slice(0, 8)
      .map(
        (a) =>
          `- ${a.docId} ${a.libelle} (${a.fournisseur}) : ` +
          `${a.expositionMad.toFixed(2)} MAD, confiance ${a.confiance}`
      )
      .join("\n");

  return appeler(
    [
      { role: "system", content: CONSIGNE_SYNTHESE },
      { role: "user", content: invite },
    ],
    "raisonnement",
    400
  );
}

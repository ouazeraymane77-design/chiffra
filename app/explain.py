"""Agent Explainer — traduit une anomalie chiffree en action concrete.

Le modele recoit des montants deja calcules. Il ne lui est jamais demande
d'additionner, de calculer un pourcentage ni de comparer deux nombres : la
consigne le lui interdit et les chiffres sont dans le prompt.
"""
from app.llm import appeler, disponible

CONSIGNE = (
    "Tu es un collaborateur de cabinet comptable marocain. On te donne une "
    "anomalie deja detectee et deja chiffree par le systeme comptable. "
    "Ecris l'action a mener, en deux phrases maximum, en francais, a "
    "l'imperatif. Reprends les montants tels quels : ne recalcule rien, "
    "n'invente aucun chiffre, n'ajoute aucune formule de politesse.")

ACTIONS_PAR_DEFAUT = {
    "doublon_exact": "Annuler la seconde saisie et retirer la TVA deduite en double avant la prochaine declaration.",
    "doublon_probable": "Comparer les deux pieces avec le fournisseur avant toute annulation : les numeros different.",
    "tva_erronee": "Demander une facture rectificative au fournisseur et corriger la TVA deduite.",
    "tva_incoherente": "Verifier la piece d'origine : la TVA portee ne decoule pas de la base HT.",
    "hors_periode": "Sortir la piece de l'exercice et la rattacher a la periode dont elle releve.",
    "tiers_inconnu": "Creer la fiche du tiers et obtenir son ICE avant de deduire la TVA.",
    "montant_aberrant": "Faire valider le montant par le responsable avant paiement.",
    "ice_manquant": "Reclamer une facture portant l'ICE du fournisseur : sans elle, pas de deduction.",
    "document_non_traite": "Reprendre la piece a la main ou en demander un exemplaire lisible.",
}


def expliquer(anomalie: dict, avec_modele: bool = True) -> dict:
    """Ajoute le champ 'action'. Sans modele disponible, la formulation de
    repli est utilisee : le produit ne depend pas du LLM pour fonctionner."""
    anomalie["action"] = ACTIONS_PAR_DEFAUT.get(anomalie["famille"], "A arbitrer.")
    anomalie["action_source"] = "modele_par_defaut"
    if not (avec_modele and disponible()):
        return anomalie

    invite = (
        f"Anomalie : {anomalie['libelle']} ({anomalie['regle']})\n"
        f"Piece : {anomalie['doc_id']} n° {anomalie.get('numero')} du "
        f"{anomalie.get('date')}, tiers {anomalie.get('fournisseur')}\n"
        f"Constat du systeme : {anomalie['detail']}\n"
        f"Exposition calculee par le code : {anomalie['exposition_mad']} MAD\n"
        f"Confiance : {anomalie['confiance']}")
    texte = appeler([{"role": "system", "content": CONSIGNE},
                     {"role": "user", "content": invite}], "rapide", 160)
    if texte and texte.strip():
        anomalie["action"] = texte.strip()
        anomalie["action_source"] = "gpt-4.1"
    return anomalie


CONSIGNE_SYNTHESE = (
    "Tu es l'associe d'un cabinet comptable marocain. On te remet le resultat "
    "d'un controle automatise : tous les chiffres ci-dessous ont ete calcules "
    "par le code, ils sont exacts et tu dois les reprendre tels quels. "
    "Ecris une note de cinq lignes au maximum pour le collaborateur : par quoi "
    "commencer, et ce qui reste a traiter a la main. Ne recalcule aucun total.")


def synthetiser(rapport: dict) -> str:
    """Seul appel au modele de raisonnement : la lecture d'ensemble du dossier."""
    if not disponible():
        return None
    tete = rapport["anomalies"][:8]
    invite = (
        f"Pieces deposees : {rapport['pieces_total']}, lues : {rapport['pieces_traitees']}, "
        f"laissees a la main : {rapport['pieces_non_traitees']}\n"
        f"Taux de rapprochement bancaire : {rapport['taux_rapprochement']}%\n"
        f"Exposition totale chiffree : {rapport['exposition_totale_mad']} MAD\n"
        f"Reste du aux fournisseurs : {rapport['total_reste_du']} MAD\n\n"
        "Principales anomalies :\n" + "\n".join(
            f"- {a['doc_id']} {a['libelle']} ({a['fournisseur']}) : "
            f"{a['exposition_mad']} MAD, confiance {a['confiance']}" for a in tete))
    return appeler([{"role": "system", "content": CONSIGNE_SYNTHESE},
                    {"role": "user", "content": invite}], "raisonnement", 400)

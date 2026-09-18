"""Agent Auditor — applique le referentiel fiscal et chiffre l'exposition.

Aucun appel au modele. Chaque anomalie porte :
  - la regle du referentiel qui la fonde (regles-fiscales.md)
  - une exposition en dirhams calculee en Decimal
  - un niveau de confiance, abaisse par les rejets deja prononces (EX-06)

Convention d'exposition : le risque, c'est la TVA que l'administration peut
refuser en deduction, ou le redressement d'assiette. Jamais le TTC entier, sauf
doublon paye deux fois.
"""
from datetime import date, timedelta

from app.money import q, d, tva_attendue
from app.referentiel import PERIODE_DEBUT, PERIODE_FIN
from app.reconcile import lire_date

ECART_DOUBLON = timedelta(days=7)
FACTEUR_ABERRANT = d("10")

FAMILLES = {
    "doublon_exact": ("Doublon exact", "regle 6"),
    "doublon_probable": ("Doublon probable", "regle 5"),
    "tva_erronee": ("TVA au mauvais taux", "taux par categorie"),
    "tva_incoherente": ("TVA incoherente avec la base HT", "regle 2"),
    "hors_periode": ("Piece hors exercice", "regle 4"),
    "tiers_inconnu": ("Tiers absent du referentiel", "regle 3"),
    "montant_aberrant": ("Montant aberrant", "regle 7"),
    "ice_manquant": ("ICE fournisseur absent", "regle 3"),
    "document_non_traite": ("Document non exploitable", "EX-08"),
}


def _anomalie(piece, famille, exposition, confiance, detail, piece_liee=None):
    libelle, regle = FAMILLES[famille]
    return {
        "doc_id": piece["doc_id"],
        "fichier": piece.get("fichier"),
        "famille": famille,
        "libelle": libelle,
        "regle": regle,
        "fournisseur": piece.get("tiers_libelle") or piece.get("fournisseur"),
        "date": piece.get("date"),
        "numero": piece.get("numero"),
        "ttc": piece.get("ttc"),
        "exposition_mad": q(exposition),
        "confiance": round(confiance, 2),
        "detail": detail,
        "piece_liee": piece_liee,
        "statut_revue": "a_arbitrer",
    }


# ------------------------------------------------------------ controles piece

def controler_piece(piece: dict) -> list:
    anomalies = []
    fiche = piece.get("fiche_fournisseur")
    ht, tva, ttc = piece.get("ht"), piece.get("tva"), piece.get("ttc")
    taux = piece.get("taux_tva")
    tva_abs = abs(tva) if tva is not None else None

    if piece.get("statut") != "traite":
        anomalies.append(_anomalie(
            piece, "document_non_traite", d("0"), 1.0,
            f"Lecture impossible : {piece.get('motif')}. Aucun montant n'a ete "
            f"retenu, la piece reste dans la file humaine."))
        return anomalies

    # tiers absent du referentiel (regle 3)
    if not fiche:
        anomalies.append(_anomalie(
            piece, "tiers_inconnu", tva_abs or d("0"), 0.9,
            f"'{piece.get('tiers_libelle')}' ne figure pas dans le referentiel "
            f"fournisseurs. La deduction de TVA est a justifier."))

    # ICE fournisseur (regle 1 et 3)
    if not piece.get("ice_fournisseur"):
        anomalies.append(_anomalie(
            piece, "ice_manquant", tva_abs or d("0"), 0.95,
            "Aucun ICE fournisseur lisible sur la piece : elle n'ouvre pas "
            "droit a deduction en l'etat."))

    # taux de TVA vs categorie du fournisseur
    if fiche and taux is not None:
        habituel = fiche["taux_tva_habituel"]
        if taux != habituel and ht is not None:
            ecart = abs(tva_attendue(abs(ht), habituel) - (tva_abs or d("0")))
            anomalies.append(_anomalie(
                piece, "tva_erronee", ecart, 0.95,
                f"TVA a {taux}% alors que la categorie '{fiche['categorie']}' "
                f"releve du taux de {habituel}%. Redressement d'assiette calcule "
                f"sur une base HT de {q(abs(ht))} MAD."))

    # coherence interne TVA = HT x taux
    if taux is not None and ht is not None and tva is not None:
        ecart = abs(abs(tva) - tva_attendue(abs(ht), taux))
        if ecart > d("0.02"):
            anomalies.append(_anomalie(
                piece, "tva_incoherente", ecart, 0.85,
                f"La TVA portee ({q(abs(tva))} MAD) ne correspond pas a "
                f"{taux}% de la base HT ({tva_attendue(abs(ht), taux)} MAD)."))

    # periode (regle 4)
    if piece.get("date") and not (PERIODE_DEBUT <= piece["date"] <= PERIODE_FIN):
        anomalies.append(_anomalie(
            piece, "hors_periode", tva_abs or d("0"), 1.0,
            f"Piece datee du {piece['date']}, hors exercice "
            f"{PERIODE_DEBUT} au {PERIODE_FIN} : non imputable."))

    # montant aberrant (regle 7)
    if fiche and ttc is not None:
        plafond = q(fiche["montant_moyen_ttc_mad"] * FACTEUR_ABERRANT)
        if abs(ttc) > plafond:
            anomalies.append(_anomalie(
                piece, "montant_aberrant", tva_abs or d("0"), 0.8,
                f"TTC de {q(abs(ttc))} MAD contre une moyenne historique de "
                f"{fiche['montant_moyen_ttc_mad']} MAD (plafond {plafond} MAD)."))
    return anomalies


# --------------------------------------------------------------- doublons

def detecter_doublons(pieces: list) -> list:
    """Regles 5 et 6. On ne fusionne jamais : on signale avec une confiance."""
    anomalies = []
    retenues = [p for p in pieces if p.get("statut") == "traite"
                and p.get("ttc") is not None and p.get("type_piece") == "facture"]
    par_tiers = {}
    for p in retenues:
        par_tiers.setdefault(p.get("tiers_libelle"), []).append(p)

    for tiers, groupe in par_tiers.items():
        groupe = sorted(groupe, key=lambda p: (p.get("date") or "", p["doc_id"]))
        for i, a in enumerate(groupe):
            for b in groupe[i + 1:]:
                if q(a["ttc"]) != q(b["ttc"]):
                    continue
                da, db = lire_date(a.get("date")), lire_date(b.get("date"))
                if not da or not db:
                    continue
                exact = (a.get("numero") == b.get("numero") and da == db)
                if exact:
                    anomalies.append(_anomalie(
                        b, "doublon_exact", abs(b.get("tva") or d("0")), 1.0,
                        f"Piece identique a {a['doc_id']} : meme numero "
                        f"{a.get('numero')}, meme date, meme TTC "
                        f"{q(a['ttc'])} MAD. TVA deduite deux fois.",
                        piece_liee=a["doc_id"]))
                elif abs((db - da).days) < ECART_DOUBLON.days:
                    anomalies.append(_anomalie(
                        b, "doublon_probable", abs(b.get("tva") or d("0")), 0.75,
                        f"Meme tiers et meme TTC ({q(b['ttc'])} MAD) que "
                        f"{a['doc_id']}, a {abs((db - da).days)} jours d'ecart "
                        f"(numeros {a.get('numero')} et {b.get('numero')}). "
                        f"A confirmer avant rejet : aucune fusion automatique.",
                        piece_liee=a["doc_id"]))
    return anomalies


# ------------------------------------------------- boucle de revue humaine

def appliquer_decisions(anomalies: list, decisions: list) -> list:
    """EX-06 : un rejet deja prononce sur un couple (tiers, famille) abaisse la
    confiance des cas suivants ; trois rejets les masquent par defaut."""
    compte = {}
    for dec in decisions:
        cle = (dec["fournisseur"], dec["famille"])
        compte.setdefault(cle, {"valide": 0, "rejete": 0})
        compte[cle][dec["verdict"]] = compte[cle].get(dec["verdict"], 0) + 1

    for a in anomalies:
        cle = (a["fournisseur"], a["famille"])
        stats = compte.get(cle)
        if not stats:
            continue
        rejets, validations = stats.get("rejete", 0), stats.get("valide", 0)
        if rejets:
            a["confiance"] = round(max(0.05, a["confiance"] - 0.25 * rejets), 2)
            a["apprentissage"] = (f"{rejets} rejet(s) deja prononce(s) sur ce "
                                  f"motif pour ce tiers")
            if rejets >= 3:
                a["statut_revue"] = "masquee_apres_rejets"
        if validations:
            a["confiance"] = round(min(1.0, a["confiance"] + 0.05 * validations), 2)
    return anomalies


def exposition_totale(anomalies: list):
    """Une piece peut porter plusieurs anomalies — ICE absent et montant
    aberrant, par exemple — mais c'est la meme TVA qui est en jeu. Le total
    retient donc, par piece, la plus forte exposition et non leur somme."""
    par_piece = {}
    for a in anomalies:
        montant = a["exposition_mad"] or d("0")
        if montant > par_piece.get(a["doc_id"], d("0")):
            par_piece[a["doc_id"]] = montant
    return q(sum(par_piece.values(), d("0")))


def auditer(pieces: list, decisions: list = None) -> list:
    anomalies = []
    for piece in pieces:
        anomalies.extend(controler_piece(piece))
    anomalies.extend(detecter_doublons(pieces))
    anomalies = appliquer_decisions(anomalies, decisions or [])
    anomalies.sort(key=lambda a: (-(a["exposition_mad"] or d("0")), -a["confiance"]))
    return anomalies

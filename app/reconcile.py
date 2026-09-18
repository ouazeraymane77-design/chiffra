"""Agent Reconciler — rapproche les pieces d'achat et les lignes bancaires.

Zero appel au modele : ce fichier est de l'arithmetique sur des Decimal.
Regles appliquees (regles-fiscales.md) :
  9.  un paiement intervient jusqu'a 60 jours apres la date de facture
  10. une ligne bancaire peut couvrir plusieurs factures (paiement groupe)
  11. un paiement peut etre partiel : le solde reste du
  12. salaires, frais bancaires et reglements clients ne se rapprochent pas
"""
import csv
from datetime import date, timedelta
from itertools import combinations

from app.money import q, d, parse_montant
from app.referentiel import (DATA, identifier_fournisseur, normaliser,
                             LIBELLES_HORS_ACHATS)


def tiers_de_libelle(libelle: str) -> str:
    """'VIR SOMAFER SARL REGROUPEMENT' -> 'SOMAFER SARL'."""
    t = normaliser(libelle)
    for mot in ("VIR", "VIREMENT", "CHQ", "CHEQUE", "PRLV", "REGROUPEMENT", "ACOMPTE"):
        t = t.replace(mot, " ")
    return " ".join(t.split())

DELAI_MAX = timedelta(days=60)
TOLERANCE_MATCH = d("0.02")
TAILLE_GROUPE_MAX = 5
CANDIDATS_MAX = 24  # borne le cout des combinaisons


def lire_date(texte: str) -> date:
    try:
        a, m, j = str(texte)[:10].split("-")
        return date(int(a), int(m), int(j))
    except Exception:
        return None


def charger_releves() -> list:
    """Lit les 6 relevés et qualifie chaque ligne."""
    lignes = []
    for fichier in sorted((DATA / "releves").glob("releve-*.csv")):
        with open(fichier, encoding="utf-8-sig") as f:
            for i, ligne in enumerate(csv.DictReader(f)):
                debit = parse_montant(ligne["debit_mad"]) or d("0")
                libelle = ligne["libelle"].strip()
                nom, _ = identifier_fournisseur(libelle)
                tiers = nom or tiers_de_libelle(libelle)
                hors_achats = (debit == 0 or
                               any(mot in libelle.upper() for mot in LIBELLES_HORS_ACHATS))
                lignes.append({
                    "ligne_id": f"{fichier.stem}-{i:03d}",
                    "releve": fichier.stem,
                    "date": ligne["date"][:10],
                    "libelle": libelle,
                    "debit": q(debit),
                    "credit": q(parse_montant(ligne["credit_mad"]) or d("0")),
                    "solde": q(parse_montant(ligne["solde_mad"])),
                    "fournisseur": None if hors_achats else nom,
                    "tiers": None if hors_achats else tiers,
                    "regroupement_annonce": "REGROUPEMENT" in libelle.upper(),
                    "hors_achats": hors_achats,
                    "reste_a_affecter": q(debit),
                    "affectations": [],
                })
    return lignes


def _dans_la_fenetre(piece: dict, ligne: dict) -> bool:
    """Le paiement tombe-t-il dans les 60 jours suivant la facture ?"""
    if piece.get("statut") != "traite" or piece.get("type_piece") != "facture":
        return False
    d_facture, d_ligne = lire_date(piece.get("date")), lire_date(ligne["date"])
    if not d_facture or not d_ligne:
        return False
    return d_facture <= d_ligne <= d_facture + DELAI_MAX


def _payable(piece: dict, ligne: dict) -> bool:
    """Le paiement tombe-t-il dans la fenetre de la facture, pour ce fournisseur ?"""
    if piece.get("statut") != "traite" or piece.get("type_piece") != "facture":
        return False
    if normaliser(piece.get("tiers_libelle") or "") != normaliser(ligne["tiers"] or ""):
        return False
    return _dans_la_fenetre(piece, ligne)


def rapprocher(pieces: list, lignes: list = None) -> dict:
    """Affecte les debits bancaires aux factures. Trois passes, de la plus sure
    a la plus permissive : exact, groupe, partiel."""
    lignes = lignes if lignes is not None else charger_releves()
    restant = {p["doc_id"]: q(p["ttc"]) for p in pieces
               if p.get("statut") == "traite" and p.get("type_piece") == "facture"
               and p.get("ttc") is not None}
    par_id = {p["doc_id"]: p for p in pieces}

    def affecter(ligne, doc_id, montant, mode, confiance):
        ligne["affectations"].append({"doc_id": doc_id, "montant": q(montant),
                                      "mode": mode, "confiance": confiance})
        ligne["reste_a_affecter"] = q(ligne["reste_a_affecter"] - montant)
        restant[doc_id] = q(restant[doc_id] - montant)

    def candidats(ligne):
        ouverts = [i for i, r in restant.items() if r > 0 and _payable(par_id[i], ligne)]
        return sorted(ouverts, key=lambda i: par_id[i]["date"])[:CANDIDATS_MAX]

    # passe 1 : le debit egale exactement une facture ouverte
    for ligne in lignes:
        if ligne["hors_achats"] or ligne["reste_a_affecter"] <= 0:
            continue
        for doc_id in candidats(ligne):
            if abs(restant[doc_id] - ligne["reste_a_affecter"]) <= TOLERANCE_MATCH:
                affecter(ligne, doc_id, restant[doc_id], "exact", 1.0)
                break

    # passe 2 : le debit couvre plusieurs factures (regle 10)
    for ligne in lignes:
        if ligne["hors_achats"] or ligne["reste_a_affecter"] <= 0:
            continue
        ouverts = candidats(ligne)
        trouve = None
        for taille in range(2, TAILLE_GROUPE_MAX + 1):
            for groupe in combinations(ouverts, taille):
                total = sum((restant[i] for i in groupe), d("0"))
                if abs(total - ligne["reste_a_affecter"]) <= TOLERANCE_MATCH:
                    trouve = groupe
                    break
            if trouve:
                break
        if trouve:
            for doc_id in trouve:
                affecter(ligne, doc_id, restant[doc_id], "groupe", 0.9)

    # passe 2b : un virement annonce "REGROUPEMENT" peut couvrir plusieurs
    # fournisseurs a la fois. On n'ouvre cette porte que pour ces lignes-la.
    for ligne in lignes:
        if (ligne["hors_achats"] or ligne["reste_a_affecter"] <= 0
                or not ligne.get("regroupement_annonce")):
            continue
        ouverts = [i for i, r in restant.items()
                   if r > 0 and _dans_la_fenetre(par_id[i], ligne)][:CANDIDATS_MAX]
        trouve = None
        for taille in range(2, TAILLE_GROUPE_MAX + 1):
            for groupe in combinations(ouverts, taille):
                total = sum((restant[i] for i in groupe), d("0"))
                if abs(total - ligne["reste_a_affecter"]) <= TOLERANCE_MATCH:
                    trouve = groupe
                    break
            if trouve:
                break
        if trouve:
            for doc_id in trouve:
                affecter(ligne, doc_id, restant[doc_id], "groupe_multi_tiers", 0.8)

    # passe 3 : paiement partiel, le solde reste du (regle 11)
    for ligne in lignes:
        if ligne["hors_achats"] or ligne["reste_a_affecter"] <= 0:
            continue
        ouverts = sorted(candidats(ligne), key=lambda i: par_id[i]["date"])
        for doc_id in ouverts:
            if ligne["reste_a_affecter"] <= 0:
                break
            montant = min(ligne["reste_a_affecter"], restant[doc_id])
            if montant > 0:
                affecter(ligne, doc_id, montant, "partiel", 0.7)

    for piece in pieces:
        solde = restant.get(piece["doc_id"])
        if solde is None:
            piece["rapprochement"] = "sans_objet"
            piece["reste_du"] = None
            continue
        paye = q(piece["ttc"] - solde)
        piece["montant_paye"] = paye
        piece["reste_du"] = q(solde)
        if solde <= TOLERANCE_MATCH:
            piece["rapprochement"] = "rapproche"
        elif paye > 0:
            piece["rapprochement"] = "partiel"
        else:
            piece["rapprochement"] = "non_rapproche"

    rapprochables = [p for p in pieces if p.get("rapprochement") in
                     ("rapproche", "partiel", "non_rapproche")]
    rapprochees = [p for p in rapprochables if p["rapprochement"] == "rapproche"]
    lignes_achats = [l for l in lignes if not l["hors_achats"]]

    return {
        "lignes": lignes,
        "taux_rapprochement": round(100 * len(rapprochees) / len(rapprochables), 1)
                              if rapprochables else 0.0,
        "factures_rapprochables": len(rapprochables),
        "factures_rapprochees": len(rapprochees),
        "lignes_bancaires": len(lignes),
        "lignes_ignorees_regle_12": sum(1 for l in lignes if l["hors_achats"]),
        "lignes_non_affectees": [l for l in lignes_achats if l["reste_a_affecter"] > 0],
        "total_reste_du": q(sum((p["reste_du"] for p in rapprochables
                                 if p["reste_du"]), d("0"))),
        "residuels_a_arbitrer": [
            {"ligne_id": l["ligne_id"], "date": l["date"], "libelle": l["libelle"],
             "debit": l["debit"], "residuel": l["reste_a_affecter"],
             "pieces_affectees": [a["doc_id"] for a in l["affectations"]]}
            for l in lignes_achats if l["reste_a_affecter"] > 0],
    }

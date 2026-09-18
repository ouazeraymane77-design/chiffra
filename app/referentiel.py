"""Chargement des referentiels fournis (fournisseurs, plan comptable, regles)."""
import csv
import unicodedata
from pathlib import Path
from app.money import q

DATA = Path(__file__).resolve().parent.parent / "data"

PERIODE_DEBUT = "2026-01-01"
PERIODE_FIN = "2026-06-30"

# Regle 12 : ces lignes bancaires ne se rapprochent d'aucune facture d'achat.
LIBELLES_HORS_ACHATS = ("SALAIRE", "FRAIS DE TENUE", "AGIOS", "COMMISSION",
                        "REGLEMENT CLIENT", "INTERETS")


def normaliser(texte: str) -> str:
    """Majuscules sans accents ni ponctuation, pour comparer des noms."""
    if not texte:
        return ""
    t = unicodedata.normalize("NFD", str(texte))
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    t = "".join(c if c.isalnum() else " " for c in t.upper())
    return " ".join(t.split())


def charger_fournisseurs() -> dict:
    fournisseurs = {}
    with open(DATA / "referentiel-fournisseurs.csv", encoding="utf-8-sig") as f:
        for ligne in csv.DictReader(f):
            ligne["taux_tva_habituel"] = int(ligne["taux_tva_habituel"])
            ligne["montant_moyen_ttc_mad"] = q(ligne["montant_moyen_ttc_mad"])
            fournisseurs[normaliser(ligne["fournisseur"])] = ligne
    return fournisseurs


def charger_plan_comptable() -> dict:
    with open(DATA / "plan-comptable.csv", encoding="utf-8-sig") as f:
        return {l["compte"]: l["libelle"] for l in csv.DictReader(f)}


FOURNISSEURS = charger_fournisseurs()
PLAN_COMPTABLE = charger_plan_comptable()


def identifier_fournisseur(texte: str):
    """Cherche un fournisseur du referentiel dans le texte d'un document.

    Renvoie (nom_referentiel, fiche) ou (None, None) si aucun ne correspond :
    dans ce cas l'Auditor levera une anomalie 'tiers inconnu'.
    """
    cible = normaliser(texte)
    meilleur, fiche = None, None
    for cle, f in FOURNISSEURS.items():
        if cle in cible and (meilleur is None or len(cle) > len(meilleur)):
            meilleur, fiche = cle, f
    if fiche:
        return fiche["fournisseur"], fiche
    # tolerance OCR : un mot rare suffit (VERITAS, SOMAFER...)
    for cle, f in FOURNISSEURS.items():
        mots = [m for m in cle.split() if len(m) >= 6]
        if mots and any(m in cible for m in mots):
            return f["fournisseur"], f
    return None, None

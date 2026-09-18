"""Les scenarios que le jury annonce, transformes en tests.

Ils tournent sur le corpus fourni : `pytest` doit passer au vert avant toute
demonstration.
"""
import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.audit import auditer
from app.ingest import ingerer, ingerer_lot, FACTURES
from app.money import coherent, parse_montant, q, tva_attendue
from app.reconcile import rapprocher


@pytest.fixture(scope="module")
def dossier():
    pieces = ingerer_lot()
    resultat = rapprocher(pieces)
    return pieces, resultat, auditer(pieces)


def familles(anomalies, doc_id):
    return {a["famille"] for a in anomalies if a["doc_id"] == doc_id}


# --------------------------------------------------------------- arithmetique

def test_les_montants_sont_des_decimaux_exacts():
    assert parse_montant("3 840,00") == Decimal("3840.00")
    assert tva_attendue(Decimal("3200"), 20) == Decimal("640.00")
    assert coherent(Decimal("3200"), Decimal("640"), Decimal("3840"))


def test_pas_de_flottant_dans_les_expositions(dossier):
    _, _, anomalies = dossier
    assert all(isinstance(a["exposition_mad"], Decimal) for a in anomalies)


# ------------------------------------------------------------ lecture honnete

def test_une_piece_illisible_ne_produit_aucun_montant(dossier):
    pieces, _, _ = dossier
    for piece in pieces:
        if piece["statut"] != "traite":
            assert piece.get("motif"), f"{piece['doc_id']} sans motif"
            assert not piece.get("ttc"), f"{piece['doc_id']} a un montant invente"


def test_une_facture_normale_est_laissee_tranquille(dossier):
    """DOC-002 : NETTOYAGE PRO, 20%, dans la periode, ICE present."""
    _, _, anomalies = dossier
    assert familles(anomalies, "DOC-002") == set()


def test_un_taux_reduit_legitime_n_est_pas_signale(dossier):
    """AGRIFOOD SOUSS releve du taux de 7% : ce n'est pas une anomalie."""
    _, _, anomalies = dossier
    assert "tva_erronee" not in familles(anomalies, "DOC-078")


# ------------------------------------------------------------------ controles

def test_doublon_exact_detecte(dossier):
    _, _, anomalies = dossier
    doublons = [a for a in anomalies if a["famille"] == "doublon_exact"]
    assert doublons, "aucun doublon exact detecte"
    assert all(a["piece_liee"] for a in doublons)


def test_doublon_probable_signale_sans_fusion(dossier):
    _, _, anomalies = dossier
    probables = [a for a in anomalies if a["famille"] == "doublon_probable"]
    assert probables
    assert all(0 < a["confiance"] < 1 for a in probables), "un doublon probable reste incertain"


def test_tva_au_mauvais_taux_chiffree_par_le_code(dossier):
    pieces, _, anomalies = dossier
    par_id = {p["doc_id"]: p for p in pieces}
    erreurs = [a for a in anomalies if a["famille"] == "tva_erronee"]
    assert erreurs
    for a in erreurs:
        piece = par_id[a["doc_id"]]
        attendu = abs(tva_attendue(abs(piece["ht"]),
                                   piece["fiche_fournisseur"]["taux_tva_habituel"])
                      - abs(piece["tva"]))
        assert a["exposition_mad"] == q(attendu)


def test_piece_hors_exercice_detectee(dossier):
    _, _, anomalies = dossier
    hors = [a for a in anomalies if a["famille"] == "hors_periode"]
    assert hors
    assert all(not ("2026-01-01" <= a["date"] <= "2026-06-30") for a in hors)


def test_tiers_absent_du_referentiel_detecte(dossier):
    _, _, anomalies = dossier
    assert [a for a in anomalies if a["famille"] == "tiers_inconnu"]


def test_au_moins_cinq_familles_d_anomalies(dossier):
    """EX-04."""
    _, _, anomalies = dossier
    assert len({a["famille"] for a in anomalies}) >= 5


# -------------------------------------------------------------- rapprochement

def test_les_lignes_hors_achats_ne_sont_jamais_des_anomalies(dossier):
    """Regle 12 : salaires, frais bancaires et reglements clients."""
    _, resultat, _ = dossier
    ignorees = [l for l in resultat["lignes"] if l["hors_achats"]]
    assert ignorees
    assert all(not l["affectations"] for l in ignorees)


def test_le_taux_de_rapprochement_est_calcule_sur_le_reel(dossier):
    _, resultat, _ = dossier
    attendu = round(100 * resultat["factures_rapprochees"]
                    / resultat["factures_rapprochables"], 1)
    assert resultat["taux_rapprochement"] == attendu
    assert resultat["taux_rapprochement"] < 100, "un taux de 100% cacherait le reste"


def test_un_paiement_partiel_laisse_un_solde_du(dossier):
    pieces, _, _ = dossier
    partiels = [p for p in pieces if p.get("rapprochement") == "partiel"]
    assert partiels
    for piece in partiels:
        assert piece["reste_du"] > 0
        assert q(piece["montant_paye"] + piece["reste_du"]) == q(piece["ttc"])


def test_le_residuel_bancaire_est_calcule_par_le_code(dossier):
    _, resultat, _ = dossier
    for ligne in resultat["lignes"]:
        affecte = sum((a["montant"] for a in ligne["affectations"]), Decimal("0"))
        assert q(affecte + ligne["reste_a_affecter"]) == q(ligne["debit"])


# ---------------------------------------------------------------- apprentissage

def test_un_rejet_abaisse_la_confiance_des_cas_suivants(dossier):
    pieces, _, anomalies = dossier
    cible = next(a for a in anomalies if a["famille"] == "doublon_probable")
    decisions = [{"fournisseur": cible["fournisseur"], "famille": cible["famille"],
                  "verdict": "rejete"}]
    apres = auditer(pieces, decisions)
    revu = next(a for a in apres if a["doc_id"] == cible["doc_id"]
                and a["famille"] == cible["famille"])
    assert revu["confiance"] < cible["confiance"]

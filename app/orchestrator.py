"""Orchestrateur — le graphe d'execution du controle.

Les etapes sont declarees, pas enfouies dans une boucle : chacune ecrit un
checkpoint en base, et une etape qui echoue n'arrete pas le dossier, elle
isole les documents en cause et les envoie en file humaine.

  lecture -> escalade_illisibles -> rapprochement -> controles
          -> chiffrage -> revision -> synthese

L'etape 'revision' relit le resultat : elle repasse sur les anomalies dont la
confiance est basse et sur celles deja rejetees par le comptable, pour que la
sortie tienne compte de ce qui a ete arbitre avant (EX-06).
"""
from datetime import datetime, timezone

from app import db
from app.audit import auditer
from app.explain import expliquer, synthetiser
from app.ingest import ingerer_lot
from app.money import q, d
from app.reconcile import rapprocher

SEUIL_AFFICHAGE = 0.30  # sous ce niveau de confiance, on n'embete pas le comptable


def maintenant() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Orchestrateur:
    def __init__(self, avec_modele: bool = True):
        self.avec_modele = avec_modele
        self.journal = []
        self.execution_id = None

    def _etape(self, nom, etat):
        horodatage = maintenant()
        self.journal.append({"etape": nom, "horodatage": horodatage, "etat": etat})
        if self.execution_id:
            db.enregistrer_checkpoint(self.execution_id, nom, etat, horodatage)

    # ------------------------------------------------------------------ noeuds

    def lecture(self):
        pieces = ingerer_lot(lecteur_modele=None)
        self._etape("lecture", {
            "pieces": len(pieces),
            "lues": sum(1 for p in pieces if p["statut"] == "traite"),
            "par_source": _compter(p.get("source_extraction") for p in pieces)})
        return pieces

    def escalade_illisibles(self, pieces):
        """Les pieces que le code n'a pas su lire partent au modele, une par une.
        Celles qui resistent restent 'non traite' : rien n'est invente."""
        from app.llm import lire_piece, disponible
        from app.ingest import ingerer
        from pathlib import Path
        from app.referentiel import DATA

        en_echec = [p for p in pieces if p["statut"] != "traite"]
        recuperees = []
        if self.avec_modele and disponible():
            for piece in en_echec:
                chemin = DATA / "factures" / piece["fichier"]
                try:
                    nouvelle = ingerer(Path(chemin), lecteur_modele=lire_piece)
                except Exception:
                    continue
                if nouvelle["statut"] == "traite":
                    pieces[pieces.index(piece)] = nouvelle
                    recuperees.append(nouvelle["doc_id"])
        self._etape("escalade_illisibles", {
            "soumises": [p["doc_id"] for p in en_echec],
            "recuperees": recuperees,
            "laissees_en_file_humaine": [p["doc_id"] for p in pieces
                                         if p["statut"] != "traite"]})
        return pieces

    def rapprochement(self, pieces):
        resultat = rapprocher(pieces)
        self._etape("rapprochement", {
            "taux": resultat["taux_rapprochement"],
            "rapprochees": resultat["factures_rapprochees"],
            "rapprochables": resultat["factures_rapprochables"],
            "lignes_ignorees_regle_12": resultat["lignes_ignorees_regle_12"],
            "residuels": len(resultat["residuels_a_arbitrer"])})
        return resultat

    def controles(self, pieces):
        anomalies = auditer(pieces, db.decisions())
        self._etape("controles", {
            "anomalies": len(anomalies),
            "par_famille": _compter(a["famille"] for a in anomalies)})
        return anomalies

    def chiffrage(self, anomalies):
        total = q(sum((a["exposition_mad"] for a in anomalies), d("0")))
        self._etape("chiffrage", {"exposition_totale_mad": str(total)})
        return total

    def revision(self, anomalies):
        """Deuxieme passe : on ecarte le bruit avant de deranger un humain."""
        gardees, ecartees = [], []
        for a in anomalies:
            if a["statut_revue"] == "masquee_apres_rejets" or a["confiance"] < SEUIL_AFFICHAGE:
                ecartees.append(a["doc_id"])
            else:
                gardees.append(a)
        self._etape("revision", {"gardees": len(gardees), "ecartees": ecartees})
        return gardees

    def redaction(self, anomalies):
        for a in anomalies:
            expliquer(a, avec_modele=self.avec_modele)
        self._etape("redaction", {
            "actions_redigees": len(anomalies),
            "par_modele": sum(1 for a in anomalies if a["action_source"] != "modele_par_defaut")})
        return anomalies

    # ------------------------------------------------------------------ graphe

    def executer(self) -> dict:
        self.execution_id = db.ouvrir_execution(maintenant())
        pieces = self.lecture()
        pieces = self.escalade_illisibles(pieces)
        rappro = self.rapprochement(pieces)
        anomalies = self.controles(pieces)
        total = self.chiffrage(anomalies)
        anomalies = self.revision(anomalies)
        anomalies = self.redaction(anomalies)

        traitees = [p for p in pieces if p["statut"] == "traite"]
        rapport = {
            "execution_id": self.execution_id,
            "genere_le": maintenant(),
            "pieces_total": len(pieces),
            "pieces_traitees": len(traitees),
            "pieces_non_traitees": len(pieces) - len(traitees),
            "taux_lecture": round(100 * len(traitees) / len(pieces), 1) if pieces else 0,
            "taux_rapprochement": rappro["taux_rapprochement"],
            "factures_rapprochees": rappro["factures_rapprochees"],
            "factures_rapprochables": rappro["factures_rapprochables"],
            "lignes_ignorees_regle_12": rappro["lignes_ignorees_regle_12"],
            "total_reste_du": str(rappro["total_reste_du"]),
            "exposition_totale_mad": str(total),
            "anomalies": anomalies,
            "non_traitees": [{"doc_id": p["doc_id"], "fichier": p["fichier"],
                              "motif": p.get("motif"),
                              "tiers": p.get("tiers_libelle")}
                             for p in pieces if p["statut"] != "traite"],
            "residuels_bancaires": rappro["residuels_a_arbitrer"],
            "pieces": [{k: v for k, v in p.items()
                        if k not in ("texte_brut", "fiche_fournisseur", "_partiel")}
                       for p in pieces],
            "journal": self.journal,
        }
        rapport["synthese"] = synthetiser(rapport) if self.avec_modele else None
        db.cloturer_execution(self.execution_id, rapport, maintenant())
        return rapport


def _compter(valeurs):
    compte = {}
    for v in valeurs:
        cle = str(v)
        compte[cle] = compte.get(cle, 0) + 1
    return compte

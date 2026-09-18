"""API et service de l'interface."""
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

load_dotenv()

from app import db  # noqa: E402  (apres load_dotenv)
from app.orchestrator import Orchestrateur, maintenant  # noqa: E402
from app.referentiel import DATA  # noqa: E402

STATIC = Path(__file__).parent / "static"
app = FastAPI(title="Chiffra", description="Controle comptable avant le fisc")


class Revue(BaseModel):
    doc_id: str
    fournisseur: str | None = None
    famille: str
    verdict: str  # "valide" ou "rejete"
    commentaire: str | None = None


@app.get("/", response_class=HTMLResponse)
def accueil():
    return (STATIC / "index.html").read_text(encoding="utf-8")


@app.post("/api/analyse")
def analyser(avec_modele: bool = True):
    """Relance le controle complet. Les decisions humaines deja prises sont
    rechargees et influencent le resultat."""
    return Orchestrateur(avec_modele=avec_modele).executer()


@app.get("/api/rapport")
def rapport():
    dernier = db.dernier_rapport()
    if not dernier:
        raise HTTPException(404, "Aucun controle n'a encore ete lance.")
    return dernier


@app.get("/api/journal")
def journal():
    return db.checkpoints()


@app.get("/api/document/{doc_id}")
def document(doc_id: str):
    """EX-05 : d'une ligne du rapport a la piece d'origine."""
    for chemin in sorted((DATA / "factures").glob(f"{doc_id}.*")):
        return FileResponse(chemin, filename=chemin.name)
    raise HTTPException(404, f"Aucun fichier pour {doc_id}")


@app.post("/api/revue")
def revue(decision: Revue):
    """EX-06 : le comptable arbitre, et l'arbitrage sert aux cas suivants."""
    if decision.verdict not in ("valide", "rejete"):
        raise HTTPException(400, "verdict attendu : valide ou rejete")
    db.enregistrer_decision(decision.doc_id, decision.fournisseur, decision.famille,
                            decision.verdict, decision.commentaire, maintenant())
    memoire = db.decisions()
    meme_motif = [d for d in memoire
                  if d["fournisseur"] == decision.fournisseur
                  and d["famille"] == decision.famille]
    return {
        "enregistre": True,
        "decisions_sur_ce_motif": len(meme_motif),
        "effet": ("Les prochaines anomalies de ce type chez ce tiers verront leur "
                  "confiance abaissee de 0,25 par rejet ; au troisieme rejet elles "
                  "ne seront plus proposees."
                  if decision.verdict == "rejete"
                  else "La confiance des cas similaires est relevee."),
    }


@app.get("/api/sante")
def sante():
    from app.llm import disponible
    return {"statut": "ok", "modele_configure": disponible(),
            "pieces_sur_disque": len(list((DATA / "factures").iterdir()))}

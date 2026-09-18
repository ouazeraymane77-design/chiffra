"""Acces aux modeles. Deux endpoints, un role chacun.

  gpt-4.1  : volume — lecture d'une piece illisible, redaction d'une action
  gpt-5.5  : raisonnement — synthese du dossier, arbitrage de priorites

Aucun de ces appels ne calcule un montant. Les chiffres sont passes au modele
deja calcules par le code ; sa tache est de les mettre en mots.
"""
import base64
import hashlib
import json
import os
from pathlib import Path

CACHE = Path(os.getenv("CACHE_DIR", "data/cache"))
CACHE.mkdir(parents=True, exist_ok=True)


def _cle(*parties) -> Path:
    empreinte = hashlib.sha256("||".join(map(str, parties)).encode()).hexdigest()[:24]
    return CACHE / f"{empreinte}.json"


def _client_rapide():
    from openai import AzureOpenAI
    return AzureOpenAI(
        api_key=os.environ["FAST_MODEL_KEY"],
        azure_endpoint=os.environ["FAST_MODEL_URL"],
        api_version=os.getenv("FAST_MODEL_API_VERSION", "2024-12-01-preview"),
    )


def _client_raisonnement():
    from openai import OpenAI
    return OpenAI(base_url=os.environ["LLM_URL"], api_key=os.environ["LLM_API_KEY"])


def disponible() -> bool:
    return bool(os.getenv("FAST_MODEL_KEY") or os.getenv("LLM_API_KEY"))


def appeler(messages, modele="rapide", max_tokens=400, json_attendu=False):
    """Appel mis en cache sur disque : deux fois la meme question, un seul appel."""
    fichier = _cle(modele, json.dumps(messages, ensure_ascii=False)[:4000], max_tokens)
    if fichier.exists():
        return json.loads(fichier.read_text())["contenu"]
    try:
        if modele == "raisonnement":
            client = _client_raisonnement()
            reponse = client.chat.completions.create(
                model=os.getenv("LLM_MODEL", "gpt-5.5"),
                messages=messages, max_completion_tokens=max_tokens)
        else:
            client = _client_rapide()
            reponse = client.chat.completions.create(
                model=os.getenv("FAST_MODEL_DEPLOYMENT", "gpt-4.1"),
                messages=messages, max_tokens=max_tokens, temperature=0)
        contenu = reponse.choices[0].message.content or ""
    except Exception as erreur:
        return None if not json_attendu else None
    if json_attendu:
        contenu = contenu.strip().removeprefix("```json").removeprefix("```").removesuffix("```")
    fichier.write_text(json.dumps({"contenu": contenu}, ensure_ascii=False))
    return contenu


# ------------------------------------------------- lecture d'une piece illisible

CONSIGNE_LECTURE = (
    "Tu lis une piece comptable marocaine. Recopie uniquement ce qui est "
    "visible. N'additionne rien, ne deduis aucun montant absent. Reponds en "
    "JSON strict, sans texte autour : "
    '{"numero":"","date":"AAAA-MM-JJ","ice_fournisseur":"","taux_tva":0,'
    '"ht":0,"tva":0,"ttc":0}. Mets null pour tout champ que tu ne lis pas.')


def lire_piece(chemin: Path, texte_ocr: str = "") -> dict:
    """Dernier recours de l'Ingestor. Le modele lit, il ne calcule pas."""
    if not disponible():
        return None
    from app.money import q
    try:
        if chemin.suffix.lower() == ".pdf":
            from app.ingest import image_depuis_pdf
            import io
            tampon = io.BytesIO()
            image_depuis_pdf(chemin).save(tampon, format="PNG")
            donnees, type_mime = tampon.getvalue(), "image/png"
        else:
            donnees = chemin.read_bytes()
            type_mime = "image/jpeg"
        encodee = base64.b64encode(donnees).decode()
    except Exception:
        return None

    contenu = [
        {"type": "text", "text": CONSIGNE_LECTURE +
         (f"\n\nOCR partiel deja obtenu :\n{texte_ocr[:1200]}" if texte_ocr else "")},
        {"type": "image_url", "image_url": {"url": f"data:{type_mime};base64,{encodee}"}},
    ]
    brut = appeler([{"role": "user", "content": contenu}], "rapide", 300, json_attendu=True)
    if not brut:
        return None
    try:
        lu = json.loads(brut)
    except json.JSONDecodeError:
        return None
    champs = {}
    for cle in ("numero", "date", "ice_fournisseur"):
        if lu.get(cle):
            champs[cle] = str(lu[cle]).strip()
    if lu.get("taux_tva"):
        champs["taux_tva"] = int(lu["taux_tva"])
    for cle in ("ht", "tva", "ttc"):
        if lu.get(cle) is not None:
            champs[cle] = q(lu[cle])
    return champs or None

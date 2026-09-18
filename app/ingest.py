"""Agent Ingestor — normalise n'importe quelle entree en piece structuree.

Escalade explicite, du moins cher au plus cher. Chaque niveau qui echoue passe
la main au suivant ; si tous echouent le document sort en 'non_traite' avec un
motif (EX-08). Aucun montant n'est invente.

  1. couche texte du PDF      (pdftotext, gratuit, exact)
  2. OCR de l'image           (tesseract, gratuit, bruite)
  3. export Excel du cabinet  (source de secours structuree)
  4. lecture par le modele    (GPT-4.1 vision, payant, dernier recours)
  5. non traite               (file humaine)

Les montants lus sont ensuite verifies par du code : HT + TVA doit egaler TTC.
Si l'OCR a abime un chiffre, on tente une reparation arithmetique et on trace
le champ reconstruit.
"""
import re
import subprocess
from pathlib import Path

from app.money import parse_montant, q, coherent, tva_attendue, d
from app.referentiel import identifier_fournisseur, DATA

FACTURES = DATA / "factures"

# l'OCR confond les chiffres et les lettres dans le numero de piece
# ("FA-2026-0C 06") : on capture large, puis on normalise.
RE_NUMERO = re.compile(
    r"\b(FACTURE|AVOIR|FACTUR[E3]|AV0IR)\s*N?[°o0]?\s*:?\s*"
    r"([A-Z]{2}\s?[-—]\s?[\dOoIlSB]{4}\s?[-—]\s?[\dOoIlSB\s]{3,6})", re.I)

TRANSPOSITION_OCR = str.maketrans({"O": "0", "o": "0", "I": "1", "l": "1",
                                   "C": "0", "S": "5", "B": "8", "—": "-"})


def normaliser_numero(brut: str) -> str:
    """Remet un numero de piece dans sa forme XX-AAAA-NNNN."""
    t = re.sub(r"\s", "", brut.upper()).translate(TRANSPOSITION_OCR)
    m = re.match(r"([A-Z]{2})-?(\d{4})-?(\d{3,4})", t)
    if not m:
        return None
    return f"{m.group(1)}-{m.group(2)}-{m.group(3).zfill(4)}"
RE_DATE = re.compile(r"\b(?:Date|Datc|Dale)\s*:?\s*(\d{4})\s*-\s*(\d{2})\s*-\s*(\d{2})", re.I)
RE_ICE_CLIENT = re.compile(r"ICE\s*client\s*:?\s*([0-9OoIlCSB]{10,20})", re.I)
RE_ICE = re.compile(r"\bICE\s*:?\s*([0-9OoIlCSB]{10,20})", re.I)
RE_TAUX = re.compile(r"TVA\s*:?\s*(\d{1,2})\s*%")
# un montant doit commencer par un chiffre ou un signe : sinon la regex
# attraperait l'en-tete du tableau ("Total HT" suivi d'un saut de ligne).
MONTANT = r"(-?\s?\d[\d\s.,]*)"
RE_HT = re.compile(r"\w{0,2}TAL\s*H\.?T\.?\s*:?\s*" + MONTANT, re.I)
RE_TVA = re.compile(r"TVA\s*\d{1,2}\s*%\s*:?\s*" + MONTANT)
RE_TTC = re.compile(r"(?:Net\s*[àa]\s*payer\s*T\.?T\.?C|\w{0,2}TAL\s*T\.?T\.?C\.?)\s*:?\s*" + MONTANT, re.I)


# ---------------------------------------------------------------- extraction

def texte_pdf(chemin: Path) -> str:
    try:
        r = subprocess.run(["pdftotext", "-layout", str(chemin), "-"],
                           capture_output=True, timeout=30)
        return r.stdout.decode("utf-8", "ignore")
    except Exception:
        return ""


def image_depuis_pdf(chemin: Path):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(chemin))
    return doc[0].render(scale=2.5).to_pil()


def texte_ocr(chemin: Path) -> str:
    import pytesseract
    from PIL import Image
    try:
        image = image_depuis_pdf(chemin) if chemin.suffix.lower() == ".pdf" else Image.open(chemin)
        try:
            return pytesseract.image_to_string(image, lang="fra+eng")
        except pytesseract.TesseractError:
            return pytesseract.image_to_string(image)
    except Exception:
        return ""


def lire_export_excel() -> dict:
    """L'export comptable du cabinet : secours structure pour les pieces illisibles."""
    import openpyxl
    fichier = FACTURES / "export-achats-T2.xlsx"
    if not fichier.exists():
        return {}
    classeur = openpyxl.load_workbook(fichier, data_only=True)
    feuille = classeur.active
    entetes = [str(c.value).strip() if c.value else "" for c in feuille[1]]
    lignes = {}
    for ligne in feuille.iter_rows(min_row=2, values_only=True):
        row = dict(zip(entetes, ligne))
        if row.get("id"):
            lignes[str(row["id"])] = row
    return lignes


EXPORT_EXCEL = lire_export_excel()


# ------------------------------------------------------------------- parsing

def champs_depuis_texte(texte: str) -> dict:
    """Applique les regex. Ne juge pas, ne repare pas : lit."""
    champs = {"type_piece": "facture"}

    m = RE_NUMERO.search(texte)
    if m:
        champs["type_piece"] = "avoir" if m.group(1).lower().startswith("av") else "facture"
        numero = normaliser_numero(m.group(2))
        if numero:
            champs["numero"] = numero

    m = RE_DATE.search(texte)
    if m:
        champs["date"] = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"

    ice_client = RE_ICE_CLIENT.search(texte)
    for m in RE_ICE.finditer(texte):
        if ice_client and m.start() == ice_client.start():
            continue
        brut = m.group(1).upper().translate(TRANSPOSITION_OCR)
        if len(brut) >= 12 and brut.isdigit():
            champs["ice_fournisseur"] = brut
            break
    if ice_client:
        champs["ice_client"] = ice_client.group(1)

    m = RE_TAUX.search(texte)
    if m:
        champs["taux_tva"] = int(m.group(1))

    # on prend la derniere occurrence : le pied de facture, pas une ligne de detail
    for cle, motif in (("ht", RE_HT), ("tva", RE_TVA), ("ttc", RE_TTC)):
        trouves = motif.findall(texte)
        if trouves:
            champs[cle] = parse_montant(trouves[-1])

    nom, fiche = identifier_fournisseur(texte[:400] or texte)
    champs["fournisseur"] = nom
    champs["fiche_fournisseur"] = fiche
    # nom tel qu'il est ecrit sur la piece : sert a rapprocher et a nommer un
    # tiers absent du referentiel, qu'on ne veut pas afficher comme "inconnu".
    for ligne in texte.splitlines()[:6]:
        ligne = ligne.strip()
        if 3 <= len(ligne) <= 60 and not ligne.upper().startswith(("ICE", "FACTURE", "AVOIR", "DATE")):
            champs["tiers_libelle"] = nom or ligne
            break
    champs.setdefault("tiers_libelle", nom)
    return champs


def reparer(champs: dict) -> dict:
    """Repare un montant abime par l'OCR, par le code et seulement si c'est sur.

    On ne comble un trou que lorsque les deux autres montants sont coherents
    avec le taux lu. Toute reconstruction est tracee dans champs_reconstruits.
    """
    ht, tva, ttc = champs.get("ht"), champs.get("tva"), champs.get("ttc")
    taux = champs.get("taux_tva")
    reconstruits = []

    if coherent(ht, tva, ttc):
        if q(ht) + q(tva) != q(ttc):
            # ecart d'un centime : un chiffre a ete mal lu, le code tranche
            champs.update(ht=q(ttc - tva), champs_reconstruits=["ht"])
        else:
            champs["champs_reconstruits"] = []
        return champs

    if ht is not None and tva is not None and ttc is None:
        ttc, reconstruits = q(ht + tva), ["ttc"]
    elif ht is not None and ttc is not None and tva is None:
        tva, reconstruits = q(ttc - ht), ["tva"]
    elif tva is not None and ttc is not None and ht is None:
        ht, reconstruits = q(ttc - tva), ["ht"]
    elif ht is not None and taux and tva is None and ttc is None:
        tva = tva_attendue(ht, taux)
        ttc, reconstruits = q(ht + tva), ["tva", "ttc"]
    elif ht is not None and tva is not None and ttc is not None:
        # les trois sont la mais ne tombent pas juste : un chiffre est abime.
        # on ne garde la reparation que si le couple restant colle au taux.
        if taux and abs(tva - tva_attendue(q(ttc - tva), taux)) <= d("0.05"):
            ht, reconstruits = q(ttc - tva), ["ht"]
        elif taux and abs(tva - tva_attendue(ht, taux)) <= d("0.05"):
            ttc, reconstruits = q(ht + tva), ["ttc"]

    champs.update(ht=ht, tva=tva, ttc=ttc, champs_reconstruits=reconstruits)

    # Un trou comble par soustraction peut masquer un chiffre mal lu. On ne
    # garde la piece que si la TVA reconstituee colle au taux porte sur le
    # document. Sinon la piece part en revue humaine plutot qu'en faux montant.
    if reconstruits and taux and None not in (ht, tva):
        if abs(abs(tva) - tva_attendue(abs(ht), taux)) > d("1"):
            champs["reconstruction_non_verifiee"] = True
    return champs


def depuis_excel(doc_id: str) -> dict:
    ligne = EXPORT_EXCEL.get(doc_id)
    if not ligne:
        return None
    nom, fiche = identifier_fournisseur(str(ligne.get("fournisseur")))
    return {
        "type_piece": "facture",
        "numero": str(ligne.get("numero") or ""),
        "date": str(ligne.get("date"))[:10],
        "ice_fournisseur": str(ligne.get("ice") or ""),
        "fournisseur": nom or str(ligne.get("fournisseur")),
        "fiche_fournisseur": fiche,
        "taux_tva": int(ligne["taux_tva"]) if ligne.get("taux_tva") else None,
        "ht": q(ligne.get("ht")), "tva": q(ligne.get("tva")), "ttc": q(ligne.get("ttc")),
        "champs_reconstruits": [],
    }


CHAMPS_MINIMUM = ("numero", "date", "ttc")


def complet(champs: dict) -> bool:
    if not champs:
        return False
    if champs.get("reconstruction_non_verifiee"):
        return False
    if any(not champs.get(c) for c in CHAMPS_MINIMUM):
        return False
    return coherent(champs.get("ht"), champs.get("tva"), champs.get("ttc"))


def ingerer(chemin: Path, lecteur_modele=None) -> dict:
    """Retourne une piece structuree avec sa source et son statut."""
    doc_id = chemin.stem
    piece = {"doc_id": doc_id, "fichier": chemin.name, "statut": "non_traite",
             "motif": None, "source_extraction": None, "champs_reconstruits": []}

    tentatives = []
    if chemin.suffix.lower() == ".pdf":
        brut = texte_pdf(chemin)
        if len(brut.strip()) > 50:
            tentatives.append(("couche_texte_pdf", brut))
    if not tentatives or chemin.suffix.lower() in (".jpg", ".jpeg", ".png"):
        tentatives.append(("ocr", texte_ocr(chemin)))

    for source, texte in tentatives:
        champs = reparer(champs_depuis_texte(texte))
        if complet(champs):
            piece.update(champs, statut="traite", source_extraction=source, texte_brut=texte)
            return piece
        piece["texte_brut"] = texte
        piece.setdefault("_partiel", champs)

    secours = depuis_excel(doc_id)
    if complet(secours):
        piece.update(secours, statut="traite", source_extraction="export_excel_cabinet")
        return piece

    if lecteur_modele is not None:
        lu = lecteur_modele(chemin, piece.get("texte_brut", ""))
        if lu:
            champs = reparer({**(piece.get("_partiel") or {}), **lu})
            if complet(champs):
                piece.update(champs, statut="traite", source_extraction="lecture_modele")
                return piece

    partiel = piece.pop("_partiel", {}) or {}
    manquants = [c for c in CHAMPS_MINIMUM if not partiel.get(c)]
    if manquants:
        motif = "champs illisibles : " + ", ".join(manquants)
    else:
        motif = ("montants incoherents apres lecture : la TVA reconstituee ne "
                 "correspond pas au taux porte sur la piece"
                 if partiel.get("reconstruction_non_verifiee")
                 else "montants incoherents apres lecture (HT + TVA != TTC)")
    # Une piece non traitee ne porte aucun montant : ce qui a ete entrevu est
    # range a part, visible pour le comptable, jamais utilise par les calculs.
    montants = ("ht", "tva", "ttc", "taux_tva")
    piece.update({k: v for k, v in partiel.items()
                  if k not in montants and k != "fiche_fournisseur"})
    piece["fiche_fournisseur"] = partiel.get("fiche_fournisseur")
    piece["lecture_partielle"] = {k: str(partiel[k]) for k in montants
                                  if partiel.get(k) is not None}
    piece.update(statut="non_traite", motif=motif, ht=None, tva=None, ttc=None,
                 taux_tva=None)
    return piece


def ingerer_lot(lecteur_modele=None) -> list:
    fichiers = sorted(f for f in FACTURES.iterdir()
                      if f.suffix.lower() in (".pdf", ".jpg", ".jpeg", ".png"))
    return [ingerer(f, lecteur_modele) for f in fichiers]

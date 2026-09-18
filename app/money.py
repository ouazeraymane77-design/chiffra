"""Arithmetique monetaire. Tout montant du projet passe par ici.

EX-07 : aucun calcul n'est confie au modele. Decimal + quantize a 2 decimales,
arrondi bancaire ROUND_HALF_UP comme en comptabilite marocaine.
"""
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
import re

CENT = Decimal("0.01")
TOLERANCE = Decimal("0.02")  # tolerance d'arrondi sur un controle de coherence


def d(value) -> Decimal:
    """Convertit en Decimal. Renvoie None si inexploitable."""
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def q(value) -> Decimal:
    """Arrondit a 2 decimales."""
    value = d(value)
    return None if value is None else value.quantize(CENT, rounding=ROUND_HALF_UP)


def parse_montant(texte: str) -> Decimal:
    """Lit un montant dans du texte brut ou de l'OCR.

    Gere les espaces insecables, la virgule decimale, le signe negatif des
    avoirs, et les caracteres parasites que l'OCR colle aux chiffres
    ('34 828.0!' -> 34828.0).
    """
    if texte is None:
        return None
    t = str(texte).replace("\u00a0", " ").replace("\u202f", " ").strip()
    negatif = t.startswith("-") or t.startswith("(")
    t = re.sub(r"[^0-9.,]", "", t)
    if not t:
        return None
    # separateur decimal = dernier . ou , suivi de 1 ou 2 chiffres
    m = re.search(r"[.,](\d{1,2})$", t)
    if m:
        entier = re.sub(r"[^0-9]", "", t[: m.start()])
        val = f"{entier or '0'}.{m.group(1)}"
    else:
        val = re.sub(r"[^0-9]", "", t)
    if not val or val == ".":
        return None
    montant = d(val)
    if montant is None:
        return None
    return -montant if negatif else montant


def tva_attendue(ht: Decimal, taux: int) -> Decimal:
    """TVA theorique pour une base HT et un taux entier."""
    return q(d(ht) * d(taux) / Decimal(100))


def coherent(ht: Decimal, tva: Decimal, ttc: Decimal) -> bool:
    """HT + TVA == TTC, a la tolerance d'arrondi pres."""
    if None in (ht, tva, ttc):
        return False
    return abs((q(ht) + q(tva)) - q(ttc)) <= TOLERANCE

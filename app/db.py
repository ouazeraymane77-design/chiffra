"""Persistance SQLite : etat du dossier, anomalies, decisions humaines,
et checkpoints de l'orchestrateur (reprise apres echec)."""
import json
import os
import sqlite3
from pathlib import Path

CHEMIN = Path(os.getenv("DB_PATH", "chiffra.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS execution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lance_le TEXT, termine_le TEXT, rapport TEXT);
CREATE TABLE IF NOT EXISTS checkpoint (
  execution_id INTEGER, etape TEXT, etat TEXT, horodatage TEXT,
  PRIMARY KEY (execution_id, etape));
CREATE TABLE IF NOT EXISTS decision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT, fournisseur TEXT, famille TEXT, verdict TEXT,
  commentaire TEXT, horodatage TEXT);
"""


def connexion():
    conn = sqlite3.connect(CHEMIN)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def ouvrir_execution(horodatage: str) -> int:
    with connexion() as conn:
        cur = conn.execute("INSERT INTO execution (lance_le) VALUES (?)", (horodatage,))
        return cur.lastrowid


def enregistrer_checkpoint(execution_id, etape, etat, horodatage):
    with connexion() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO checkpoint VALUES (?,?,?,?)",
            (execution_id, etape, json.dumps(etat, default=str, ensure_ascii=False),
             horodatage))


def cloturer_execution(execution_id, rapport, horodatage):
    with connexion() as conn:
        conn.execute("UPDATE execution SET termine_le=?, rapport=? WHERE id=?",
                     (horodatage, json.dumps(rapport, default=str, ensure_ascii=False),
                      execution_id))


def dernier_rapport():
    with connexion() as conn:
        ligne = conn.execute(
            "SELECT rapport FROM execution WHERE rapport IS NOT NULL "
            "ORDER BY id DESC LIMIT 1").fetchone()
    return json.loads(ligne["rapport"]) if ligne else None


def checkpoints(execution_id=None):
    with connexion() as conn:
        if execution_id:
            lignes = conn.execute(
                "SELECT * FROM checkpoint WHERE execution_id=? ORDER BY horodatage",
                (execution_id,)).fetchall()
        else:
            lignes = conn.execute(
                "SELECT * FROM checkpoint WHERE execution_id=(SELECT MAX(id) FROM execution)"
                " ORDER BY horodatage").fetchall()
    return [{"etape": l["etape"], "horodatage": l["horodatage"],
             "etat": json.loads(l["etat"])} for l in lignes]


def enregistrer_decision(doc_id, fournisseur, famille, verdict, commentaire, horodatage):
    with connexion() as conn:
        conn.execute(
            "INSERT INTO decision (doc_id, fournisseur, famille, verdict, commentaire,"
            " horodatage) VALUES (?,?,?,?,?,?)",
            (doc_id, fournisseur, famille, verdict, commentaire, horodatage))


def decisions() -> list:
    with connexion() as conn:
        return [dict(l) for l in conn.execute(
            "SELECT * FROM decision ORDER BY id").fetchall()]

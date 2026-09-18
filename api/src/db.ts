/**
 * Postgres : source de verite metier.
 *
 * Le cahier des charges impose le type `numeric` pour les montants. Le pilote
 * `pg` renvoie les numeric sous forme de chaine, ce qui evite tout passage par
 * un flottant : on les relit avec decimal.js quand il faut calculer.
 */
import { Pool } from "pg";

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://chiffra:chiffra@postgres:5432/chiffra",
  max: 8,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS execution (
  id            bigserial PRIMARY KEY,
  lance_le      timestamptz NOT NULL DEFAULT now(),
  termine_le    timestamptz,
  rapport       jsonb
);

CREATE TABLE IF NOT EXISTS piece (
  execution_id  bigint REFERENCES execution(id) ON DELETE CASCADE,
  doc_id        text    NOT NULL,
  fichier       text    NOT NULL,
  statut        text    NOT NULL,
  motif         text,
  source        text,
  type_piece    text,
  numero        text,
  date_piece    date,
  tiers         text,
  ice           text,
  taux_tva      smallint,
  ht            numeric(14,2),
  tva           numeric(14,2),
  ttc           numeric(14,2),
  rapprochement text,
  reste_du      numeric(14,2),
  PRIMARY KEY (execution_id, doc_id)
);

CREATE TABLE IF NOT EXISTS anomalie (
  id            bigserial PRIMARY KEY,
  execution_id  bigint REFERENCES execution(id) ON DELETE CASCADE,
  doc_id        text    NOT NULL,
  famille       text    NOT NULL,
  regle         text,
  fournisseur   text,
  exposition    numeric(14,2) NOT NULL,
  confiance     numeric(4,2)  NOT NULL,
  detail        text,
  piece_liee    text
);

CREATE TABLE IF NOT EXISTS decision (
  id           bigserial PRIMARY KEY,
  doc_id       text NOT NULL,
  fournisseur  text,
  famille      text NOT NULL,
  verdict      text NOT NULL CHECK (verdict IN ('valide','rejete')),
  commentaire  text,
  horodatage   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS anomalie_execution ON anomalie (execution_id);
CREATE INDEX IF NOT EXISTS decision_motif ON decision (fournisseur, famille);
`;

export async function preparerBase(): Promise<void> {
  await pool.query(SCHEMA);
}

export async function ouvrirExecution(): Promise<number> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO execution DEFAULT VALUES RETURNING id"
    );
    return Number(rows[0].id);
  } catch {
    return 0;
  }
}

export async function cloturerExecution(id: number, rapport: unknown): Promise<void> {
  if (!id) return;
  await pool.query(
    "UPDATE execution SET termine_le = now(), rapport = $2 WHERE id = $1",
    [id, JSON.stringify(rapport)]
  );
}

export async function dernierRapport<T>(): Promise<T | null> {
  const { rows } = await pool.query<{ rapport: T }>(
    "SELECT rapport FROM execution WHERE rapport IS NOT NULL ORDER BY id DESC LIMIT 1"
  );
  return rows[0]?.rapport ?? null;
}

export interface DecisionEnregistree {
  doc_id: string;
  fournisseur: string | null;
  famille: string;
  verdict: "valide" | "rejete";
}

export async function enregistrerDecision(
  decision: DecisionEnregistree & { commentaire?: string | null }
): Promise<number> {
  await pool.query(
    `INSERT INTO decision (doc_id, fournisseur, famille, verdict, commentaire)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      decision.doc_id,
      decision.fournisseur,
      decision.famille,
      decision.verdict,
      decision.commentaire ?? null,
    ]
  );
  const { rows } = await pool.query<{ total: string }>(
    "SELECT count(*) AS total FROM decision WHERE fournisseur IS NOT DISTINCT FROM $1 AND famille = $2",
    [decision.fournisseur, decision.famille]
  );
  return Number(rows[0].total);
}

export async function decisions(): Promise<DecisionEnregistree[]> {
  try {
    const { rows } = await pool.query<DecisionEnregistree>(
      "SELECT doc_id, fournisseur, famille, verdict FROM decision ORDER BY id"
    );
    return rows;
  } catch {
    // Base indisponible : le controle tourne quand meme, sans memoire des
    // arbitrages. Mieux vaut un rapport sans apprentissage qu'aucun rapport.
    return [];
  }
}

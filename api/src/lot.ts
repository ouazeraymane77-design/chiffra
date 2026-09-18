/**
 * Ingestion du lot, parallelisee par la file BullMQ.
 *
 * L'OCR d'un scan coute plusieurs secondes. Les 107 pieces traitees a la suite
 * prennent une minute ; reparties sur la file, quelques secondes. Si Redis est
 * indisponible, on retombe sur une lecture sequentielle plutot que d'echouer.
 */
import { basename, extname } from "node:path";
import { ingerer, type Piece } from "./ingest.js";
import { q } from "./money.js";
import { fileIngestion, ocrEnCache } from "./queue.js";
import { texteOcr } from "./ingest.js";

/** Rend l'OCR d'un document une seule fois, meme sur plusieurs executions. */
export async function ocrDocument(chemin: string): Promise<string> {
  const docId = basename(chemin, extname(chemin));
  return ocrEnCache(docId, () => texteOcr(chemin));
}

export async function ingererLot(
  chemins: string[],
  avecModele: boolean
): Promise<Piece[]> {
  const file = await fileIngestion();
  try {
    if (!file) throw new Error("Redis indisponible");
    const taches = await file.addBulk(
      chemins.map((chemin) => ({
        name: "piece",
        data: { chemin, avecModele },
        opts: { removeOnComplete: true, removeOnFail: true, attempts: 2 },
      }))
    );
    const resultats = await Promise.all(
      taches.map((tache) => tache.waitUntilFinished(undefined as never, 180_000))
    );
    return resultats.map(revivre);
  } catch {
    // Pas de worker ou pas de Redis : lecture sequentielle, plus lente mais sure.
    const pieces: Piece[] = [];
    for (const chemin of chemins) pieces.push(await ingerer(chemin));
    return pieces;
  }
}

/**
 * BullMQ transporte les resultats en JSON : les Decimal y deviennent des
 * chaines. On les reconstruit avant tout calcul, pour que le reste du code ne
 * voie jamais autre chose qu'un Decimal.
 */
export function revivre(brut: unknown): Piece {
  const p = brut as Record<string, unknown>;
  const montant = (v: unknown) => (v === null || v === undefined ? null : q(String(v)));
  const fiche = p.fiche as Record<string, unknown> | null;
  return {
    ...(p as unknown as Piece),
    ht: montant(p.ht),
    tva: montant(p.tva),
    ttc: montant(p.ttc),
    resteDu: montant(p.resteDu),
    montantPaye: montant(p.montantPaye),
    fiche: fiche
      ? ({ ...fiche, montantMoyenTtc: q(String(fiche.montantMoyenTtc)) } as Piece["fiche"])
      : null,
  };
}

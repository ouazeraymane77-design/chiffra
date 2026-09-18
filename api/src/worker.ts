/**
 * Worker BullMQ : consomme la file d'ingestion.
 *
 * Un service separe, comme le demande le cahier des charges : l'API reste
 * disponible pendant que les 107 pieces sont lues en parallele.
 */
import { ingerer } from "./ingest.js";
import { lireModele } from "./vision.js";
import { creerWorker } from "./queue.js";

const concurrence = Number(process.env.INGESTION_CONCURRENCE ?? 4);

const worker = creerWorker(async (tache) => {
  const { chemin, avecModele } = tache.data;
  const piece = await ingerer(chemin, avecModele ? lireModele : undefined);
  // BullMQ serialise le resultat en JSON : les Decimal deviennent des chaines,
  // relues telles quelles par le rapport. Aucun flottant n'apparait.
  return JSON.parse(JSON.stringify(piece));
}, concurrence);

worker.on("failed", (tache, erreur) => {
  console.error(`piece en echec : ${tache?.data.chemin}`, erreur.message);
});

console.log(`worker d'ingestion demarre, concurrence ${concurrence}`);

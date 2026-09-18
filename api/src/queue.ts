/**
 * Redis : cache des appels au modele et a l'OCR, et file de travail BullMQ.
 *
 * L'ingestion des 107 pieces se parallelise sur la file `ingestion` : l'OCR
 * d'un scan coute plusieurs secondes, les faire un par un couterait une minute.
 */
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";

const url = process.env.REDIS_URL ?? "redis://redis:6379";

/** Connexion pour le cache : requetes courtes, reponses immediates. */
export const cache = new Redis(url, {
  lazyConnect: true,
  connectTimeout: 1000,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  // Sans Redis, on ne veut pas attendre : le controle doit tourner quand meme.
  retryStrategy: () => null,
});
cache.on("error", () => undefined);

let etatRedis: boolean | null = null;

/** Sonde Redis une fois, avec une limite de temps ferme. */
export async function redisDisponible(): Promise<boolean> {
  if (etatRedis !== null) return etatRedis;
  try {
    await Promise.race([
      cache.ping(),
      new Promise((_, rejeter) => setTimeout(() => rejeter(new Error("delai depasse")), 1500)),
    ]);
    etatRedis = true;
  } catch {
    etatRedis = false;
  }
  return etatRedis;
}

/** BullMQ exige une connexion sans limite de tentatives. */
export const connexionFile = { connection: { url } };

export const FILE_INGESTION = "ingestion";

export interface TacheIngestion {
  chemin: string;
  avecModele: boolean;
}

let file: Queue<TacheIngestion> | null = null;

export async function fileIngestion(): Promise<Queue<TacheIngestion> | null> {
  if (!(await redisDisponible())) return null;
  file ??= new Queue<TacheIngestion>(FILE_INGESTION, connexionFile);
  return file;
}

export function creerWorker(
  traiter: (tache: Job<TacheIngestion>) => Promise<unknown>,
  concurrence = 4
): Worker<TacheIngestion> {
  return new Worker<TacheIngestion>(FILE_INGESTION, traiter, {
    ...connexionFile,
    concurrency: concurrence,
  });
}

/** Cache de l'OCR par document : un scan n'est rendu qu'une fois. */
export async function ocrEnCache(
  docId: string,
  produire: () => Promise<string>
): Promise<string> {
  if (!(await redisDisponible())) return produire();
  const cle = `ocr:${docId}`;
  try {
    const connu = await cache.get(cle);
    if (connu !== null) return connu;
  } catch {
    return produire();
  }
  const texte = await produire();
  try {
    await cache.set(cle, texte, "EX", 60 * 60 * 24 * 7);
  } catch {
    // Le cache est une commodite, pas une dependance.
  }
  return texte;
}

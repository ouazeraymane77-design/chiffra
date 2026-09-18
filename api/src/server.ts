/**
 * API Fastify : lance le controle, sert le rapport, ouvre les pieces,
 * enregistre les arbitrages du comptable.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Fastify from "fastify";
import {
  cloturerExecution,
  decisions,
  dernierRapport,
  enregistrerDecision,
  ouvrirExecution,
  preparerBase,
} from "./db.js";
import { graphe } from "./graph.js";
import { DOSSIER_DONNEES, fichiersPieces } from "./referentiel.js";
import { modeleDisponible } from "./llm.js";
import { construireRapport, type Rapport } from "./rapport.js";

const app = Fastify({ logger: true, bodyLimit: 4 * 1024 * 1024 });

app.post<{ Querystring: { avec_modele?: string } }>("/api/analyse", async (requete) => {
  const avecModele = requete.query.avec_modele !== "false";
  const executionId = await ouvrirExecution();
  const flot = await graphe();

  const etat = await flot.invoke(
    { avecModele },
    { configurable: { thread_id: `execution-${executionId ?? randomUUID()}` }, recursionLimit: 30 }
  );

  const rapport = construireRapport(executionId, etat);
  await cloturerExecution(executionId, rapport);
  return rapport;
});

app.get("/api/rapport", async (_requete, reponse) => {
  const rapport = await dernierRapport<Rapport>();
  if (!rapport) return reponse.code(404).send({ message: "Aucun controle n'a encore ete lance." });
  return rapport;
});

/** EX-05 : d'une ligne du rapport a la piece d'origine. */
app.get<{ Params: { docId: string } }>("/api/document/:docId", async (requete, reponse) => {
  const { docId } = requete.params;
  if (!/^[A-Za-z0-9_-]+$/.test(docId)) return reponse.code(400).send({ message: "Identifiant invalide." });
  const fichier = fichiersPieces().find((chemin) => chemin.includes(`${docId}.`));
  if (!fichier) return reponse.code(404).send({ message: `Aucun fichier pour ${docId}` });
  const { createReadStream } = await import("node:fs");
  reponse.header("Content-Type", fichier.endsWith(".pdf") ? "application/pdf" : "image/jpeg");
  return reponse.send(createReadStream(fichier));
});

/** EX-06 : le comptable arbitre, et l'arbitrage sert aux cas suivants. */
app.post<{
  Body: {
    doc_id: string;
    fournisseur?: string | null;
    famille: string;
    verdict: "valide" | "rejete";
    commentaire?: string | null;
  };
}>("/api/revue", async (requete, reponse) => {
  const decision = requete.body;
  if (!["valide", "rejete"].includes(decision.verdict)) {
    return reponse.code(400).send({ message: "verdict attendu : valide ou rejete" });
  }
  const total = await enregistrerDecision({
    doc_id: decision.doc_id,
    fournisseur: decision.fournisseur ?? null,
    famille: decision.famille,
    verdict: decision.verdict,
    commentaire: decision.commentaire ?? null,
  });
  return {
    enregistre: true,
    decisions_sur_ce_motif: total,
    effet:
      decision.verdict === "rejete"
        ? "Les prochaines anomalies de ce type chez ce tiers verront leur confiance abaissee de 0,25 par rejet ; au troisieme rejet elles ne seront plus proposees."
        : "La confiance des cas similaires est relevee.",
  };
});

app.get("/api/journal", async () => {
  const rapport = await dernierRapport<Rapport>();
  return rapport?.journal ?? [];
});

app.get("/api/sante", async () => ({
  statut: "ok",
  modele_configure: modeleDisponible(),
  pieces_sur_disque: fichiersPieces().length,
  donnees: join(DOSSIER_DONNEES, "factures"),
  decisions_enregistrees: (await decisions()).length,
}));

const port = Number(process.env.PORT ?? 8000);
await preparerBase();
await app.listen({ port, host: "0.0.0.0" });

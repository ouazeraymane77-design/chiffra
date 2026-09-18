import type { Anomalie, Rapport, ReponseRevue, Verdict } from "./types";

async function lire<T>(reponse: Response): Promise<T> {
  if (!reponse.ok) {
    const texte = await reponse.text();
    throw new Error(texte || `Le serveur a répondu ${reponse.status}.`);
  }
  return (await reponse.json()) as T;
}

/** Relance la chaine complete. `avecModele` a false execute tout en code pur. */
export async function lancerControle(avecModele: boolean): Promise<Rapport> {
  return lire<Rapport>(
    await fetch(`/api/analyse?avec_modele=${avecModele}`, { method: "POST" })
  );
}

/** Dernier rapport enregistre, ou null si aucun controle n'a encore tourne. */
export async function dernierRapport(): Promise<Rapport | null> {
  const reponse = await fetch("/api/rapport");
  if (reponse.status === 404) return null;
  return lire<Rapport>(reponse);
}

export async function arbitrer(
  anomalie: Anomalie,
  verdict: Verdict
): Promise<ReponseRevue> {
  return lire<ReponseRevue>(
    await fetch("/api/revue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        doc_id: anomalie.doc_id,
        fournisseur: anomalie.fournisseur,
        famille: anomalie.famille,
        verdict,
      }),
    })
  );
}

export const lienPiece = (docId: string) => `/api/document/${docId}`;

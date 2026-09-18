/**
 * Acces aux modeles. Deux endpoints compatibles OpenAI, un role chacun.
 *
 *   gpt-4.1  volume : lecture d'une piece illisible, redaction d'une action
 *   gpt-5.5  raisonnement : synthese du dossier
 *
 * Aucun de ces appels ne calcule un montant. Les chiffres sont passes au
 * modele deja calcules par le code ; sa tache est de les mettre en mots.
 */
import { createHash } from "node:crypto";
import OpenAI from "openai";
import { cache, redisDisponible } from "./queue.js";

type Role = "rapide" | "raisonnement";

export const modeleDisponible = (): boolean =>
  Boolean(process.env.FAST_MODEL_KEY || process.env.LLM_API_KEY);

function client(role: Role): OpenAI {
  if (role === "raisonnement") {
    return new OpenAI({
      apiKey: process.env.LLM_API_KEY ?? "",
      baseURL: process.env.LLM_URL,
    });
  }
  const base = (process.env.FAST_MODEL_URL ?? "").replace(/\/$/, "");
  const deploiement = process.env.FAST_MODEL_DEPLOYMENT ?? "gpt-4.1";
  const version = process.env.FAST_MODEL_API_VERSION ?? "2024-12-01-preview";
  return new OpenAI({
    apiKey: process.env.FAST_MODEL_KEY ?? "",
    baseURL: `${base}/openai/deployments/${deploiement}`,
    defaultQuery: { "api-version": version },
    defaultHeaders: { "api-key": process.env.FAST_MODEL_KEY ?? "" },
  });
}

/** Appel mis en cache dans Redis : deux fois la meme question, un seul appel. */
export async function appeler(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  role: Role = "rapide",
  maxTokens = 400
): Promise<string | null> {
  const cle =
    "llm:" +
    createHash("sha256")
      .update(`${role}|${maxTokens}|${JSON.stringify(messages).slice(0, 6000)}`)
      .digest("hex")
      .slice(0, 32);

  let enCache: string | null = null;
  try {
    if (await redisDisponible()) enCache = await cache.get(cle);
  } catch {
    // Cache indisponible : on appelle le modele, simplement.
  }
  if (enCache !== null) return enCache;

  try {
    const modele =
      role === "raisonnement"
        ? (process.env.LLM_MODEL ?? "gpt-5.5")
        : (process.env.FAST_MODEL_DEPLOYMENT ?? "gpt-4.1");
    const reponse = await client(role).chat.completions.create(
      role === "raisonnement"
        ? { model: modele, messages, max_completion_tokens: maxTokens }
        : { model: modele, messages, max_tokens: maxTokens, temperature: 0 }
    );
    const contenu = reponse.choices[0]?.message?.content ?? "";
    try {
      if (await redisDisponible()) await cache.set(cle, contenu, "EX", 60 * 60 * 24);
    } catch {
      // idem
    }
    return contenu;
  } catch {
    return null;
  }
}

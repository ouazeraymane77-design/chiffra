/**
 * Lecture d'une piece par le modele : dernier recours de l'Ingestor.
 *
 * Le modele lit, il ne calcule pas. La consigne le lui dit, et tout ce qu'il
 * renvoie est ensuite reverifie par le code : coherence HT + TVA = TTC,
 * correspondance au taux porte, et vraisemblance face a l'historique du tiers.
 */
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";
import { q } from "./money.js";
import { appeler, modeleDisponible } from "./llm.js";
import type { LecteurModele } from "./ingest.js";

const executer = promisify(execFile);

const CONSIGNE =
  "Tu lis une piece comptable marocaine. Recopie uniquement ce qui est " +
  "visible. N'additionne rien, ne deduis aucun montant absent. Reponds en " +
  "JSON strict, sans texte autour : " +
  '{"numero":"","date":"AAAA-MM-JJ","ice_fournisseur":"","taux_tva":0,' +
  '"ht":0,"tva":0,"ttc":0}. Mets null pour tout champ que tu ne lis pas.';

async function imageBase64(chemin: string): Promise<{ donnees: string; type: string }> {
  if (extname(chemin).toLowerCase() === ".pdf") {
    const { stdout } = await executer(
      "sh",
      ["-c", `pdftoppm -png -r 160 -f 1 -l 1 "${chemin}" | base64 -w0`],
      { maxBuffer: 32 * 1024 * 1024 }
    );
    return { donnees: stdout.trim(), type: "image/png" };
  }
  return { donnees: readFileSync(chemin).toString("base64"), type: "image/jpeg" };
}

export const lireModele: LecteurModele = async (chemin, ocr) => {
  if (!modeleDisponible()) return null;
  let image: { donnees: string; type: string };
  try {
    image = await imageBase64(chemin);
  } catch {
    return null;
  }

  const brut = await appeler(
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: CONSIGNE + (ocr ? `\n\nOCR partiel deja obtenu :\n${ocr.slice(0, 1200)}` : ""),
          },
          {
            type: "image_url",
            image_url: { url: `data:${image.type};base64,${image.donnees}` },
          },
        ],
      },
    ],
    "rapide",
    300
  );
  if (!brut) return null;

  let lu: Record<string, unknown>;
  try {
    lu = JSON.parse(brut.trim().replace(/^```json|^```|```$/g, "").trim());
  } catch {
    return null;
  }

  const champs: Record<string, unknown> = {};
  if (lu.numero) champs.numero = String(lu.numero).trim();
  if (lu.date) champs.date = String(lu.date).slice(0, 10);
  if (lu.ice_fournisseur) champs.iceFournisseur = String(lu.ice_fournisseur).trim();
  if (lu.taux_tva) champs.tauxTva = Number(lu.taux_tva);
  for (const cle of ["ht", "tva", "ttc"] as const) {
    if (lu[cle] !== null && lu[cle] !== undefined) champs[cle] = q(String(lu[cle]));
  }
  return Object.keys(champs).length ? champs : null;
};

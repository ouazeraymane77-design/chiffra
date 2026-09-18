import { useState } from "react";
import { arbitrer, lienPiece } from "../api";
import { COULEUR } from "../couleurs";
import { dateLisible, mad } from "../format";
import type { Anomalie, Verdict } from "../types";

interface Props {
  anomalies: Anomalie[];
  pointee: string | null;
}

export function Anomalies({ anomalies, pointee }: Props) {
  const [verdicts, setVerdicts] = useState<Record<string, string>>({});
  const [ecartees, setEcartees] = useState<Set<string>>(new Set());

  const cle = (a: Anomalie) => `${a.doc_id}:${a.famille}`;

  async function decider(a: Anomalie, verdict: Verdict) {
    setVerdicts((v) => ({ ...v, [cle(a)]: "Enregistrement…" }));
    try {
      const reponse = await arbitrer(a, verdict);
      setVerdicts((v) => ({
        ...v,
        [cle(a)]:
          (verdict === "rejete" ? "Rejetée" : "Retenue") +
          `, ${reponse.decisions_sur_ce_motif} décision sur ce motif`,
      }));
      if (verdict === "rejete")
        setEcartees((e) => new Set(e).add(cle(a)));
    } catch {
      setVerdicts((v) => ({
        ...v,
        [cle(a)]: "Non enregistrée, réessayez.",
      }));
    }
  }

  if (anomalies.length === 0)
    return <div className="vide">Aucune anomalie retenue sur ce lot.</div>;

  return (
    <div className="liste">
      {anomalies.map((a) => {
        const inactive =
          ecartees.has(cle(a)) || a.statut_revue === "masquee_apres_rejets";
        return (
          <article
            key={cle(a)}
            id={`piece-${a.doc_id}`}
            className={[
              "ligne",
              inactive ? "ecartee" : "",
              pointee === a.doc_id ? "pointee" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <div className="piece">
              <a href={lienPiece(a.doc_id)} target="_blank" rel="noopener">
                {a.doc_id}
              </a>
              <p>{a.fournisseur ?? "tiers non identifié"}</p>
              <p>
                {a.numero ?? "sans numéro"}, du {dateLisible(a.date)}
              </p>
            </div>

            <div>
              <span
                className="motif"
                style={{ borderColor: COULEUR[a.famille], color: COULEUR[a.famille] }}
              >
                {a.libelle}
              </span>
              <p className="constat">{a.detail}</p>
              {a.action && <p className="consigne">À faire : {a.action}</p>}
              {a.apprentissage && (
                <p className="memoire">Mémoire : {a.apprentissage}</p>
              )}
            </div>

            <div className="chiffre">
              <b>{mad(a.exposition_mad)}</b>
              <span>dirhams</span>
              <span>confiance {a.confiance.toFixed(2)}</span>
            </div>

            <div className="arbitrage">
              <div>
                <button
                  type="button"
                  className="sobre"
                  onClick={() => decider(a, "valide")}
                >
                  Retenir
                </button>
                <button
                  type="button"
                  className="sobre"
                  onClick={() => decider(a, "rejete")}
                >
                  Rejeter
                </button>
              </div>
              {verdicts[cle(a)] && (
                <p className="verdict">{verdicts[cle(a)]}</p>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

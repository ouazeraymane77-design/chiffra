import { COULEUR } from "../couleurs";
import { mad, pourcent } from "../format";
import type { Anomalie, Rapport } from "../types";

interface Props {
  rapport: Rapport;
  surSegment: (docId: string) => void;
}

interface Part {
  famille: Anomalie["famille"];
  libelle: string;
  montant: number;
  premierDocId: string;
}

/** Regroupe l'exposition par famille, la plus couteuse d'abord. */
function parts(anomalies: Anomalie[]): Part[] {
  const cumul = new Map<string, Part>();
  for (const a of anomalies) {
    const montant = Number(a.exposition_mad);
    if (montant <= 0) continue;
    const existante = cumul.get(a.famille);
    if (existante) existante.montant += montant;
    else
      cumul.set(a.famille, {
        famille: a.famille,
        libelle: a.libelle,
        montant,
        premierDocId: a.doc_id,
      });
  }
  return [...cumul.values()].sort((x, y) => y.montant - x.montant);
}

export function Exposition({ rapport, surSegment }: Props) {
  const total = Number(rapport.exposition_totale_mad);
  const segments = parts(rapport.anomalies ?? []);
  const chiffrees = (rapport.anomalies ?? []).filter(
    (a) => Number(a.exposition_mad) > 0
  ).length;

  return (
    <div className="exposition">
      <p className="montant">
        <strong>{mad(rapport.exposition_totale_mad)}</strong>
        <span>dirhams de risque</span>
      </p>
      <p className="glose">
        Redressements et déductions de TVA contestables sur {chiffrees} anomalies
        chiffrées. Les montants sont calculés par le code, jamais par le modèle.
      </p>

      {total > 0 && (
        <>
          <div
            className="bande"
            role="group"
            aria-label="Répartition du risque par famille d'anomalie"
          >
            {segments.map((part) => (
              <button
                key={part.famille}
                type="button"
                style={{
                  width: `${(100 * part.montant) / total}%`,
                  background: COULEUR[part.famille],
                }}
                title={`${part.libelle} : ${mad(part.montant)} MAD`}
                aria-label={`${part.libelle}, ${mad(part.montant)} dirhams`}
                onClick={() => surSegment(part.premierDocId)}
              />
            ))}
          </div>
          <p className="legende">
            {segments.map((part) => (
              <span key={part.famille}>
                <i
                  className="puce"
                  style={{ background: COULEUR[part.famille] }}
                />
                {part.libelle} {mad(part.montant)}
              </span>
            ))}
          </p>
        </>
      )}

      <div className="mesures">
        <div className="mesure">
          <b>
            {rapport.pieces_traitees} sur {rapport.pieces_total}
          </b>
          <span>pièces lues, soit {pourcent(rapport.taux_lecture)}</span>
        </div>
        <div className="mesure">
          <b>{pourcent(rapport.taux_rapprochement)}</b>
          <span>
            rapprochées à la banque, {rapport.factures_rapprochees} sur{" "}
            {rapport.factures_rapprochables}
          </span>
        </div>
        <div className="mesure">
          <b>{mad(rapport.total_reste_du)}</b>
          <span>dirhams restant dus aux fournisseurs</span>
        </div>
        <div className="mesure">
          <b>{rapport.pieces_non_traitees}</b>
          <span>pièces laissées au comptable</span>
        </div>
      </div>
    </div>
  );
}

import { lienPiece } from "../api";
import { dateLisible, mad } from "../format";
import type { EtapeJournal, PieceNonTraitee, ResiduelBancaire } from "../types";

export function NonTraitees({ pieces }: { pieces: PieceNonTraitee[] }) {
  if (pieces.length === 0)
    return <div className="vide">Toutes les pièces ont été lues.</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>Pièce</th>
          <th>Pourquoi elle n'a pas été retenue</th>
          <th>Tiers lu</th>
        </tr>
      </thead>
      <tbody>
        {pieces.map((p) => (
          <tr key={p.doc_id}>
            <td>
              <a href={lienPiece(p.doc_id)} target="_blank" rel="noopener">
                {p.doc_id}
              </a>
            </td>
            <td>{p.motif}</td>
            <td>{p.tiers ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Residuels({ lignes }: { lignes: ResiduelBancaire[] }) {
  if (lignes.length === 0)
    return <div className="vide">Toutes les lignes d'achat sont soldées.</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Libellé</th>
          <th className="nombre">Débit</th>
          <th className="nombre">Résiduel</th>
          <th>Pièces affectées</th>
        </tr>
      </thead>
      <tbody>
        {lignes.map((l) => (
          <tr key={l.ligne_id}>
            <td>{dateLisible(l.date)}</td>
            <td>{l.libelle}</td>
            <td className="nombre">{mad(l.debit)}</td>
            <td className="nombre">{mad(l.residuel)}</td>
            <td>
              {l.pieces_affectees?.length
                ? l.pieces_affectees.join(", ")
                : "aucune"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Journal({ etapes }: { etapes: EtapeJournal[] }) {
  return (
    <details>
      <summary>Ouvrir le déroulé, {(etapes ?? []).length} étapes</summary>
      <pre>
        {(etapes ?? [])
          .map((e) => `${e.etape}\n  ${JSON.stringify(e.etat)}`)
          .join("\n\n")}
      </pre>
    </details>
  );
}

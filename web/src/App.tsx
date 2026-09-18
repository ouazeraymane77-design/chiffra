import { useEffect, useState } from "react";
import { dernierRapport, lancerControle } from "./api";
import { Anomalies } from "./components/Anomalies";
import { Exposition } from "./components/Exposition";
import { Journal, NonTraitees, Residuels } from "./components/Reste";
import type { Rapport } from "./types";

type Etat =
  | { phase: "vide" }
  | { phase: "encours" }
  | { phase: "pret"; rapport: Rapport }
  | { phase: "echec"; message: string };

export default function App() {
  const [etat, setEtat] = useState<Etat>({ phase: "vide" });
  const [pointee, setPointee] = useState<string | null>(null);

  useEffect(() => {
    dernierRapport()
      .then((r) => r && setEtat({ phase: "pret", rapport: r }))
      .catch(() => undefined);
  }, []);

  async function controler(avecModele: boolean) {
    setEtat({ phase: "encours" });
    try {
      setEtat({ phase: "pret", rapport: await lancerControle(avecModele) });
    } catch (erreur) {
      setEtat({
        phase: "echec",
        message:
          erreur instanceof Error ? erreur.message : "Cause inconnue.",
      });
    }
  }

  function allerA(docId: string) {
    setPointee(docId);
    document
      .getElementById(`piece-${docId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const occupe = etat.phase === "encours";

  return (
    <div className="page">
      <header className="entete">
        <div>
          <h1 className="marque">Chiffra</h1>
          <p className="dossier">
            ATLAS DIGITAL SERVICES SARL, exercice du 1<sup>er</sup> janvier au
            30 juin 2026
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="sobre"
            disabled={occupe}
            onClick={() => controler(false)}
          >
            Contrôler sans le modèle
          </button>
          <button type="button" disabled={occupe} onClick={() => controler(true)}>
            Lancer le contrôle
          </button>
        </div>
      </header>

      {etat.phase === "vide" && (
        <div className="vide" style={{ marginTop: 24 }}>
          Le dossier contient 107 pièces et 6 relevés bancaires. Lancez le
          contrôle pour obtenir le risque chiffré et les pièces à arbitrer.
        </div>
      )}

      {occupe && (
        <div className="vide" style={{ marginTop: 24 }}>
          Lecture des pièces, rapprochement bancaire, contrôles fiscaux. Comptez
          une trentaine de secondes.
        </div>
      )}

      {etat.phase === "echec" && (
        <div className="vide erreur" style={{ marginTop: 24 }}>
          Le contrôle n'a pas abouti : {etat.message} Relancez-le.
        </div>
      )}

      {etat.phase === "pret" && (
        <>
          <Exposition rapport={etat.rapport} surSegment={allerA} />

          {etat.rapport.synthese && (
            <div className="synthese">
              <h2>Note de l'agent</h2>
              {etat.rapport.synthese}
            </div>
          )}

          <section>
            <h2>Anomalies, de la plus coûteuse à la moins coûteuse</h2>
            <p className="intro">
              Chaque identifiant ouvre la pièce d'origine. Un rejet abaisse la
              confiance des cas identiques chez le même tiers.
            </p>
            <Anomalies anomalies={etat.rapport.anomalies ?? []} pointee={pointee} />
          </section>

          <section>
            <h2>Pièces laissées au comptable</h2>
            <p className="intro">
              Lecture impossible ou montant invraisemblable : aucune valeur n'a
              été retenue, aucun montant n'a été inventé.
            </p>
            <NonTraitees pieces={etat.rapport.non_traitees ?? []} />
          </section>

          <section>
            <h2>Lignes bancaires non soldées</h2>
            <p className="intro">
              Salaires, frais bancaires et règlements clients sont écartés
              d'office : {etat.rapport.lignes_ignorees_regle_12} lignes, jamais
              comptées comme anomalies.
            </p>
            <Residuels lignes={etat.rapport.residuels_bancaires ?? []} />
          </section>

          <section>
            <h2>Déroulé de l'agent</h2>
            <p className="intro">
              Les étapes du graphe et leur état, tels qu'ils sont enregistrés en
              base à chaque passage.
            </p>
            <Journal etapes={etat.rapport.journal ?? []} />
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Orchestrateur — le graphe d'execution du controle, en LangGraph.
 *
 * Les etapes sont declarees comme des noeuds, pas enfouies dans une boucle :
 * chacune ecrit son etat, le checkpointer Postgres le persiste, et une etape
 * qui echoue n'arrete pas le dossier — elle isole les documents en cause et
 * les envoie en file humaine.
 *
 *   lecture -> escalade_illisibles -> rapprochement -> controles
 *           -> chiffrage -> revision -> redaction -> synthese
 *
 * L'etape « revision » relit le resultat : elle ecarte le bruit et applique les
 * arbitrages deja rendus par le comptable avant de deranger un humain (EX-06).
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { auditer, expositionTotale, type Anomalie } from "./audit.js";
import { decisions } from "./db.js";
import { expliquer, synthetiser } from "./explain.js";
import { ingerer, type Piece } from "./ingest.js";
import { lireModele } from "./vision.js";
import { fichiersPieces } from "./referentiel.js";
import { rapprocher, type Rapprochement } from "./reconcile.js";
import { ingererLot } from "./lot.js";

/** Sous ce niveau de confiance, on n'embete pas le comptable. */
const SEUIL_AFFICHAGE = 0.3;

export interface EtapeJournal {
  etape: string;
  horodatage: string;
  etat: Record<string, unknown>;
}

const Etat = Annotation.Root({
  avecModele: Annotation<boolean>({ reducer: (_, n) => n, default: () => true }),
  pieces: Annotation<Piece[]>({ reducer: (_, n) => n, default: () => [] }),
  rapprochement: Annotation<Rapprochement | null>({
    reducer: (_, n) => n,
    default: () => null,
  }),
  anomalies: Annotation<Anomalie[]>({ reducer: (_, n) => n, default: () => [] }),
  expositionTotale: Annotation<string>({ reducer: (_, n) => n, default: () => "0.00" }),
  synthese: Annotation<string | null>({ reducer: (_, n) => n, default: () => null }),
  journal: Annotation<EtapeJournal[]>({
    // Les etapes s'ajoutent : le journal est la trace de la boucle agentique.
    reducer: (courant, nouvelles) => [...courant, ...nouvelles],
    default: () => [],
  }),
});

type EtatGraphe = typeof Etat.State;

const maintenant = () => new Date().toISOString();

const trace = (etape: string, etat: Record<string, unknown>): EtapeJournal[] => [
  { etape, horodatage: maintenant(), etat },
];

function compter(valeurs: (string | null)[]): Record<string, number> {
  const compte: Record<string, number> = {};
  for (const v of valeurs) {
    const cle = String(v);
    compte[cle] = (compte[cle] ?? 0) + 1;
  }
  return compte;
}

// -------------------------------------------------------------------- noeuds

async function lecture(etat: EtatGraphe) {
  const pieces = await ingererLot(fichiersPieces(), false);
  return {
    pieces,
    journal: trace("lecture", {
      pieces: pieces.length,
      lues: pieces.filter((p) => p.statut === "traite").length,
      par_source: compter(pieces.map((p) => p.sourceExtraction)),
      parallelisation: "file BullMQ sur Redis",
      avec_modele: etat.avecModele,
    }),
  };
}

/**
 * Les pieces que le code n'a pas su lire partent au modele, une par une.
 * Celles qui resistent restent « non traite » : rien n'est invente.
 */
async function escaladeIllisibles(etat: EtatGraphe) {
  const enEchec = etat.pieces.filter((p) => p.statut !== "traite");
  const pieces = [...etat.pieces];
  const recuperees: string[] = [];

  if (etat.avecModele) {
    for (const piece of enEchec) {
      try {
        const nouvelle = await ingerer(
          `${process.env.DATA_DIR ?? "/srv/data"}/factures/${piece.fichier}`,
          lireModele
        );
        if (nouvelle.statut === "traite") {
          pieces[pieces.findIndex((p) => p.docId === piece.docId)] = nouvelle;
          recuperees.push(nouvelle.docId);
        }
      } catch {
        // Un echec d'escalade laisse la piece en file humaine, sans plus.
      }
    }
  }

  return {
    pieces,
    journal: trace("escalade_illisibles", {
      soumises: enEchec.map((p) => p.docId),
      recuperees,
      laissees_en_file_humaine: pieces
        .filter((p) => p.statut !== "traite")
        .map((p) => p.docId),
    }),
  };
}

function rapprochement(etat: EtatGraphe) {
  const resultat = rapprocher(etat.pieces);
  return {
    rapprochement: resultat,
    journal: trace("rapprochement", {
      taux: resultat.tauxRapprochement,
      rapprochees: resultat.facturesRapprochees,
      rapprochables: resultat.facturesRapprochables,
      lignes_ignorees_regle_12: resultat.lignesIgnoreesRegle12,
      residuels: resultat.residuelsAArbitrer.length,
    }),
  };
}

async function controles(etat: EtatGraphe) {
  const anomalies = auditer(etat.pieces, await decisions());
  return {
    anomalies,
    journal: trace("controles", {
      anomalies: anomalies.length,
      par_famille: compter(anomalies.map((a) => a.famille)),
    }),
  };
}

function chiffrage(etat: EtatGraphe) {
  const total = expositionTotale(etat.anomalies).toFixed(2);
  return {
    expositionTotale: total,
    journal: trace("chiffrage", {
      exposition_totale_mad: total,
      methode:
        "plus forte exposition par piece, jamais la somme des anomalies d'une meme piece",
    }),
  };
}

/** Deuxieme passe : on ecarte le bruit avant de deranger un humain. */
function revision(etat: EtatGraphe) {
  const gardees = etat.anomalies.filter(
    (a) => a.statutRevue !== "masquee_apres_rejets" && a.confiance >= SEUIL_AFFICHAGE
  );
  const ecartees = etat.anomalies
    .filter((a) => !gardees.includes(a))
    .map((a) => a.docId);
  return {
    anomalies: gardees,
    journal: trace("revision", { gardees: gardees.length, ecartees }),
  };
}

async function redaction(etat: EtatGraphe) {
  const anomalies = await Promise.all(
    etat.anomalies.map((a) => expliquer(a, etat.avecModele))
  );
  return {
    anomalies,
    journal: trace("redaction", {
      actions_redigees: anomalies.length,
      par_modele: anomalies.filter((a) => a.actionSource !== "modele_par_defaut").length,
    }),
  };
}

async function synthese(etat: EtatGraphe) {
  const traitees = etat.pieces.filter((p) => p.statut === "traite").length;
  const texte = etat.avecModele
    ? await synthetiser({
        piecesTotal: etat.pieces.length,
        piecesTraitees: traitees,
        piecesNonTraitees: etat.pieces.length - traitees,
        tauxRapprochement: etat.rapprochement?.tauxRapprochement ?? 0,
        expositionTotaleMad: etat.expositionTotale,
        totalResteDu: etat.rapprochement?.totalResteDu.toFixed(2) ?? "0.00",
        anomalies: etat.anomalies,
      })
    : null;
  return {
    synthese: texte,
    journal: trace("synthese", { redigee: Boolean(texte) }),
  };
}

// -------------------------------------------------------------------- graphe

export function construireGraphe() {
  return new StateGraph(Etat)
    .addNode("lecture", lecture)
    .addNode("escalade_illisibles", escaladeIllisibles)
    .addNode("rapprochement_bancaire", rapprochement)
    .addNode("controles", controles)
    .addNode("chiffrage", chiffrage)
    .addNode("revision", revision)
    .addNode("redaction", redaction)
    .addNode("note_de_synthese", synthese)
    .addEdge(START, "lecture")
    .addEdge("lecture", "escalade_illisibles")
    .addEdge("escalade_illisibles", "rapprochement_bancaire")
    .addEdge("rapprochement_bancaire", "controles")
    .addEdge("controles", "chiffrage")
    .addEdge("chiffrage", "revision")
    .addEdge("revision", "redaction")
    .addEdge("redaction", "note_de_synthese")
    .addEdge("note_de_synthese", END);
}

let compile: ReturnType<ReturnType<typeof construireGraphe>["compile"]> | null = null;

/** Le checkpointer Postgres rend les reprises possibles apres un echec. */
export async function graphe() {
  if (compile) return compile;
  let checkpointer;
  try {
    const postgres = PostgresSaver.fromConnString(
      process.env.DATABASE_URL ?? "postgres://chiffra:chiffra@postgres:5432/chiffra"
    );
    await postgres.setup();
    checkpointer = postgres;
  } catch {
    // Sans Postgres, le graphe tourne mais ne sait plus reprendre apres un
    // echec. On le dit dans le journal plutot que de refuser de demarrer.
    checkpointer = new MemorySaver();
  }
  compile = construireGraphe().compile({ checkpointer });
  return compile;
}

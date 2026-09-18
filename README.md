# Chiffra — le contrôle comptable avant le fisc

Sujet 03 du hackathon ESISA × Numeos Technology. Le cabinet dépose un lot de
pièces hétérogènes ; Chiffra les lit, les rapproche des relevés bancaires,
applique le référentiel fiscal et rend un rapport **trié par exposition en
dirhams**, chaque ligne remontant à la pièce d'origine.

## Le problème

Un collaborateur ouvre 400 factures par mois et les rapproche à la main. Il rate
des doublons, des TVA mal appliquées, des pièces hors exercice. Chaque anomalie
manquée est un redressement possible — et elle est chiffrable. Chiffra ne
remplace pas le comptable : il lui présente ce qui coûte cher, avec le montant
et la règle qui le fonde, pour qu'il arbitre au lieu de saisir.

## La frontière qui structure tout le projet

**Le modèle ne calcule jamais un montant.** Totaux, TVA, écarts de
rapprochement, exposition : tout est calculé en Python avec `Decimal`
(`app/money.py`), quantifié à deux décimales, arrondi `ROUND_HALF_UP`. Les
fichiers `reconcile.py` et `audit.py` ne contiennent aucun appel réseau — c'est
vérifiable en deux secondes :

```bash
grep -rn "openai\|appeler(\|llm" api/src/money.ts api/src/reconcile.ts api/src/audit.ts
# aucun résultat
```

Le modèle intervient à trois endroits, et à trois endroits seulement :

| Où | Modèle | Ce qu'il fait |
|---|---|---|
| `vision.lireModele` | gpt-4.1 (vision) | **Lit** une pièce que le code n'a pas su lire. Consigne explicite : recopier, ne rien déduire, `null` pour tout champ absent. |
| `explain.expliquer` | gpt-4.1 | Rédige l'action à mener. Reçoit les montants **déjà calculés**. |
| `explain.synthetiser` | gpt-5.5 | Une note de cinq lignes sur le dossier. Seul appel au modèle de raisonnement. |

Tout ce que le modèle produit est ensuite revérifié par le code. Une pièce lue
par le modèle n'est acceptée que si trois conditions tiennent : `HT + TVA = TTC`,
la TVA correspond au taux porté sur le document, et le TTC reste dans l'ordre de
grandeur historique du fournisseur. Ce troisième contrôle n'est pas théorique :
sur le corpus, un scan dégradé d'ENERGIE PLUS a été lu à 457 000 MAD alors que
ce fournisseur facture 8 238 MAD en moyenne. Le code l'a refusé et l'a renvoyé
en file humaine, avec le motif affiché. Le contrôle s'applique à toute lecture
faite sur une image — OCR comme modèle — et jamais à la couche texte d'un PDF,
qui est exacte.

L'exposition totale retient, par pièce, la plus forte anomalie et non la somme :
une facture sans ICE et au montant aberrant met en jeu une seule TVA, pas deux.

## Architecture

```
dépôt du lot
   │
   ├── Ingestor       app/ingest.py      escalade à quatre niveaux
   │                                     couche texte PDF → OCR → export Excel
   │                                     du cabinet → lecture par le modèle
   │                                     → sinon « non traité » avec motif
   │
   ├── Reconciler     app/reconcile.py   3 passes : montant exact, paiement
   │                                     groupé (jusqu'à 5 pièces), paiement
   │                                     partiel. Salaires, frais bancaires et
   │                                     règlements clients écartés d'office.
   │
   ├── Auditor        app/audit.py       8 familles d'anomalies, chacune
   │                                     rattachée à une règle du référentiel
   │                                     et chiffrée en dirhams
   │
   ├── Explainer      app/explain.py     l'anomalie devient une action ;
   │                                     repli sans modèle prévu
   │
   └── Orchestrator   app/orchestrator.py graphe explicite, checkpoint en base
                                          à chaque étape, escalade des échecs
```

Le graphe : `lecture → escalade_illisibles → rapprochement → controles →
chiffrage → revision → redaction → synthese`. Chaque étape écrit son état dans
la table `checkpoint` (visible dans l'interface, section « Déroulé de l'agent »,
ou via `GET /api/journal`). L'étape `revision` est la boucle de révision : elle
relit les anomalies produites, applique les arbitrages déjà rendus par le
comptable et écarte le bruit avant de déranger un humain.

## Lancer le projet

```bash
cp .env.example .env      # y mettre les clés fournies par Numeos
docker compose up --build
```

Cinq services démarrent : `postgres`, `redis`, `api`, `worker` et `web`.
Ouvrez **http://localhost:5173**. L'API reste accessible sur le port 8000 pour
inspecter une réponse directement.

Sans clé, tout fonctionne quand même : le bouton « Contrôler sans le modèle »
exécute la chaîne complète en code pur. C'est volontaire — le produit ne doit
pas s'arrêter parce qu'un endpoint est indisponible pendant la démonstration.

Les tests, sans rien démarrer d'autre :

```bash
cd api
npm install
npm run build
DATA_DIR=../data node --test dist/*.test.js   # 24 tests
```

En local, sans Docker :

```powershell
python -m venv .venv
.venv\Scripts\activate          # Windows ; sur Linux : source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.api:app --port 8000
pytest -q                        # 17 tests (version Python historique)
```

Pour l'interface, dans un second terminal :

```powershell
cd web
npm install
npm run dev                      # http://localhost:5173, /api est relayé vers le port 8000
```

Aucun binaire système n'est requis. `pdftotext` et `tesseract` sont utilisés
s'ils sont présents, sinon l'Ingestor bascule seul : la couche texte des PDF
est lue par `pypdfium2`, et les pièces scannées passent directement au niveau
suivant de l'escalade, la lecture par le modèle. Le taux de lecture en code pur
passe alors de 88,8 % à 86 %, et les tests passent dans les deux cas.

## Résultats sur le corpus fourni

Chiffres obtenus en code pur, sans aucun appel au modèle :

| Mesure | Valeur |
|---|---|
| Pièces lues | 95 sur 107 (88,8 %) |
| dont par la couche texte des PDF | 89 — gratuit, exact, instantané |
| dont par OCR ou par l'export du cabinet | 6 |
| Pièces laissées à la main | 12, chacune avec son motif |
| Rapprochement bancaire | 67,7 % (63 factures sur 93 rapprochables) |
| Lignes bancaires écartées (règle 12) | 21 |
| Exposition chiffrée | 9 523,87 MAD sur 10 anomalies chiffrées |

Le taux de rapprochement est affiché tel quel. Les 14 lignes bancaires non
soldées sont listées avec leur résiduel calculé par le code : plusieurs d'entre
elles sont des virements « REGROUPEMENT » dont une des pièces est illisible, et
le système préfère l'admettre plutôt que d'imputer un montant au hasard.

## Ce que le jury a annoncé vouloir tester

| Scénario | Comportement | Test |
|---|---|---|
| Doublon parfait | signalé, confiance 1.0, jamais fusionné | `test_doublon_exact_detecte` |
| Quasi-doublon, date décalée | signalé à 0,75 de confiance, les deux numéros affichés | `test_doublon_probable_signale_sans_fusion` |
| TVA au mauvais taux | redressement calculé par le code, comparé au taux de la catégorie | `test_tva_au_mauvais_taux_chiffree_par_le_code` |
| Paiement groupé | affecté aux pièces couvertes ; résiduel calculé, jamais estimé | `test_le_residuel_bancaire_est_calcule_par_le_code` |
| Photo illisible | statut « non traité », motif affiché, aucun montant retenu | `test_une_piece_illisible_ne_produit_aucun_montant` |
| Facture normale | laissée tranquille | `test_une_facture_normale_est_laissee_tranquille` |
| Taux réduit légitime (7 % denrées) | non signalé | `test_un_taux_reduit_legitime_n_est_pas_signale` |

## Les exigences, une par une

- **EX-01** 107 pièces ingérées, dont 8 scans sans couche texte et 10 photos.
- **EX-02** tiers, date, HT, TVA, TTC, numéro de pièce, ICE, taux.
- **EX-03** taux de rapprochement affiché ; le non-rapproché est listé.
- **EX-04** 8 familles : doublon exact, doublon probable, TVA au mauvais taux,
  TVA incohérente avec la base, pièce hors exercice, tiers absent du
  référentiel, montant aberrant, ICE manquant.
- **EX-05** rapport trié par exposition décroissante, l'identifiant ouvre le
  fichier source (`GET /api/document/{doc_id}`).
- **EX-06** boutons « Retenir » et « Rejeter » ; chaque rejet abaisse de 0,25 la
  confiance des cas identiques chez le même tiers, et au troisième rejet le
  motif n'est plus proposé. Les décisions sont persistées et rechargées au
  contrôle suivant.
- **EX-07** tous les calculs en `Decimal`, dans `money.py`, `reconcile.py`,
  `audit.py`.
- **EX-08** statut « non traité » avec motif ; les valeurs entrevues sont
  rangées dans `lecture_partielle` et ne servent à aucun calcul.

## La stack

| Couche | Technologie | Où |
|---|---|---|
| Interface | React 18, TypeScript, Vite, servie par nginx | `web/` |
| API et agents | Node 20, TypeScript, Fastify | `api/src/` |
| Orchestration | LangGraph, checkpointer Postgres | `api/src/graph.ts` |
| Base de données | PostgreSQL 16, montants en `numeric` | `api/src/db.ts` |
| Cache et file | Redis 7, BullMQ | `api/src/queue.ts`, `api/src/worker.ts` |
| Arithmétique | decimal.js | `api/src/money.ts` |
| Exécution | Docker Compose, cinq services | `docker-compose.yml` |

Le graphe déclare huit nœuds : `lecture`, `escalade_illisibles`,
`rapprochement_bancaire`, `controles`, `chiffrage`, `revision`, `redaction`,
`note_de_synthese`. Chacun écrit son état dans le journal, et le checkpointer
Postgres persiste la progression, ce qui rend les reprises possibles.

L'ingestion des 107 pièces passe par la file BullMQ : le worker est un service
séparé, l'OCR de chaque document est mis en cache dans Redis, et les appels au
modèle le sont aussi. Si Redis ou Postgres ne répondent pas, le contrôle tourne
quand même en mode dégradé plutôt que de refuser de démarrer.

## Une version Python existe aussi

Le dossier `app/` contient une première implémentation complète en Python, avec
ses propres tests. Elle a servi à valider les règles métier avant le portage.
Elle reste dans le dépôt sous l'étiquette `v1-python` et n'est plus le chemin
d'exécution.

## Choix de stack, assumé

La stack recommandée par le cahier des charges est suivie intégralement :
React 18 et TypeScript en Vite pour l'interface, Node 20 et Fastify pour l'API
et les agents, LangGraph pour l'orchestration, PostgreSQL 16 comme source de
vérité, Redis 7 pour le cache et la file, decimal.js pour l'arithmétique,
Docker Compose pour l'exécution.

Un seul langage du front aux agents, et le typage sert de contrat entre eux :
`web/src/types.ts` décrit ce que l'API renvoie, et `api/src/rapport.ts` ce
qu'elle produit. Si un agent change sa sortie, la compilation échoue.

Ce qui était demandé à la stack est conservé : l'orchestration reste un graphe
explicite avec des états et des checkpoints persistés, le cache des appels au
modèle existe (sur disque, `data/cache`), et `docker compose up` démarre le
projet sur une machine vierge.

## Limites connues

- Le rapprochement plafonne à 67,7 %. Les groupes incluant une pièce illisible
  ne sont pas résolus : leur résiduel est affiché, pas deviné.
- L'OCR tourne en local avec tesseract. Les trois photos les plus dégradées ne
  passent pas et sortent en « non traité ».
- La règle du montant aberrant (dix fois la moyenne) ne se déclenche pas sur ce
  corpus : la plus grosse facture reste sous le seuil. Le contrôle est
  implémenté et testé, il n'a simplement rien à signaler ici.
- Pas d'authentification ni de multi-dossiers : hors périmètre du sujet.

## Structure

```
app/money.py         Decimal, lecture de montants, contrôles de cohérence
app/referentiel.py   fournisseurs, plan comptable, période, règle 12
app/ingest.py        Ingestor
app/reconcile.py     Reconciler
app/audit.py         Auditor
app/explain.py       Explainer
app/llm.py           accès aux deux modèles, cache disque
app/orchestrator.py  le graphe
app/db.py            SQLite : exécutions, checkpoints, décisions humaines
app/api.py           API et service de l'interface
app/static/index.html interface de secours, servie par l'API seule
web/src/types.ts     contrat de données entre les agents et l'interface
web/src/App.tsx      interface React : exposition, arbitrage, traçabilité
web/Dockerfile       compilation Vite puis service par nginx
tests/               les scénarios du jury
```

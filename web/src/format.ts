/** Mise en forme des montants. Aucun calcul ici : l'API envoie des chaines
 *  produites par le code Python en Decimal, on se contente de les afficher. */

const dirhams = new Intl.NumberFormat("fr-MA", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const mad = (valeur: string | number | null): string =>
  valeur === null ? "—" : dirhams.format(Number(valeur));

export const pourcent = (valeur: number): string =>
  `${valeur.toLocaleString("fr-MA", { maximumFractionDigits: 1 })} %`;

export function dateLisible(iso: string | null): string {
  if (!iso) return "date illisible";
  const [annee, mois, jour] = iso.slice(0, 10).split("-");
  return `${jour}/${mois}/${annee}`;
}

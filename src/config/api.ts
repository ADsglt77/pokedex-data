/**
 * La forme des réponses de l'API (`contract.ts`). À augmenter avec elle, et la même dans le site
 * (son `API_FORMAT`, qui range les copies de son service worker dans un nouveau cache) : l'ETag des
 * réponses calculées à la demande change (`snapshots.ts`), un client ne garde jamais une réponse
 * d'une ancienne forme. 2 : les prix rendent une clé par carte demandée, `null` sans prix
 * (octobre 2026). 3 : le prix d'une carte suit la règle de Pokécardex, et son troisième nombre est
 * son prix d'il y a 30 jours (octobre 2026).
 */
export const API_FORMAT = 3

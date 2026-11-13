/**
 * `/v1/wants` : la ligne d'une carte pour la liste de souhaits Cardmarket (« Ajouter une deck
 * list »). Elle doit nommer l'extension Cardmarket de la carte, en anglais, et aucune source
 * convenue ne donne ce nom depuis le retrait de Pokécardex (13 novembre 2026, `docs/donnees.md`,
 * « Liste de souhaits ») : une ligne sans lui, ou avec un nom deviné, pourrait acheter une autre
 * carte. Chaque carte demandée a donc `null`, même quand son produit et sa carte sont connus ; le
 * site propose alors de l'ajouter depuis sa page Cardmarket.
 */

import { describe, expect, test } from 'vitest'
import { app } from '../app'
import { run } from './helpers'

const wants = (ids: string) => app.request(`/v1/wants?ids=${ids}`)

describe('/v1/wants', () => {
  test('aucune ligne : `null` pour chaque carte demandée, même connue du catalogue et des produits', async () => {
    await run(
      'DELETE FROM cardmarket_products',
      'DELETE FROM catalog_cards',
      `INSERT INTO cardmarket_products (id, name, expansion, metacard)
       VALUES (719621, 'Charmander [Blazing Destruction | Steady Firebreathing]', 5011, 77)`,
      `INSERT INTO catalog_cards (lang, set_id, number, cardmarket, released)
       VALUES ('ja', 'SV2a', '168', 719621, '2023-06-16')`,
    )
    const response = await wants('719621,1,719621')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(await response.json()).toEqual({ '719621': null, '1': null })
  })

  test('des ids mal écrits : 422', async () => {
    for (const ids of ['', '0', '01', 'a', '1,,2', '1234567890']) {
      expect((await wants(ids)).status).toBe(422)
    }
  })
})

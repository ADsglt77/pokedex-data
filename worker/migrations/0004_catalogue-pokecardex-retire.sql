-- Le catalogue de Pokécardex retiré (décision du propriétaire, 13 novembre 2026 : le catalogue vient
-- désormais de TCGdex, par l'importateur, et son miroir est `catalog_cards`, migration suivante).
-- Écrite par Drizzle, vérifiée à la main : les tables qui en référencent d'autres d'abord
-- (`card_species` → `cards` → `sets`), sans couper les clés étrangères (rien n'est reconstruit) ;
-- les prix et leur historique (`cardmarket_*`), `sources` et `runs` restent tels quels. Le passage
-- noté de la reprise de l'historique (`sources` : `history`), qui n'existe plus, est retiré.
DROP TABLE `card_species`;--> statement-breakpoint
DROP TABLE `cards`;--> statement-breakpoint
DROP TABLE `history_imports`;--> statement-breakpoint
DROP TABLE `rarities`;--> statement-breakpoint
DROP TABLE `sets`;--> statement-breakpoint
DELETE FROM `sources` WHERE `name` = 'history';

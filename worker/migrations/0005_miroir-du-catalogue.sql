CREATE TABLE `catalog_cards` (
	`lang` text NOT NULL,
	`set_id` text NOT NULL,
	`number` text NOT NULL,
	`cardmarket` integer NOT NULL,
	`released` text NOT NULL,
	PRIMARY KEY(`lang`, `set_id`, `number`)
);
--> statement-breakpoint
CREATE INDEX `catalog_cards_by_released` ON `catalog_cards` (`released`);
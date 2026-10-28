CREATE TABLE `card_species` (
	`lang` text NOT NULL,
	`card` integer NOT NULL,
	`rank` integer NOT NULL,
	`dex_id` integer NOT NULL,
	PRIMARY KEY(`lang`, `card`, `rank`),
	FOREIGN KEY (`lang`,`card`) REFERENCES `cards`(`lang`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `cardmarket_history` (
	`id` integer NOT NULL,
	`year` integer NOT NULL,
	`first` integer NOT NULL,
	`prices` text NOT NULL,
	PRIMARY KEY(`id`, `year`)
);
--> statement-breakpoint
CREATE TABLE `cardmarket_prices` (
	`id` integer PRIMARY KEY NOT NULL,
	`price` real NOT NULL,
	`low` real,
	`month_ago` real
);
--> statement-breakpoint
CREATE TABLE `cardmarket_products` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`expansion` integer,
	`metacard` integer
);
--> statement-breakpoint
CREATE INDEX `cardmarket_products_by_card` ON `cardmarket_products` (`expansion`,`metacard`);--> statement-breakpoint
CREATE TABLE `cards` (
	`lang` text NOT NULL,
	`id` integer NOT NULL,
	`set_id` text NOT NULL,
	`number` text NOT NULL,
	`sort` integer NOT NULL,
	`name` text NOT NULL,
	`cardmarket` integer NOT NULL,
	`seen` text NOT NULL,
	`image` text,
	`image_checked` text,
	`rarity` integer,
	`type` integer,
	`printed` text DEFAULT '' NOT NULL,
	`name_en` text DEFAULT '' NOT NULL,
	`name_de` text DEFAULT '' NOT NULL,
	`illustrator` text DEFAULT '' NOT NULL,
	`versions` text DEFAULT '[]' NOT NULL,
	PRIMARY KEY(`lang`, `id`),
	FOREIGN KEY (`lang`,`set_id`) REFERENCES `sets`(`lang`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cards_by_set` ON `cards` (`lang`,`set_id`);--> statement-breakpoint
CREATE INDEX `cards_by_cardmarket` ON `cards` (`cardmarket`);--> statement-breakpoint
CREATE TABLE `history_imports` (
	`lang` text NOT NULL,
	`card` integer NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`lang`, `card`)
);
--> statement-breakpoint
CREATE TABLE `rarities` (
	`lang` text NOT NULL,
	`id` integer NOT NULL,
	`name` text NOT NULL,
	`rank` integer NOT NULL,
	PRIMARY KEY(`lang`, `id`)
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`ok` integer,
	`message` text,
	`alive_at` text
);
--> statement-breakpoint
CREATE INDEX `runs_by_job` ON `runs` (`job`,`id`);--> statement-breakpoint
CREATE TABLE `sets` (
	`lang` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`released` text NOT NULL,
	`read_at` text NOT NULL,
	`logo` text,
	`logo_checked` text,
	`block` text,
	`block_rank` integer,
	`deck` integer DEFAULT 0 NOT NULL,
	`expansion_name` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`lang`, `id`)
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`name` text PRIMARY KEY NOT NULL,
	`stamp` text NOT NULL,
	`date` text NOT NULL
);

DROP INDEX `cards_by_set`;--> statement-breakpoint
CREATE INDEX `cards_by_set` ON `cards` (`lang`,`set_id`,`sort`);--> statement-breakpoint
CREATE INDEX `runs_open` ON `runs` (`job`) WHERE finished_at IS NULL;
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config_enc` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`events` text NOT NULL,
	`cluster_ids` text,
	`node_ids` text,
	`title_template` text,
	`body_template` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_error` text,
	`delivered_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deliveries_status_idx` ON `deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `deliveries_event_idx` ON `deliveries` (`event_id`);--> statement-breakpoint
CREATE TABLE `delivery_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`delivery_id` integer NOT NULL,
	`attempt` integer NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`duration_ms` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE cascade
);

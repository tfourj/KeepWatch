CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`public_key` text NOT NULL,
	`seal_key` text NOT NULL,
	`version` text,
	`os` text,
	`arch` text,
	`hostname` text,
	`interfaces` text,
	`connected` integer DEFAULT false NOT NULL,
	`last_seen_at` integer,
	`enrolled_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`auto_update` integer DEFAULT true NOT NULL,
	`update_status` text,
	`latest_version` text,
	`last_update_error` text,
	`update_checked_at` integer,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_nodeId_unique` ON `agents` (`node_id`);--> statement-breakpoint
CREATE TABLE `clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `commands` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`sent_at` integer,
	`acked_at` integer,
	`expires_at` integer NOT NULL,
	`error` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `commands_agent_status_idx` ON `commands` (`agent_id`,`status`);--> statement-breakpoint
CREATE TABLE `enrollment_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enrollment_tokens_tokenHash_unique` ON `enrollment_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cluster_id` text,
	`config_mode` text,
	`online` integer DEFAULT false NOT NULL,
	`last_seen_at` integer,
	`status` text,
	`problems` text,
	`applied_spec_hash` text,
	`applied_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`cluster_id`) REFERENCES `clusters`(`id`) ON UPDATE no action ON DELETE set null
);

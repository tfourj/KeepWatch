CREATE TABLE `checks` (
	`id` text PRIMARY KEY NOT NULL,
	`cluster_id` text NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`params` text NOT NULL,
	`interval_sec` integer DEFAULT 2 NOT NULL,
	`timeout_sec` integer DEFAULT 2 NOT NULL,
	`fall` integer DEFAULT 2 NOT NULL,
	`rise` integer DEFAULT 2 NOT NULL,
	`weight` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`cluster_id`) REFERENCES `clusters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `config_rollout_nodes` (
	`rollout_id` text NOT NULL,
	`node_id` text NOT NULL,
	`position` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`command_id` text,
	`hash` text,
	`error` text,
	`output` text,
	`started_at` integer,
	`finished_at` integer,
	PRIMARY KEY(`rollout_id`, `node_id`),
	FOREIGN KEY (`rollout_id`) REFERENCES `config_rollouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `config_rollouts` (
	`id` text PRIMARY KEY NOT NULL,
	`cluster_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`error` text,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`cluster_id`) REFERENCES `clusters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `instance_checks` (
	`instance_id` text NOT NULL,
	`check_id` text NOT NULL,
	PRIMARY KEY(`instance_id`, `check_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `vrrp_instances`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`check_id`) REFERENCES `checks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `instance_members` (
	`instance_id` text NOT NULL,
	`node_id` text NOT NULL,
	`priority` integer NOT NULL,
	`interface` text,
	`initial_state` text DEFAULT 'BACKUP' NOT NULL,
	`state` text,
	`reported_priority` integer,
	`state_since` integer,
	`maintenance` integer DEFAULT false NOT NULL,
	`holds_vips` integer DEFAULT false NOT NULL,
	`reported_at` integer,
	PRIMARY KEY(`instance_id`, `node_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `vrrp_instances`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `state_transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` text NOT NULL,
	`node_id` text NOT NULL,
	`from_state` text,
	`to_state` text NOT NULL,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `vrrp_instances`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `state_transitions_instance_at_idx` ON `state_transitions` (`instance_id`,`at`);--> statement-breakpoint
CREATE INDEX `state_transitions_at_idx` ON `state_transitions` (`at`);--> statement-breakpoint
CREATE TABLE `vrrp_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`cluster_id` text NOT NULL,
	`name` text NOT NULL,
	`vrid` integer NOT NULL,
	`vrrp_version` integer DEFAULT 3 NOT NULL,
	`interface` text NOT NULL,
	`advert_int` integer DEFAULT 1 NOT NULL,
	`preempt` integer DEFAULT true NOT NULL,
	`preempt_delay` integer DEFAULT 0 NOT NULL,
	`unicast` integer DEFAULT true NOT NULL,
	`auth_pass_enc` text,
	`virtual_ips` text NOT NULL,
	`master_node_id` text,
	`master_since` integer,
	`split_brain_since` integer,
	`split_brain_notified` integer DEFAULT false NOT NULL,
	`no_master_since` integer,
	`no_master_notified` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`cluster_id`) REFERENCES `clusters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `vrrp_instances_cluster_idx` ON `vrrp_instances` (`cluster_id`);
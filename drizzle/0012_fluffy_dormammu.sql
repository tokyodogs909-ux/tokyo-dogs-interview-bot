CREATE TABLE `interview_drive_hierarchy_nodes` (
	`node_key` text PRIMARY KEY NOT NULL,
	`canonical_folder_id` text,
	`creation_attempted_at` text,
	`lease_token` text,
	`lease_expires_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `interview_drive_hierarchy_nodes_lease_idx` ON `interview_drive_hierarchy_nodes` (`lease_expires_at`);
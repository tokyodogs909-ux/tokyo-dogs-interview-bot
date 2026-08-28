CREATE TABLE `interview_operational_alerts` (
	`session_id` text PRIMARY KEY NOT NULL,
	`alert_type` text NOT NULL,
	`severity` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`code` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interview_operational_alerts_status_idx` ON `interview_operational_alerts` (`status`,`severity`,`last_seen_at`);--> statement-breakpoint
ALTER TABLE `interview_external_syncs` ADD `failure_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `interview_external_syncs` ADD `next_retry_at` text;--> statement-breakpoint
ALTER TABLE `interview_external_syncs` ADD `retry_blocked_at` text;--> statement-breakpoint
ALTER TABLE `interview_external_syncs` ADD `retry_block_reason` text;--> statement-breakpoint
CREATE INDEX `interview_external_syncs_retry_idx` ON `interview_external_syncs` (`status`,`next_retry_at`,`retry_blocked_at`);
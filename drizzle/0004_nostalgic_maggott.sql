CREATE TABLE `interview_external_syncs` (
	`session_id` text NOT NULL,
	`provider` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`folder_id` text,
	`folder_url` text,
	`manifest_json` text,
	`error_code` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interview_external_syncs_session_provider_unique` ON `interview_external_syncs` (`session_id`,`provider`);--> statement-breakpoint
CREATE INDEX `interview_external_syncs_status_idx` ON `interview_external_syncs` (`status`);
CREATE TABLE `interview_drive_upload_steps` (
	`session_id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`phase` text DEFAULT 'uploading' NOT NULL,
	`upload_url_ciphertext` text NOT NULL,
	`upload_url_iv` text NOT NULL,
	`committed_offset` integer DEFAULT 0 NOT NULL,
	`total_bytes` integer NOT NULL,
	`content_type` text NOT NULL,
	`recording_name` text NOT NULL,
	`folder_id` text NOT NULL,
	`folder_url` text NOT NULL,
	`context_json` text NOT NULL,
	`recording_file_json` text,
	`lease_token` text,
	`lease_expires_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interview_drive_upload_steps_lease_idx` ON `interview_drive_upload_steps` (`lease_expires_at`);
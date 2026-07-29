CREATE TABLE `interview_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`etag` text,
	`retention_until` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interview_artifacts_object_key_unique` ON `interview_artifacts` (`object_key`);--> statement-breakpoint
CREATE INDEX `interview_artifacts_session_idx` ON `interview_artifacts` (`session_id`);--> statement-breakpoint
CREATE INDEX `interview_artifacts_retention_idx` ON `interview_artifacts` (`retention_until`);--> statement-breakpoint
CREATE TABLE `interview_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor_type` text NOT NULL,
	`detail_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interview_audit_events_session_idx` ON `interview_audit_events` (`session_id`);--> statement-breakpoint
CREATE TABLE `interview_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`access_token_hash` text NOT NULL,
	`employment` text NOT NULL,
	`preferred_location` text NOT NULL,
	`consent_version` text NOT NULL,
	`consented_at` text NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`recording_status` text DEFAULT 'not_started' NOT NULL,
	`transcript_json` text,
	`evaluation_json` text,
	`summary` text,
	`expires_at` text NOT NULL,
	`retention_until` text NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `interview_sessions_status_idx` ON `interview_sessions` (`status`);--> statement-breakpoint
CREATE INDEX `interview_sessions_retention_idx` ON `interview_sessions` (`retention_until`);
CREATE TABLE `recorded_answer_transcriptions` (
	`session_id` text NOT NULL,
	`answer_index` integer NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`audio_sha256` text NOT NULL,
	`etag` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`transcript_text` text,
	`claim_id` text,
	`claimed_at` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`next_retry_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`session_id`, `answer_index`),
	FOREIGN KEY (`session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recorded_answer_transcriptions_object_key_unique` ON `recorded_answer_transcriptions` (`object_key`);--> statement-breakpoint
CREATE INDEX `recorded_answer_transcriptions_status_idx` ON `recorded_answer_transcriptions` (`session_id`,`status`,`answer_index`);
CREATE TABLE `recorded_interview_completions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`expected_answer_count` integer NOT NULL,
	`requested_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recorded_interview_completions_requested_idx` ON `recorded_interview_completions` (`requested_at`);
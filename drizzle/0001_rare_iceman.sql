CREATE TABLE `interview_human_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`reviewer_name` text NOT NULL,
	`video_scores_json` text NOT NULL,
	`overall_note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interview_human_reviews_session_idx` ON `interview_human_reviews` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `interview_human_reviews_session_reviewer_unique` ON `interview_human_reviews` (`session_id`,`reviewer_name`);
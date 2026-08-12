CREATE TABLE `interview_evaluation_claims` (
	`session_id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`started_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interview_evaluation_claims_started_idx` ON `interview_evaluation_claims` (`started_at`);

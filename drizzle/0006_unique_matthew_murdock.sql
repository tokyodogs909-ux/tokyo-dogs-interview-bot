CREATE TABLE `interview_public_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`source_hash` text NOT NULL,
	`candidate_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `interview_public_entries_source_idx` ON `interview_public_entries` (`source_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `interview_public_entries_candidate_idx` ON `interview_public_entries` (`candidate_hash`,`created_at`);
CREATE TABLE `interview_session_replacements` (
	`source_session_id` text PRIMARY KEY NOT NULL,
	`replacement_session_id` text NOT NULL,
	`replacement_mode` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`source_session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`replacement_session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interview_session_replacements_replacement_unique` ON `interview_session_replacements` (`replacement_session_id`);
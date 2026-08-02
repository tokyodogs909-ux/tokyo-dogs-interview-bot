CREATE TABLE `interview_staff_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`reviewer_name` text NOT NULL,
	`event_type` text NOT NULL,
	`detail_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `interview_staff_audit_events_created_idx` ON `interview_staff_audit_events` (`created_at`);

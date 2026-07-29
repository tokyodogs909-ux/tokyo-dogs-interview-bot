CREATE TABLE `interview_invites` (
	`nonce_hash` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`session_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `interview_invites_expiry_idx` ON `interview_invites` (`expires_at`);
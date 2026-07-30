CREATE TABLE `google_drive_connection` (
	`id` integer PRIMARY KEY NOT NULL,
	`refresh_token_ciphertext` text NOT NULL,
	`refresh_token_iv` text NOT NULL,
	`root_folder_id` text,
	`root_folder_name` text,
	`root_folder_url` text,
	`scope` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

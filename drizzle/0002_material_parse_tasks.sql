CREATE TABLE `material_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`course_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`locator` text NOT NULL,
	`locator_kind` text NOT NULL,
	`locator_value` integer DEFAULT 0 NOT NULL,
	`heading` text DEFAULT '' NOT NULL,
	`text` text NOT NULL,
	`char_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `material_blocks_task_ordinal_idx` ON `material_blocks` (`task_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `material_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`course_id` text NOT NULL,
	`knowledge_point_id` text DEFAULT '' NOT NULL,
	`prompt` text NOT NULL,
	`options` text NOT NULL,
	`correct_index` integer NOT NULL,
	`explanation` text DEFAULT '' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`locator_kind` text DEFAULT '' NOT NULL,
	`locator_value` integer DEFAULT 0 NOT NULL,
	`origin` text NOT NULL,
	`status` text NOT NULL,
	`edited` integer DEFAULT 0 NOT NULL,
	`question_id` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `material_candidates_task_status_idx` ON `material_candidates` (`user_id`,`task_id`,`status`);--> statement-breakpoint
CREATE TABLE `material_knowledge_points` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`course_id` text NOT NULL,
	`label` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`origin` text NOT NULL,
	`locator` text DEFAULT '' NOT NULL,
	`locator_kind` text DEFAULT '' NOT NULL,
	`locator_value` integer DEFAULT 0 NOT NULL,
	`source_block_id` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `material_knowledge_points_task_status_idx` ON `material_knowledge_points` (`user_id`,`task_id`,`status`);--> statement-breakpoint
CREATE TABLE `material_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`material_id` text NOT NULL,
	`course_id` text NOT NULL,
	`parse_status` text NOT NULL,
	`parse_engine` text DEFAULT '' NOT NULL,
	`parse_error` text DEFAULT '' NOT NULL,
	`parse_attempts` integer DEFAULT 0 NOT NULL,
	`parse_cursor` integer DEFAULT 0 NOT NULL,
	`generate_status` text NOT NULL,
	`generate_engine` text DEFAULT '' NOT NULL,
	`generate_error` text DEFAULT '' NOT NULL,
	`generate_attempts` integer DEFAULT 0 NOT NULL,
	`generate_cursor` integer DEFAULT 0 NOT NULL,
	`source_sha256` text DEFAULT '' NOT NULL,
	`byte_size` integer DEFAULT 0 NOT NULL,
	`page_count` integer DEFAULT 0 NOT NULL,
	`block_count` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT 0 NOT NULL,
	`lease_until` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `material_tasks_user_material_idx` ON `material_tasks` (`user_id`,`material_id`,`created_at`);
CREATE TABLE `ban_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`oracle_id` text NOT NULL,
	`action` text NOT NULL,
	`note` text NOT NULL,
	`by` text NOT NULL,
	`at` text NOT NULL,
	`applied_after_game_id` text
);
--> statement-breakpoint
CREATE TABLE `ban_list` (
	`run_id` text NOT NULL,
	`oracle_id` text NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`run_id`, `oracle_id`)
);
--> statement-breakpoint
CREATE TABLE `card_scripts` (
	`oracle_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`parser_version` integer NOT NULL,
	`status` text NOT NULL,
	`reasons` text NOT NULL,
	`script` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `card_stats` (
	`run_id` text NOT NULL,
	`cycle_id` text NOT NULL,
	`agent` text NOT NULL,
	`oracle_id` text NOT NULL,
	`zone` text NOT NULL,
	`opponent_deck_gen` text NOT NULL,
	`games` integer NOT NULL,
	`games_drawn` integer NOT NULL,
	`wins_drawn` integer NOT NULL,
	`games_not_drawn` integer NOT NULL,
	`wins_not_drawn` integer NOT NULL,
	`cast_games` integer NOT NULL,
	`dead_in_hand` integer NOT NULL,
	`sum_turn_cast` integer NOT NULL,
	`first_casts` integer NOT NULL,
	`sum_impact` real NOT NULL,
	`impacts` integer NOT NULL,
	`mulligan_blame` integer NOT NULL,
	PRIMARY KEY(`run_id`, `cycle_id`, `agent`, `oracle_id`, `zone`, `opponent_deck_gen`)
);
--> statement-breakpoint
CREATE INDEX `card_stats_run` ON `card_stats` (`run_id`,`agent`,`oracle_id`);--> statement-breakpoint
CREATE TABLE `cards` (
	`oracle_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`mana_cost` text,
	`mana_value` real NOT NULL,
	`colors` text NOT NULL,
	`color_identity` text NOT NULL,
	`type_line` text NOT NULL,
	`oracle_text` text NOT NULL,
	`power` text,
	`toughness` text,
	`loyalty` text,
	`keywords` text NOT NULL,
	`layout` text NOT NULL,
	`legal_base` integer NOT NULL,
	`preferred_printing_id` text,
	`image_uri` text,
	`scryfall_updated_at` text
);
--> statement-breakpoint
CREATE TABLE `cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`number` integer NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`deck_gen_a` integer,
	`deck_gen_b` integer,
	`matches_planned` integer NOT NULL,
	`matches_done` integer NOT NULL,
	`win_rate_a` real,
	`win_rate_b` real,
	`tiebreak` integer,
	`loser` text,
	`summary` text
);
--> statement-breakpoint
CREATE INDEX `cycles_run` ON `cycles` (`run_id`,`number`);--> statement-breakpoint
CREATE TABLE `deck_generations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`agent` text NOT NULL,
	`generation` integer NOT NULL,
	`cycle` integer NOT NULL,
	`cause` text NOT NULL,
	`main` text NOT NULL,
	`side` text NOT NULL,
	`change` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deck_generations_run` ON `deck_generations` (`run_id`,`agent`,`generation`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`number` integer NOT NULL,
	`seed` text NOT NULL,
	`chooser` text NOT NULL,
	`on_play` text NOT NULL,
	`winner` text,
	`reason` text,
	`turns` integer,
	`decisions` integer NOT NULL,
	`duration_ms` integer,
	`event_log` blob,
	`log_encoding` text
);
--> statement-breakpoint
CREATE INDEX `games_match` ON `games` (`match_id`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`cycle_id` text NOT NULL,
	`number` integer NOT NULL,
	`kind` text NOT NULL,
	`trial_candidate` text,
	`winner` text,
	`games_a` integer NOT NULL,
	`games_b` integer NOT NULL,
	`sideboarding` text NOT NULL,
	`detail` blob NOT NULL,
	`detail_encoding` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `matches_cycle` ON `matches` (`cycle_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`seed` text NOT NULL,
	`settings` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`forked_from_run` text,
	`forked_from_cycle` integer,
	`current_cycle` integer
);
--> statement-breakpoint
CREATE TABLE `unsupported_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`oracle_id` text NOT NULL,
	`run_id` text,
	`context` text,
	`reason` text NOT NULL,
	`requested_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `unsupported_requests_oracle_id` ON `unsupported_requests` (`oracle_id`);
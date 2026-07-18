CREATE TABLE IF NOT EXISTS "patients" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"age" integer,
	"start_weight_kg" real,
	"current_weight_kg" real,
	"goal_weight_kg" real,
	"next_appointment" date,
	"user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patients_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "protocol_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"protocol_id" integer NOT NULL,
	"treatment_id" integer,
	"title" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"frequency" text DEFAULT 'daily' NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "protocols" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"duration_weeks" integer DEFAULT 4 NOT NULL,
	"is_preset" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "treatments" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"protocol_id" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"treatment_id" integer NOT NULL,
	"task_id" integer NOT NULL,
	"log_date" date NOT NULL,
	"note" text,
	"photo_data" text,
	"value_number" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insights" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"summary" text NOT NULL,
	"observed_factors" text DEFAULT '' NOT NULL,
	"suggested_action" text NOT NULL,
	"risk_level" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"patient_name" text NOT NULL,
	"message" text NOT NULL,
	"risk_level" text DEFAULT 'high' NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "protocol_tasks" ADD CONSTRAINT "protocol_tasks_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "treatments" ADD CONSTRAINT "treatments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "treatments" ADD CONSTRAINT "treatments_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_treatment_id_treatments_id_fk" FOREIGN KEY ("treatment_id") REFERENCES "public"."treatments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_task_id_protocol_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."protocol_tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "insights" ADD CONSTRAINT "insights_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "alerts" ADD CONSTRAINT "alerts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "sessions" USING btree ("expire");

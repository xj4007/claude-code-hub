ALTER TABLE "providers" ADD COLUMN "use_unified_client_id" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "unified_client_id" varchar(64);
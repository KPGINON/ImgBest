-- DropIndex
DROP INDEX "email_login_codes_email_created_at_idx";

-- AlterTable
ALTER TABLE "email_login_codes" ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'login';

-- CreateIndex
CREATE INDEX "email_login_codes_email_purpose_created_at_idx" ON "email_login_codes"("email", "purpose", "created_at");

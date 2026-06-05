/*
  Warnings:

  - A unique constraint covering the columns `[email]` on the table `accounts` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "email" TEXT;

-- CreateTable
CREATE TABLE "email_login_codes" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_login_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_login_codes_email_created_at_idx" ON "email_login_codes"("email", "created_at");

-- CreateIndex
CREATE INDEX "email_login_codes_email_expires_at_idx" ON "email_login_codes"("email", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts"("email");

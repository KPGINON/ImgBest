-- CreateTable
CREATE TABLE "accounts" (
    "client_id" TEXT NOT NULL,
    "invite_code" TEXT NOT NULL,
    "referred_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("client_id")
);

-- CreateTable
CREATE TABLE "entitlements" (
    "client_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("client_id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "client_id" TEXT,
    "workflow" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "prompt" TEXT,
    "payload_json" JSONB NOT NULL,
    "response_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "original_name" TEXT,
    "mime_type" TEXT,
    "file_path" TEXT NOT NULL,
    "public_url" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "amount_units" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "reference_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_invite_code_key" ON "accounts"("invite_code");

-- CreateIndex
CREATE UNIQUE INDEX "entitlements_payment_id_key" ON "entitlements"("payment_id");

-- CreateIndex
CREATE INDEX "payments_client_id_created_at_idx" ON "payments"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "tasks_client_id_created_at_idx" ON "tasks"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "assets_task_id_created_at_idx" ON "assets"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "credit_ledger_client_id_created_at_idx" ON "credit_ledger"("client_id", "created_at");

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "accounts"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "accounts"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "accounts"("client_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "accounts"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

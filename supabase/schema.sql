-- =============================================
-- 我行我诉 - 会员系统数据库初始化
-- 在 Supabase SQL Editor 中执行以下 SQL
-- =============================================

-- 1. 用户表
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  is_vip BOOLEAN NOT NULL DEFAULT FALSE,
  vip_expires_at TIMESTAMPTZ,
  total_paid NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_is_vip ON users(is_vip);

-- 2. 付款记录表
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  payee_name TEXT,
  transaction_id TEXT,
  merchant_order_id TEXT,
  ocr_raw_text TEXT,
  screenshot_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / approved / rejected
  reject_reason TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_user_email ON payments(user_email);
CREATE INDEX IF NOT EXISTS idx_payments_transaction_id ON payments(transaction_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- 3. 案例草稿表（已有的，这里确保存在）
CREATE TABLE IF NOT EXISTS woxingwosu_case_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  draft JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_case_drafts_email ON woxingwosu_case_drafts(user_email);

-- 4. 开启行级安全（可选，这里先关闭，因为后端用 service_role）
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE woxingwosu_case_drafts DISABLE ROW LEVEL SECURITY;

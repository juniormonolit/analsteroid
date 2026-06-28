CREATE TABLE IF NOT EXISTS plan_settings (
  id INT PRIMARY KEY DEFAULT 1,
  plan_n NUMERIC NOT NULL DEFAULT 0.8,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO plan_settings (id, plan_n) VALUES (1, 0.8) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS manager_plans (
  manager_login TEXT NOT NULL,
  month DATE NOT NULL,
  plan_shipments NUMERIC NOT NULL,
  plan_n NUMERIC NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (manager_login, month)
);

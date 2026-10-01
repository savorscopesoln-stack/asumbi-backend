-- Adds Finance invoicing + payment receipts (per-tenant DB).
-- Mirrors utils/ensureSchema.js, which creates these tables automatically on
-- boot; this file exists for running the change manually / in review.
--   finance_invoices : invoice raised against an institution for N credits
--   finance_receipts : one receipt per confirmed payment (idempotent)
-- Additive only; nothing existing is altered.

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='finance_invoices' AND xtype='U')
CREATE TABLE finance_invoices (
  id INT IDENTITY(1,1) PRIMARY KEY,
  invoice_number NVARCHAR(40) NULL,
  credit_quantity INT NOT NULL,
  unit_price DECIMAL(18,2) NOT NULL,
  currency NVARCHAR(3) NOT NULL DEFAULT 'KES',
  subtotal DECIMAL(18,2) NOT NULL,
  tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  tax_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(18,2) NOT NULL,
  status NVARCHAR(20) NOT NULL DEFAULT 'issued',
  issue_date DATETIME NOT NULL DEFAULT GETDATE(),
  due_date DATE NULL,
  notes NVARCHAR(500) NULL,
  bill_to_name NVARCHAR(200) NULL,
  bill_to_email NVARCHAR(200) NULL,
  bill_to_phone NVARCHAR(50) NULL,
  institution_payment_id INT NULL,
  paid_at DATETIME NULL,
  voided_at DATETIME NULL,
  void_reason NVARCHAR(500) NULL,
  issued_by INT NULL,
  createdAt DATETIME NOT NULL DEFAULT GETDATE(),
  CONSTRAINT CK_finance_invoices_quantity CHECK (credit_quantity > 0),
  CONSTRAINT CK_finance_invoices_amounts CHECK (unit_price > 0 AND total_amount > 0),
  CONSTRAINT CK_finance_invoices_status CHECK (status IN ('issued','paid','void')),
  CONSTRAINT FK_finance_invoices_payment FOREIGN KEY (institution_payment_id)
    REFERENCES institution_payments(id)
);

IF NOT EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = N'UQ_finance_invoices_number' AND object_id = Object_ID(N'finance_invoices')
)
CREATE UNIQUE NONCLUSTERED INDEX UQ_finance_invoices_number
ON finance_invoices(invoice_number) WHERE invoice_number IS NOT NULL;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='finance_receipts' AND xtype='U')
CREATE TABLE finance_receipts (
  id INT IDENTITY(1,1) PRIMARY KEY,
  receipt_number NVARCHAR(40) NULL,
  institution_payment_id INT NOT NULL,
  invoice_id INT NULL,
  amount DECIMAL(18,2) NOT NULL,
  currency NVARCHAR(3) NOT NULL DEFAULT 'KES',
  payment_reference NVARCHAR(80) NOT NULL,
  payment_method NVARCHAR(50) NULL,
  received_from NVARCHAR(200) NULL,
  issued_by INT NULL,
  issued_at DATETIME NOT NULL DEFAULT GETDATE(),
  createdAt DATETIME NOT NULL DEFAULT GETDATE(),
  CONSTRAINT FK_finance_receipts_payment FOREIGN KEY (institution_payment_id)
    REFERENCES institution_payments(id),
  CONSTRAINT FK_finance_receipts_invoice FOREIGN KEY (invoice_id)
    REFERENCES finance_invoices(id)
);

IF NOT EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = N'UQ_finance_receipts_payment' AND object_id = Object_ID(N'finance_receipts')
)
CREATE UNIQUE NONCLUSTERED INDEX UQ_finance_receipts_payment
ON finance_receipts(institution_payment_id);

IF NOT EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = N'UQ_finance_receipts_number' AND object_id = Object_ID(N'finance_receipts')
)
CREATE UNIQUE NONCLUSTERED INDEX UQ_finance_receipts_number
ON finance_receipts(receipt_number) WHERE receipt_number IS NOT NULL;


-- Private provisioning of canonical Agent identity/profile membership must be
-- attributable to an owner review. There is deliberately no public write route.
ALTER TABLE agent_telegram_bindings ADD COLUMN reviewer_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_telegram_bindings ADD COLUMN receipt_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_telegram_bindings ADD COLUMN reviewed_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_profile_memberships ADD COLUMN reviewer_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profile_memberships ADD COLUMN receipt_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profile_memberships ADD COLUMN reviewed_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE agent_profile_authority_audit (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('telegram_binding', 'profile_membership')),
  action TEXT NOT NULL CHECK (action IN ('insert', 'update')),
  bot_id TEXT,
  telegram_user_id TEXT,
  principal_id TEXT NOT NULL,
  profile_id TEXT,
  reviewer_ref TEXT NOT NULL,
  receipt_ref TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE TRIGGER agent_telegram_binding_review_required_insert
BEFORE INSERT ON agent_telegram_bindings
WHEN trim(NEW.reviewer_ref) = '' OR trim(NEW.receipt_ref) = '' OR NEW.reviewed_at <= 0
BEGIN
  SELECT RAISE(ABORT, 'agent identity binding requires review provenance');
END;
CREATE TRIGGER agent_telegram_binding_review_required_update
BEFORE UPDATE ON agent_telegram_bindings
WHEN trim(NEW.reviewer_ref) = '' OR trim(NEW.receipt_ref) = '' OR NEW.reviewed_at <= 0
BEGIN
  SELECT RAISE(ABORT, 'agent identity binding requires review provenance');
END;
CREATE TRIGGER agent_profile_membership_review_required_insert
BEFORE INSERT ON agent_profile_memberships
WHEN trim(NEW.reviewer_ref) = '' OR trim(NEW.receipt_ref) = '' OR NEW.reviewed_at <= 0
BEGIN
  SELECT RAISE(ABORT, 'agent profile membership requires review provenance');
END;
CREATE TRIGGER agent_profile_membership_review_required_update
BEFORE UPDATE ON agent_profile_memberships
WHEN trim(NEW.reviewer_ref) = '' OR trim(NEW.receipt_ref) = '' OR NEW.reviewed_at <= 0
BEGIN
  SELECT RAISE(ABORT, 'agent profile membership requires review provenance');
END;

CREATE TRIGGER agent_telegram_binding_audit_insert
AFTER INSERT ON agent_telegram_bindings
BEGIN
  INSERT INTO agent_profile_authority_audit
    (subject_kind,action,bot_id,telegram_user_id,principal_id,reviewer_ref,receipt_ref,recorded_at)
  VALUES ('telegram_binding','insert',NEW.bot_id,NEW.telegram_user_id,NEW.principal_id,
    NEW.reviewer_ref,NEW.receipt_ref,NEW.reviewed_at);
END;
CREATE TRIGGER agent_telegram_binding_audit_update
AFTER UPDATE ON agent_telegram_bindings
BEGIN
  INSERT INTO agent_profile_authority_audit
    (subject_kind,action,bot_id,telegram_user_id,principal_id,reviewer_ref,receipt_ref,recorded_at)
  VALUES ('telegram_binding','update',NEW.bot_id,NEW.telegram_user_id,NEW.principal_id,
    NEW.reviewer_ref,NEW.receipt_ref,NEW.reviewed_at);
END;
CREATE TRIGGER agent_profile_membership_audit_insert
AFTER INSERT ON agent_profile_memberships
BEGIN
  INSERT INTO agent_profile_authority_audit
    (subject_kind,action,principal_id,profile_id,reviewer_ref,receipt_ref,recorded_at)
  VALUES ('profile_membership','insert',NEW.principal_id,NEW.profile_id,
    NEW.reviewer_ref,NEW.receipt_ref,NEW.reviewed_at);
END;
CREATE TRIGGER agent_profile_membership_audit_update
AFTER UPDATE ON agent_profile_memberships
BEGIN
  INSERT INTO agent_profile_authority_audit
    (subject_kind,action,principal_id,profile_id,reviewer_ref,receipt_ref,recorded_at)
  VALUES ('profile_membership','update',NEW.principal_id,NEW.profile_id,
    NEW.reviewer_ref,NEW.receipt_ref,NEW.reviewed_at);
END;

CREATE TRIGGER agent_profile_authority_audit_no_update
BEFORE UPDATE ON agent_profile_authority_audit
BEGIN
  SELECT RAISE(ABORT, 'agent profile authority audit is append-only');
END;
CREATE TRIGGER agent_profile_authority_audit_no_delete
BEFORE DELETE ON agent_profile_authority_audit
BEGIN
  SELECT RAISE(ABORT, 'agent profile authority audit is append-only');
END;

-- Retain disabled rows as revocation tombstones; every revocation is an audited
-- UPDATE carrying reviewer and private receipt references.
CREATE TRIGGER agent_telegram_binding_no_delete
BEFORE DELETE ON agent_telegram_bindings
BEGIN
  SELECT RAISE(ABORT, 'disable Agent identity binding instead of deleting it');
END;
CREATE TRIGGER agent_profile_membership_no_delete
BEFORE DELETE ON agent_profile_memberships
BEGIN
  SELECT RAISE(ABORT, 'disable Agent profile membership instead of deleting it');
END;

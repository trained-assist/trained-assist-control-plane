-- The Telegram login work was private and never provisioned for production.
-- Canonical actor/profile state is now owned by agent_profile_authority_v1;
-- Connected App memberships remain app-specific grants and are not migrated.
DROP TRIGGER IF EXISTS connected_app_telegram_binding_changed;
DROP TRIGGER IF EXISTS connected_app_telegram_binding_removed;
DROP TRIGGER IF EXISTS connected_app_browser_membership_changed;
DROP TRIGGER IF EXISTS connected_app_browser_membership_removed;
DROP TABLE IF EXISTS connected_app_telegram_bindings;
DROP TABLE IF EXISTS connected_app_telegram_challenges;
DROP TABLE IF EXISTS connected_app_browser_sessions;

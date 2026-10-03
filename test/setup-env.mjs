// Tests that exercise reporting supply their own config and mock transport.
// General bridge/extension fixtures must never send to the production default.
process.env.PI_WEB_SENTRY_ENABLED = "false";

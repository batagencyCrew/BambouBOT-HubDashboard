-- Long-lived credentials for trusted services (the Discord/Telegram bot process).
-- A service token authenticates the *service*; every request it makes on behalf
-- of a chat user must also name that user, whose own permissions are enforced.

CREATE TABLE service_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            text NOT NULL CHECK (kind IN ('bot')),
    label           text NOT NULL DEFAULT '',
    token_hash      text NOT NULL UNIQUE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id),
    revoked_at      timestamptz,
    last_used_at    timestamptz
);

-- One-time codes a dashboard user generates and types into a bot to link accounts.
CREATE TABLE bot_link_codes (
    code_hash       text PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Which hub command names each script registered (for custom commands and
-- for the UI to show what the script supports).
CREATE TABLE site_capabilities (
    site_id         uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
    commands        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{name, description, args_schema}]
    files           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{path, format}]
    sdk             text NOT NULL DEFAULT '',
    updated_at      timestamptz NOT NULL DEFAULT now()
);

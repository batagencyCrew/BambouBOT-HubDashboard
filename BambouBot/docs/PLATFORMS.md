# Using the bots: Discord and Telegram

Both bots offer the same operations through the same service layer
(`src/services/`), so limits, validation and results are identical. The two
platforms differ only in how input is collected and how private data is delivered.

| | Discord | Telegram |
|---|---|---|
| Commands | Slash commands with autocomplete | `/command args`, `key=value` or `key:value` options |
| Forms | Modals (a **Continue** button bridges step 1 → step 2) | Reply-based questions; `/skip`, `/back`, `/cancel` |
| Pickers | Autocomplete (presets, keys, platforms) | Paginated inline buttons |
| Confirmation | Buttons (key revoke, GMS delete) | Buttons |
| `bbk_` secret | DM to the creator, ephemeral fallback when DMs are closed | DM to the creator only (checked before creating) |
| Long replies | Split into several messages | Split into several messages |
| Identity | Discord user id | Numeric Telegram user id (`/whoami`) |

All other replies are **public** in the channel or group, by design.

## Permissions

Each platform has its own owner (`DISCORD_OWNER_ID` / `TELEGRAM_OWNER_ID`) with every
permission. Other users start with none. The permissions are:

- `presets`: `/preset …`
- `keys`: `/key …`
- `gms`: `/gms …`

Only a platform's owner can use `/access`. Grants are **per platform**: approving
Discord user `42` gives nothing to Telegram user `42`. Both platforms share one
file (`ACCESS_FILE`, default `data/access.json`). Adding an existing user replaces
their permissions.

```text
Discord : /access add user:@someone permissions:presets + keys label:BIPRO
Telegram: /access add 222222222 presets+keys label="BIPRO"
          /access add 333333333 all
          /access remove 222222222
          /access list
```

On both platforms a permission is checked again when a button is clicked or a
form is submitted. Removing a user's access takes effect immediately, even
in the middle of a form.

## Presets

```text
/preset list [page]
/preset setup source:<preset> [specific_platform] [specific_label]   # duplicate + configure
/preset edit  preset:<preset> [specific_platform] [specific_label]   # edit in place
```

The form collects the name, ID, first name, discovery platform, MYM URL and an extra
URL. It suggests the current values and a free 4-digit ID.

- Nothing is saved until the last step: the Discord step-2 modal, or the Telegram
  **Save preset** button. The save is **one** config write.
- If you leave an optional field blank, the source value is kept. Other preset
  modules and unrelated URLs are preserved.
- Preset IDs may use letters, digits, `-` and `_` (1–64 characters). An ID already
  in use is refused at the ID step. URLs must be complete `http(s)://` URLs.
- `specific_platform` accepts any of the 29 dashboard platforms; Discord
  autocompletes them.
- Renaming an ID with `edit` moves account and Snapchat model references and
  re-points active API-key scopes. Media records that the API cannot move are
  reported.
- On Discord, an invalid value shows a **Fix** button that reopens the modal with
  what you typed.

Telegram also accepts every value inline. Only the missing fields are asked:

```text
/preset setup 1000 name="Nina" id=7777 first_name=Nina discovery_platform=Telegram mym_url=https://… specific_url=https://… specific_platform=Telegram specific_label=Contact
```

## API keys

```text
/key list
/key create label [rpm] [concurrent] [daily] [scope]
/key edit key_id [label] [rpm] [concurrent] [daily] [scope] [paused]
/key delete key_id          # confirmation button; revocation is final
```

Limits are the same on both platforms:

- `rpm` 1–600
- `concurrent` 1–8
- `daily` 1–100000
- label at most 60 characters

Defaults are 20/min, 2 concurrent, 1000/day and every preset. `scope` is `all`, or
up to 100 existing preset IDs separated by commas. Invalid input never creates a key.

**Delivering the secret.** A key's `bbk_` secret is shown once, so it is only ever sent
privately:

- **Discord:** the secret is DM'd. If DMs are closed, it is sent as an ephemeral
  reply instead. If neither works, the new key is **revoked** and the reply says so.
- **Telegram:** the creator must have opened the bot's private chat (`/start`).
  This is checked **before** the key is created. If delivery still fails, the key is
  revoked, or its ID is reported for manual cleanup.

Secrets never appear in public replies, audit logs or the access file.

## GetMySocial (`/gms`)

`/gms` needs `GMS_COOKIE` (see [GETTING_COOKIE.md](GETTING_COOKIE.md)) and optionally
`GMS_TEAM_ID`. It is loaded lazily, so presets and keys work without it.

```text
/gms list [query] [limit]
/gms create [profile] [name] [shortcode]   # a form asks for whatever is missing
/gms info|enable|disable <link>            # shortcode, link id or full URL
/gms delete <link> [confirm]               # confirmation button unless confirm=true
/gms stats [link] [period]                 # today, yesterday, week, lastweek, month, lastmonth, all
/gms refresh
```

Destinations are the fixed profiles **Lina / Louise / Mia**, defined in
`src/services/gms.js`. New links are direct links and are not grouped.
Shortcodes may use letters, digits, `-` and `_`. If you leave the shortcode empty,
GetMySocial generates one.

## Troubleshooting

- **Forms expire after 10 minutes.** Sessions are kept in memory and lost on
  restart; approvals persist. A Telegram form is tied to its user, chat and forum
  topic. A Discord form is tied to its user.
- **Telegram 409 Conflict:** another process is polling the same token. Stop
  the old `bambou-telegram` service first. Only one poller per token is allowed.
- **Telegram webhook:** an existing webhook is never removed silently, and the
  Telegram bot stops with a message saying so. The Discord bot keeps running.
  To switch the token to polling (pending updates are preserved):

  ```bash
  node -e 'const {loadConfig}=require("./src/config");const {TelegramClient}=require("./src/platforms/telegram/client");new TelegramClient({token:loadConfig({only:["telegram"]}).telegram.token}).call("deleteWebhook",{drop_pending_updates:false}).then(()=>console.log("Webhook removed"),e=>{console.error(e.message);process.exitCode=1})'
  ```

- **Discord commands not showing:** global registration can take up to an hour.
  Set `DISCORD_GUILD_ID` to register in one server instantly.
- **Telegram groups:** privacy mode can stay on, because the bot only reads
  commands, button presses and replies to its own messages. With several bots in a
  group, address commands as `/skip@YourBotName`.
- **Config edits:** a preset save is a read-modify-write of the whole studio
  config. Within this process, saves are serialised across both platforms. Avoid
  saving presets from the dashboard at the same moment.

# Proxy entry and file import

Manual entry uses a **Proxy type** dropdown (`HTTP`, `HTTPS`, `SOCKS5`), a **Host:port** field containing only a hostname/IP and port, and optional separate username/password fields. IPv6 addresses must be bracketed: `[2001:db8::1]:1080`. A protocol, path, query, fragment, or credentials do not belong in the Host:port field.

## Text files

Import UTF-8 text files (`.txt` or `.list`), one proxy per line:

```text
# Comments and blank lines are ignored
proxy.example.com:8080
proxy.example.com:8080:username:password
username:password@proxy.example.com:8080
socks5://username:password@proxy.example.com:1080
https://proxy.example.com:8443
[2001:db8::1]:1080
```

Select the default proxy type for lines without a protocol. An explicit `http://`, `https://`, or `socks5://` on a file line overrides that default. URL-style credentials may be percent-encoded. The colon-separated format treats everything after the username separator as the password, allowing colons in passwords. Use URL-style percent encoding for credentials containing `@`.

Preview reports invalid line numbers, duplicate entries, and the number of new proxies before importing. Passwords are never returned in a preview. Duplicate identity is normalized protocol/host/port plus username/password; duplicates already stored or repeated in the same file are skipped. Invalid lines reject the entire import; fix the file and preview again. Imports are atomic and respect the site's 1,000-proxy limit. Files are limited to 512 KiB and 1,000 nonblank/noncomment entries. The hub stores proxy credentials encrypted and never connects to imported proxies.

## API contract

Admin-only `POST /api/sites/{id}/proxies/import`:

```json
{"content":"proxy.example.com:8080\n", "proxy_type":"http", "dry_run":true}
```

`proxy_type` is `http`, `https`, or `socks5`, default `http`; `dry_run` defaults to `true`.

Response:

```json
{
  "total": 1,
  "valid": 1,
  "duplicates": 0,
  "imported": 0,
  "can_import": true,
  "errors": [],
  "entries": [{"line":1,"url":"http://proxy.example.com:8080","username":"","has_password":false,"duplicate":false}]
}
```

`valid` counts unique valid new entries, excluding duplicates; `total` counts noncomment/nonblank lines including invalid entries. Errors are sanitized `{line:number,message:string}` objects, never the original input. File-level/capacity errors may use line `0`. If errors exist, nothing is inserted, including for `dry_run:false`. Import with the same content/type and `dry_run:false` only after a successful preview. The server revalidates duplicates and capacity inside the write transaction. A successful import sets `imported` to the count inserted and `can_import` to `false` (the file is now already imported).

Restart existing workers after proxy changes so the sample supervisor refreshes their environment.

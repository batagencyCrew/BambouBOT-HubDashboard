"""Private local configuration mirror; enrollment is guarded by hub revision."""
import json
import os
from pathlib import Path
import stat
import tempfile
from urllib.parse import quote, urlsplit, urlunsplit


class HubError(RuntimeError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"Hub returned HTTP {status}")


class LocalFiles:
    def __init__(self, directory="./runtime"):
        self.directory = Path(directory).absolute()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.directory.is_symlink() or not self.directory.is_dir():
            raise ValueError("Invalid runtime directory")
        self.directory.chmod(0o700)

    def read_optional(self, name):
        try:
            fd = os.open(self.directory / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return None
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError("Invalid local configuration file")
            # Do not accept unlimited files or emit their contents in errors.
            content = stream.read(2 * 1024 * 1024 + 1)
            if len(content) > 2 * 1024 * 1024:
                raise ValueError("Local configuration too large")
            return content

    @staticmethod
    def revision(config):
        value = config.get("revision")
        if type(value) is not int or value < 0:
            raise ValueError("Invalid configuration revision")
        return value

    def initialized(self):
        raw = self.read_optional(".sync.json")
        if raw is None:
            return False
        try:
            checkpoint = json.loads(raw)
            self.revision(checkpoint)
            if checkpoint.get("initialized") is not True:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise ValueError("Invalid local synchronization checkpoint") from None
        return True

    def import_data(self):
        data = {}
        raw = self.read_optional("config.json")
        if raw is not None:
            try:
                config = json.loads(raw)
                if not isinstance(config, dict):
                    raise ValueError()
                safe = {key: config[key] for key in ("ai_api_key", "number_of_workers", "ai_preset_id") if key in config}
                for key, value in safe.items():
                    if key == "number_of_workers":
                        if type(value) is not int or not 0 <= value <= 100:
                            raise ValueError()
                    elif not isinstance(value, str):
                        raise ValueError()
                data["config"] = safe
            except (ValueError, TypeError):
                raise ValueError("Invalid local configuration; files preserved") from None
        proxies = self.read_optional("proxies.txt")
        if proxies is not None:
            # Preserve raw input: the hub validates the entire import atomically.
            data["proxies_content"] = proxies
        return data

    def atomic_write(self, name, content):
        fd, temporary = tempfile.mkstemp(prefix=".sync-", dir=self.directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.directory / name)
            directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def publish(self, config):
        revision = self.revision(config)
        safe = {"ai_api_key": config.get("ai_api_key") or "",
                "number_of_workers": config["number_of_workers"],
                "ai_preset_id": config.get("ai_preset_id") or "", "revision": revision}
        lines = []
        for proxy in config.get("proxies", []):
            parsed = urlsplit(proxy["url"])
            if not parsed.hostname or not parsed.scheme:
                raise ValueError("Invalid hub proxy configuration")
            host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
            if parsed.port is not None:
                host += f":{parsed.port}"
            username, password = proxy.get("username"), proxy.get("password")
            if username or password:
                host = quote(username or "", safe="") + ":" + quote(password or "", safe="") + "@" + host
            lines.append(urlunsplit((parsed.scheme, host, "", "", "")))
        config_text = json.dumps(safe, indent=2) + "\n"
        self.atomic_write("config.json", config_text)
        self.atomic_write("proxies.txt", "\n".join(lines) + ("\n" if lines else ""))
        # LAST: a failed enrollment/publication can never mark itself complete.
        self.atomic_write(".sync.json", json.dumps({"initialized": True, "revision": revision}) + "\n")

    def fetch(self, request):
        config = request("GET", "/config")
        revision = self.revision(config)
        if not self.initialized():
            data = {} if config.get("local_sync_initialized") else self.import_data()
            try:
                config = request("POST", "/local-sync", json={"expected_revision": revision, **data})
            except HubError as exc:
                if exc.status != 409:
                    raise
                latest = request("GET", "/config")
                config = request("POST", "/local-sync", json={"expected_revision": self.revision(latest)})
        self.publish(config)
        return config

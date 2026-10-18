import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Check,
  KeyRound,
  LoaderCircle,
  Save,
  ShieldCheck,
  Trash2,
  Undo2,
} from "lucide-react";
import { api, errorMessage, json } from "./api";
import type { AIPreset, Config, PresetsResponse, Site } from "./types";
import { dateTime, ErrorBanner } from "./ui";

type SecretState = { value: string; clear: boolean };
const untouched = (): SecretState => ({ value: "", clear: false });

function SecretField({
  label,
  configured,
  state,
  onChange,
}: {
  label: string;
  configured: boolean;
  state: SecretState;
  onChange: (value: SecretState) => void;
}) {
  return (
    <div className="secret-field">
      <div className="secret-label">
        <span>{label}</span>
        <span className={`secret-status ${configured ? "configured" : ""}`}>
          <span className="status-dot" />
          {configured ? "Configured" : "Not configured"}
        </span>
      </div>
      <input
        aria-label={label}
        type="password"
        autoComplete="new-password"
        value={state.value}
        onChange={(event) =>
          onChange({ value: event.target.value, clear: false })
        }
        disabled={state.clear}
        placeholder={
          state.clear
            ? "Will be cleared when you save"
            : configured
              ? "Leave blank to keep existing key"
              : "Enter a new API key"
        }
      />
      <div className="secret-hint">
        <span>
          {state.clear
            ? "This key will be removed on save."
            : state.value
              ? "A new key will replace the existing value on save."
              : "Write-only. Existing keys are never returned."}
        </span>
        {state.clear ? (
          <button
            type="button"
            className="text-button"
            onClick={() => onChange(untouched())}
          >
            <Undo2 size={13} />
            Undo clear
          </button>
        ) : (
          configured && (
            <button
              type="button"
              className="text-button danger-text"
              onClick={() => onChange({ value: "", clear: true })}
            >
              <Trash2 size={13} />
              Clear key
            </button>
          )
        )}
      </div>
    </div>
  );
}

export default function Configuration({
  site,
  config,
  onSaved,
}: {
  site: Site;
  config: Config;
  onSaved: () => void;
}) {
  const [workers, setWorkers] = useState(String(config.number_of_workers));
  const [preset, setPreset] = useState(config.ai_preset_id || "default");
  const [ai, setAi] = useState<SecretState>(untouched);
  const [captcha, setCaptcha] = useState<SecretState>(untouched);
  const [savedConfig, setSavedConfig] = useState(config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [presets, setPresets] = useState<AIPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [presetsError, setPresetsError] = useState("");
  const presetsGeneration = useRef(0);
  const invalidAIKey = Boolean(ai.value && !ai.value.trim());
  const canLoadPresets = !ai.clear && !invalidAIKey && Boolean(ai.value || savedConfig.has_ai_api_key);
  const loadPresets = useCallback(async (key?: string) => {
    const generation = ++presetsGeneration.current;
    setPresetsLoading(true);
    setPresetsError("");
    try {
      const result = await api<PresetsResponse>(
        `/sites/${site.id}/presets`,
        json("POST", key ? { ai_api_key: key } : {}),
      );
      if (generation !== presetsGeneration.current) return;
      setPresets(result.presets);
      setPresetsLoaded(true);
    } catch (cause) {
      if (generation !== presetsGeneration.current) return;
      setPresetsError(errorMessage(cause));
    } finally {
      if (generation === presetsGeneration.current) setPresetsLoading(false);
    }
  }, [site.id]);
  // savedConfig only changes after a save, not on the parent's polling updates.
  useEffect(() => {
    setPresets([]);
    setPresetsLoaded(false);
    setPresetsError("");
    setPresetsLoading(false);
    if (savedConfig.has_ai_api_key) void loadPresets();
    return () => { presetsGeneration.current += 1; };
  }, [savedConfig, loadPresets]);
  const fallbackPresets = [...new Set([savedConfig.ai_preset_id, preset])]
    .filter((id) => id && !presets.some((item) => item.id === id));
  const dirty =
    workers !== String(savedConfig.number_of_workers) ||
    preset !== savedConfig.ai_preset_id ||
    Boolean(ai.value || ai.clear || captcha.value || captcha.clear);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaved(false);
    if (invalidAIKey || (captcha.value && !captcha.value.trim())) {
      setError("API keys cannot contain only whitespace. Leave the field empty to preserve its saved value.");
      return;
    }
    const count = Number(workers);
    if (
      !workers.trim() ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > 100
    ) {
      setError("Number of workers must be a whole number between 0 and 100.");
      return;
    }
    if (!preset.trim() || preset.trim().length > 200) {
      setError("AI preset ID is required and must be at most 200 characters.");
      return;
    }
    setBusy(true);
    const payload: {
      number_of_workers: number;
      ai_preset_id: string;
      ai_api_key?: string;
      captcha_api_key?: string;
    } = { number_of_workers: count, ai_preset_id: preset.trim() };
    if (ai.clear || ai.value) payload.ai_api_key = ai.clear ? "" : ai.value;
    if (captcha.clear || captcha.value)
      payload.captcha_api_key = captcha.clear ? "" : captcha.value;
    try {
      const result = await api<Config>(
        `/sites/${site.id}/config`,
        json("PUT", payload),
      );
      setSavedConfig(result);
      setWorkers(String(result.number_of_workers));
      setPreset(result.ai_preset_id);
      setAi(untouched());
      setCaptcha(untouched());
      setSaved(true);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="config-form">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <h3>Worker configuration</h3>
            <p>Set the desired worker count and AI behavior.</p>
          </div>
          <span className="panel-heading-icon">
            <Save size={19} />
          </span>
        </div>
        <fieldset disabled={busy} className="config-fields">
          <div className="form-grid">
            <label className="field">
              Number of workers
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                required
                value={workers}
                onChange={(event) => {
                  setWorkers(event.target.value);
                  setSaved(false);
                }}
              />
              <span className="field-hint">
                Desired worker count for this site’s agent (0–100).
              </span>
            </label>
            <div className="field">
              <label htmlFor="ai-preset">AI preset</label>
              <select
                id="ai-preset"
                aria-label="AI preset"
                aria-describedby="ai-preset-status"
                aria-busy={presetsLoading}
                required
                value={preset}
                onChange={(event) => {
                  setPreset(event.target.value);
                  setSaved(false);
                }}
              >
                {fallbackPresets.map((id) => (
                  <option key={id} value={id}>Current preset ({id})</option>
                ))}
                {presets.filter((item) => !item.archived).map((item) => (
                  <option key={item.id} value={item.id}>{item.name} ({item.id})</option>
                ))}
                {presets.some((item) => item.archived) && (
                  <optgroup label="Archived presets">
                    {presets.filter((item) => item.archived).map((item) => (
                      <option key={item.id} value={item.id} disabled={item.id !== preset && item.id !== savedConfig.ai_preset_id}>
                        {item.name} ({item.id})
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <span id="ai-preset-status" className="field-hint" role="status">
                {invalidAIKey
                  ? "AI API key cannot contain only whitespace. Leave it empty to use your stored key."
                  : !canLoadPresets
                  ? "Configure an AI API key, then load presets. Your current preset is preserved."
                  : presetsLoading
                    ? "Loading presets… Your current selection is preserved."
                    : presetsError
                      ? `Unable to load presets: ${presetsError} Your current selection is preserved.`
                      : presetsLoaded
                        ? presets.length ? "Choose a preset. Archived presets cannot be newly selected." : "No presets returned. Your current preset is preserved."
                        : "Load presets using the entered key before saving, or use your stored key."}
              </span>
              <div className="preset-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={!canLoadPresets || presetsLoading}
                  onClick={() => void loadPresets(ai.value || undefined)}
                >
                  {presetsLoading && <LoaderCircle size={14} className="spin" />}
                  {presetsLoaded ? "Refresh presets" : "Load presets"}
                </button>
                {presetsError && (
                  <button type="button" className="text-button" disabled={!canLoadPresets || presetsLoading}
                    onClick={() => void loadPresets(ai.value || undefined)}>
                    Retry
                  </button>
                )}
              </div>
            </div>
          </div>
        </fieldset>
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <h3>
              <KeyRound size={17} />
              API credentials
            </h3>
            <p>Encrypted at rest. Never exposed to the dashboard.</p>
          </div>
          <ShieldCheck size={20} />
        </div>
        <fieldset disabled={busy} className="config-fields">
          <SecretField
            label="AI API key"
            configured={savedConfig.has_ai_api_key}
            state={ai}
            onChange={(value) => {
              presetsGeneration.current += 1;
              setPresets([]);
              setPresetsLoaded(false);
              setPresetsLoading(false);
              setPresetsError("");
              setAi(value);
              setSaved(false);
            }}
          />
          <SecretField
            label="Captcha API key"
            configured={savedConfig.has_captcha_api_key}
            state={captcha}
            onChange={(value) => {
              setCaptcha(value);
              setSaved(false);
            }}
          />
        </fieldset>
        <div className="notice inline-notice">
          <ShieldCheck size={17} />
          <span>
            Blank fields preserve existing secrets. Use “Clear key” to
            explicitly remove a saved credential. Restart workers after changing
            API keys or the AI preset so the sample agent applies the new values.
            Updated VPS agents also mirror saved settings to config.json and the
            proxy pool to proxies.txt; local files refresh when the agent connects.
          </span>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="config-save">
        <span>
          {saved ? (
            <span className="success-text">
              <Check size={16} />
              Configuration saved. Agent will pick it up on its next config
              refresh.
            </span>
          ) : dirty ? (
            "You have unsaved changes."
          ) : (
            `Last updated ${dateTime(savedConfig.updated_at)}`
          )}
        </span>
        <button className="button primary" disabled={busy || !dirty}>
          {busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Save size={16} />
          )}
          Save configuration
        </button>
      </div>
    </form>
  );
}

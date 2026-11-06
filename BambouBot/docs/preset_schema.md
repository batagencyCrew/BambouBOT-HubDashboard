# BambouAI preset document — field inventory

Every field below was recovered from the dashboard bundle (`app.js`, md5 `617d54cc0548ffb806f87e49036ca5e2`)
by extracting the editor's data paths (`identity.name`, `urls.items.${i}.url`, …). The dashboard
writes these through `setAtPath()` (creates missing intermediate objects), and the server keeps
any extra fields it is sent — treat this as the working schema, not an exhaustive validation list.

Presets live inside the studio config document (`GET/PUT /api/studio/config`), `config.presets[]`.

Top level of a preset:

| key | notes |
|---|---|
| `id` | string. Dashboard generates random 4-digit ids (`"1048"`), but ids pre-existing can be anything (slug / `^[A-Za-z0-9_-]{1,64}$`) |
| `name` | display name |
| `group` | free-text label used for grouping in the list (dashboard-only, stored as-is) |
| `archivedAt` | ISO date when archived, `null` when active. Archived presets stay usable by API keys |
| `identity` | see below |
| `persona` | see below |
| `style` | see below |
| `strategy` | see below |
| `behavior` | see below |
| `mainSettings` | see below |
| `openers` | `{ enabled, forceOpener, items: [{id, title, messages:[str], mediaSource, specificMediaIds:[], enabled}] }` — opener messages are plain strings |
| `cycles` | `[{ id, name, smartPacing, phases:[{id, name, objective, exchanges, interestLevel, mediaProbability, mediaSource}] }]` — the flow the dashboard editor edits |
| `ctaScripts` | `[{ id, cycle, title, enabled, useDefaultUrl, messages:[{id, text, waitForReply, mediaSource}] }]` |
| `urls` | see URLs section below |
| `objections` | `[{id, trigger, response, sendCta, ctaTiming("both"\|"before_cta"\|"after_cta"), sendCtaAfter, stopAfterResponse, mediaSource, enabled}]` |
| `sprinkles` | `[{id, name, messages:[str], mediaSource, enabled}]` |
| `followups` | `{enabled, delayHours, maxCount, items:[{id, title, messages:[str], mediaSource, specificMediaIds:[], enabled}]}` |
| `finishers` | `{afterAllCycles, messageLimit, onMessageLimit, items:[{title, messages:[str], useDefaultUrl, mediaSource, enabled}]}` |
| `ignoreConditions` | `{avoidOlderEnabled, avoidOlderThan, behavioral:[{description,enabled}], lists:[{name,entries,enabled}]}` |
| `media` | `{vaultId, categories, folder, photoReply, sendOnRequest, avoidReuse, randomize}` |
| `phases` | **mirror section** — flat list of every phase from `cycles`, same phase ids, `interestTarget` as a number instead of the `interestLevel` enum: `[{id, name, objective, exchanges, interestTarget, mediaProbability}]` |
| `sequences` | **mirror section** — flat string-array versions of the message scripts: `{openers:[str], cta:[str], followups:[str], finishers:[str]}` |

> **Dual-generation document (live finding).** Every preset in the production space carries *both*
> generations of the flow structures: the older/editable ones (`cycles`, `openers`, `ctaScripts`,
> `followups`, `finishers`) that the dashboard bundle renders and writes, and the flat mirrors
> (`phases`, `sequences`) whose ids match the editable structures 1:1. The dashboard only ever
> edits the editable ones, so **edit those and let the server normalise on save** — treat
> `phases`/`sequences` as read-only derived data. `urls`, `strategy` and `identity`-family
> sections are single-source (no mirror).

`mediaSource` everywhere uses the same enum the dashboard exposes:
`none | primary | sexy | sad | happy | audio | specific`.

## identity

`name, age, gender, city, occupation, bio, interests, language`

## persona (French keys — stored verbatim)

- `identite`: `pays, ville, lieuDeVie, dateDeNaissance, tailleM, poidsKg, pointure, couleurDesCheveux, couleurDesYeux, tailleDePoitrine, descriptionPhysique, profession`
- `modeDeVie`: `animauxDeCompagnie, consommationDalcool, habitudeDeFumer, voiturePreferee, voyages`
- `preferences`: `couleurPreferee, couleurLaMoinsAimee, platsPreferes, platsLesMoinsAimes, filmsPreferes, livresPreferes, genresMusicauxPreferes, celebritesPreferees, personnagesPreferes, passions, religion`
- `relations`: `statutRelationnel, situationFamilialeEnfants, nombreDePartenairesSexuels, partenaireIdeal, rendezVousIdeal`

## style

`tone, vocabulary, emojiLevel, typoLevel, responseLength, maxBubbles, systemPrompt, forbiddenPhrases`

## strategy

`objective, ctaEnabled, ctaInstruction, ctaLink, ctaAfterExchanges, ctaMaxAttempts, conversionSignals, stopSignals`

> Note: `strategy.ctaLink` is the legacy single-URL field. The Links actually sent come from
> `urls.items[]` (see below) — the dashboard URL editor replaced it. Keep both consistent.

## behavior

`minDelaySeconds, maxDelaySeconds, antiRepeat, adaptToLocation, recentMessages, useConversationSummary, processUnreadOnly, imageEnabled, audioEnabled, videoEnabled`

## mainSettings

`primaryLanguage, additionalLanguages, frenchAbbreviations, detectLanguage, useAccountLocation, matchLocation, countryTierFilter, nightActivity, dayActivity, characterGender, filterFemales, appearance, chattingStyle, advancedChattingStyle, discoveryPlatform, typoPercent, multiAccountDelayDays, ignoreKnownTimewasters, selectMediaRandomly, aiVoiceNotes, ctaInfo`

## urls — the links the bots send (per preset!)

```
preset.urls = {
  chooseRandomly: bool,          // pick a random enabled URL at each CTA send
  items: [
    {
      id: "url-1",               // string id, only used by the dashboard editor
      platform: "Other",         // platform enum, see below; "snap" = auto Snapchat
      displayLabel: "…",         // label shown in the dashboard (live data uses things like "MYM", "sn&p", "👻")
      url: "https://…",          // first link sent as CTA — sent EXACTLY as stored
      snapModel: "",             // when platform==="snap": model setup id, handle resolved at send time
      spaceBeforeDotCom: false,  // inserts a space before ".com" to slip past chat-site link filters
      enabled: true
    }
  ],
  spacedLinkInstructions: [      // sent to explain a deliberately spaced link in `url`
    { id: "mqvfuwm03pwfnn6tjru", messages: ["try pastingg this link in your browser", "and then get rid of the space before the dot"] }
  ]
}
```

**Live usage pattern (production space).** Presets built for link-filtering sites store the link
*already* broken (`"getmysocial. com/lollyyylina"` with a manual space, `spaceBeforeDotCom: false`)
and pair it with a `spacedLinkInstructions` message ("…get rid of the space before the dot").
`spaceBeforeDotCom: true` is the automated variant of the same trick. The other evasion layer is
`config.extension.wordReplacements` — the live table rewrites words before sending:
`snap=>sn&p`, `snapchat=>sn&p`, `page=>paaage`, `insta=>lG`, `instagram=>lG`, `mym=>m#y#m`, …

Platform values accepted by the dashboard select (anything else still stores fine, but only
these get a dedicated label): `snap, OnlyFans, Phone Number, Telegram, Fansly, Chaturbate,
I Want Clips, Fanplace, Premium Snapchat, MYM, AVN Stars, Fanvue, 4Based, FetLife, Feet
Finder, Patreon, FanCentro, UVIU, Loyal Fans, Just For Fans, FlirtingFans, Many Vids, Uncove,
Clips4Sale, Unlockd, FanTime, Ifans, Unfiltrd, Other`.

`platform: "snap"` — at send time the server resolves the handle from `config.snapchat`:
`modelSetups[].accountPool[]` filtered by `accounts.receiving` (then `overflow`), formatted with
`config.snapchat.handleUrlTemplate` (`{username}` placeholder). No literal URL is stored for
Snapchat items.

## Optimizations tab

Computed client-side only (no data). It flags: no active URL, no phases, fewer than 10 opener
messages, etc. Nothing to store.

## Section export format (client-side export / server-side import)

```
{
  "format": "bambouai-section",
  "version": 1,
  "section": "urls",                 // one of: main, openers, phases, cta, urls,
                                     // objections, sprinkles, followups, finishers, ignorelist, media
  "exportedAt": "2026-10-18T…Z",
  "fromPreset": { "id": "1048", "name": "Mon preset" },
  "modules": { "urls": { … } }       // the preset sub-object(s) for that section
}
```

`POST /api/studio/presets/{presetId}/import-section` with `{section, payload:<the doc above>}`
replaces those modules inside the target preset and returns the updated studio config plus
`importedSection` and `presetId`.

Section → preset modules mapping (dashboard `SECTION_MODULES`):

| section | preset keys |
|---|---|
| main | identity, persona, style, strategy, behavior, mainSettings |
| openers | openers |
| phases | cycles (and phases) |
| cta | ctaScripts |
| urls | urls |
| objections | objections |
| sprinkles | sprinkles |
| followups | followups |
| finishers | finishers |
| ignorelist | ignoreConditions |
| media | media |

## Studio config document

```
{
  "version":     1,                           // schema version (live value: 1)
  "updatedAt":   "2026-10-…Z",                // last save timestamp
  "presets":     [ …preset objects… ],        // required, 1..100
  "accounts":    [ …ChatNow account objects… ],// required by the schema
  "engine":      { provider, baseUrl, model, temperature, maxTokens, parallelGenerations,
                   requestTimeoutSeconds, visionEnabled, visionBaseUrl, visionModel, visionDetail,
                   fallbackModel, recheckIntervalMinutes, fallbackChain,
                   apiKeyConfigured, visionApiKeyConfigured, fallbackKeyConfigured, ollamaKeyConfigured },
  "snapchat":    { autoRecreate, autoRecreateFirstName, pacing, limits24h,
                   addsPerAccountBeforeRotate, targetList, handleUrlTemplate, accounts,
                   proxies, adspowerSerials, proxyType, autoReconcileMinutes,
                   adoptRetryMinutes, modelSetups:[{id, name, model, presetId, mediaVaultId, accountPool:[…]}],
                   rdps:[…] },
  "extension":   { banAlertsEnabled, banKeywords, omegleSkipCountries, omegleSkipMessages,
                   webhookOmegleCom, webhookOmegleIo, webhookChatnow, wordReplacements },
  "abbreviations": { … }                      // word-shortening table used by workers
}
```

Account objects (config side) — live keys: `id, name, modelName, presetId, mediaVaultId, city,
enabled, autoReply, recreateOnTrigger, recreateTrigger ("chatnow_ban"|"chatnow_mute"|
"worker_error"), profileId, port, mailboxId, email` (proxy fields appear only when configured;
`replacementAccountId`/`recreateError` show up after a recreation attempt).

Live `GET /api/studio/engine-profiles` shape: `{activeId, profiles:[{id, label, provider,
baseUrl, model, note, warning, keyConfigured}]}` — e.g. active engine `routeway-gemma-3-27b`
(`{username}` placeholder).

**Rules enforced by the server on PUT:** whole document required (no partial update), at least
1 preset must remain (archived counts), max 100 presets, body ≤ 1 MiB, provider keys never
returned in clear (only `apiKeyConfigured`-style indicators).

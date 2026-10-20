# Nuntio — wat deze codebase anders doet dan Mailspring

Nuntio is een afsplitsing van [Foundry376/Mailspring](https://github.com/Foundry376/Mailspring)
(GPL-3.0, versie 1.26.0). Dit bestand is de wijzigingenlijst die GPL §5a vraagt: wat is aangepast
en waarom. De volledige upstream-historie zit in deze repo, dus `git log` blijft de bron van details.

Repo: <https://github.com/Bojanni050/nuntio> · branch `main` · upstream op afstand als
`git remote add upstream https://github.com/Foundry376/Mailspring.git`.

## Uitgangspunt

Upstream zet zijn betaalde features achter een Mailspring-account: de clientcode staat wél in de
GPL-repo, maar de package-loader, de plan-check en de quota's hangen aan `id.getmailspring.com`, en
tracking/vertaling/delen praten met `link.`- en `share.getmailspring.com`. Nuntio haalt die poorten
weg waar de feature puur lokaal is, en vervangt de tracking-backend door een eigen service.

## Wat is aangepast

| Bestand | Wijziging | Waarom |
|---|---|---|
| `app/package.json` | `name`/`productName`/`description` → Nuntio | merknaam is niet in de GPL inbegrepen; `productName` bepaalt ook de profielmap |
| `app/src/browser/application-menu.ts` | menulabel → `Nuntio` | idem |
| `app/internal_packages/open-tracking/package.json` | `isIdentityRequired` weg, `serverUrl` → eigen host | package laadde niet zonder Mailspring-ID; pixel ging naar de leverancier |
| `app/internal_packages/link-tracking/package.json` | idem | link-redirect gaat nu naar eigen host |
| `app/internal_packages/thread-snooze/package.json` | `isIdentityRequired` weg | snooze is puur lokaal |
| `app/internal_packages/send-reminders/package.json` | `isIdentityRequired` weg | idem |
| `app/internal_packages/activity/package.json` | `isIdentityRequired` weg | idem |
| `app/src/flux/stores/identity-store.ts` | `hasProFeatures()` → `true` | er is geen billing-server in deze build |
| `app/src/browser/autoupdate-manager.ts` | `AUTO_UPDATE_DISABLED = true` | anders vervangt de vendor-updater deze build door het officiële binary |
| `app/internal_packages/onboarding/lib/page-authenticate.tsx` | lokale pagina i.p.v. Webview naar `id.getmailspring.com` | die eerste-run-pagina ("Disable Cloud Features?") was HTML van hun server, niet aanpasbaar, en beweerde iets wat hier niet geldt |
| `app/src/compile-cache-ts.js` | cache-write is best-effort | op Windows faalde de atomaire rename (EPERM) en nam de module-load mee |
| `app/internal_packages/tracking-sync/` (nieuw) | poller die tellingen in `open_data`/`click_data` schrijft | de *writer* van die metadata zat op hun server |
| `tracking-server/` (nieuw) | pixel, link-redirect, `/api/tracked`, Dockerfile | vervangt `link.getmailspring.com` |
| `scripts/fetch-mailsync.js` (nieuw) | haalt de prebuilt sync-engine op | `npm install --ignore-scripts` slaat die stap over en de app start dan niet |

Bewust **niet** aangeraakt: `mailspring-exports`, `Mailspring-Sync`, het `mailspring://`-protocol en
de interne package-namen. Die zijn dragend; een volledige rename sloopt de build zonder winst.

## Wat werkt, en wat niet

**Zonder verdere backend:** snooze, send later, send reminders, activity, undo send, en alle
mail-functionaliteit (IMAP/SMTP, regels, sjablonen, zoeken).

**Met `tracking-server/`:** open tracking (pixel + teller), link tracking (redirect + teller), en de
"Opened by"/"Clicked by"-popovers die `open_data`/`click_data` lezen.

**Bewust uit** (pakketten houden `isIdentityRequired`, dus ze laden niet): `translation`,
`participant-profile` (contactverrijking), `thread-sharing`. Die kunnen niet zonder server-component.

## Draaien

```bash
npm install                       # Node 22 (node-llama-cpp gebruikt JSON-import-attributes)
npm start                         # electron ./app --dev
```

Ontbreekt de sync-engine ("could not find the mailsync process"), dan:

```bash
npm run fetch-mailsync
```

Map van de dev-data: `%APPDATA%\Nuntio-dev` (macOS: `~/Library/Application Support/Nuntio-dev`,
Linux: `~/.config/Nuntio-dev`).

## Licentie

GPL-3.0, zie `LICENSE.md`. Verspreid je binaries, dan moet de volledige bron mee — inclusief
`tracking-server/`. De naam en het logo van Mailspring zijn niet in de GPL inbegrepen en worden hier
niet gebruikt; omgekeerd is Nuntio niet gelieerd aan of goedgekeurd door het Mailspring-project.

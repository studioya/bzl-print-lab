# BZL Print Lab: student 3D print submissions

A single web page where students:

1. add up to **5 model files** (**STL, OBJ, 3MF or STEP**, up to 25 MB each) to the plate. STEP files
   are converted to a fine mesh in the browser (0.01 mm tolerance) with OpenCascade,
2. manage the **objects** on the plate like in Bambu Studio: **split** a file into its separate parts,
   **remove** objects, and set **copies** (1–10) per object,
3. pick one of the lab's **Bambu Studio printing profiles**, and a colour (black/white) **for each plate**,
4. choose, each time they add files, whether **the site lays the model out** (auto-orient for printing
   and placement on the plate) or **they do it themselves** (kept as in the file). The pop-up notes
   that the model prints as submitted, though lab supervisors may change the placement. The choice is
   recorded in the Sheet (*Laid out by*, and per object in *Objects*: site / student / site then
   adjusted by the student) and in `details.txt`,
5. **orient** each object (auto-orient, lay on face, rotate) and **resize** it (scale %, size in mm,
   or *Scale to fit the plate* for models that are too big),
6. **arrange the plates** like in Bambu Studio: copies are placed automatically, then students can
   drag pieces around, add plates (*+ Plate*), move a piece to another plate, delete a plate, or press
   *Arrange* (this plate) / *Arrange all* (re-pack everything onto as few plates as possible).
   Pieces that overlap or stick out of the plate turn red and block slicing,
7. **slice in the browser** with *Slice this plate* or *Slice all plates* and get a Bambu-style
   toolpath preview plus a **time and cost estimate**: the total across all plates and each plate's
   time and cost. A plate's result is kept until that plate changes; submitting needs every plate sliced,
8. see **when it would be ready**, from the lab's live queue,
9. press **Continue** (enabled once every plate is sliced), fill in their details in the pop-up and **submit** to the Bezalel Main Modelling Center. It goes straight into
   the print queue; the student gets a confirmation email with a **submission number** they can use
   on the site to **track** the status and current estimate,
10. and the lab runs the queue from a **handler dashboard**: printers up/down, what to print next,
   start/done/failed per plate, status emails.

Everything except the submission runs in the student's browser. There is no server to maintain;
the only backend is a free Google Apps Script attached to the lab's Google account.

```
index.html, css/, js/       the page (static, hosted on GitHub Pages)
js/slicer/                  the slicer (runs in a Web Worker)
js/config.js                lab settings: backend URL, pricing, limits, calibration
js/profile-info.js          student-facing profile names + descriptions (EN/HE)
js/profiles-data.js         GENERATED from profiles/ — don't edit by hand
js/project-presets.js       GENERATED from profiles/ — full presets for the Bambu project file
profiles/                   lab .bbscfg export + Bambu's base presets it inherits from
apps-script/                Google Apps Script backend (Drive + Sheet + email)
tools/                      profile resolver, vendored-library rebuild script
tests/                      Node tests (slicer, loaders, backend with mocked Google services)
vendor/                     three.js and Clipper, vendored so the page needs no CDN
fonts/                      Abraham (Bezalel's typeface, by Daniel Grumer), web subset — used under Bezalel's license
```

---

## Deploying

### 1. Host the page (GitHub Pages)

1. Merge this branch into `main`.
2. On GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/ (root)`**.
3. After a minute the page is live at `https://studioya.github.io/bzl-print-lab/`.

The page works as soon as it's hosted; until step 2 is done, **Submit** shows a message that
submissions aren't set up yet.

### 2. Deploy the backend (Google Apps Script)

Two Google accounts are involved:

- **Your work Google account** owns everything: the Drive folder, the data, and the script.
- **The lab Gmail** only *sends* emails (an email "from" a bezalel.ac.il address sent by Google
  fails the domain's checks and lands in spam). Students' replies therefore go to the lab Gmail,
  so anyone who handles prints can answer.

#### a. The backend (work account)

1. Signed in to the **work account**, go to <https://script.google.com> → **New project**. Name it
   `BZL Print Lab backend`.
2. **Project Settings (⚙) → tick "Show 'appsscript.json' manifest file in editor"**.
3. Add the files from [`apps-script/`](apps-script) (the **+** next to *Files*), replacing the
   contents of the ones that already exist:
   - `Code.gs` ← [`apps-script/Code.gs`](apps-script/Code.gs)
   - `Schedule.gs` ← [`apps-script/Schedule.gs`](apps-script/Schedule.gs) (the estimate engine)
   - `Dashboard.html` ← [`apps-script/Dashboard.html`](apps-script/Dashboard.html) (*+ → HTML*, name it `Dashboard`)
   - `appsscript.json` ← [`apps-script/appsscript.json`](apps-script/appsscript.json)
4. (Optional) At the top of `Code.gs`, check the `SETTINGS` (opening hours, handling time, number of
   printers, retention periods). The defaults are ready to use.
5. Choose **`setup`** in the toolbar and press **Run**. Approve the permissions (Google warns the
   app is unverified: *Advanced → Go to … (unsafe)*; it's your own script). The execution log shows
   the links to the new **BZL Print Lab** folder, the **Data** sheet, the **Outbox** sheet and the
   **Outbox ID**. Copy the Outbox ID for step b.
6. **Deploy → New deployment → Web app**, description `Intake`:
   *Execute as* **Me**, *Who has access* **Anyone**. Copy the URL (ends in `/exec`) into
   `appsScriptUrl` in [`js/config.js`](js/config.js), then commit and push.
7. **Deploy → New deployment → Web app** again, description `Dashboard`:
   *Execute as* **User accessing the web app**, *Who has access* **Anyone with Google account**.
   This URL is the **handler dashboard**: bookmark it.
8. **Share the `BZL Print Lab` folder** (in Drive) as **Editor** with each person who handles prints.
   That is what gives them the dashboard: it runs as them, with their own access. To remove
   someone, unshare the folder. The first time they open the dashboard Google asks them to approve
   it, as in step 5.

To change the script later: edit, then **Deploy → Manage deployments → ✏️ → Version: New version →
Deploy**, for *both* deployments. That keeps the URLs.

#### b. The mailer (lab Gmail)

1. In Drive (work account), share the **Outbox** sheet (inside the folder) with the lab Gmail as **Editor**.
2. Signed in to the **lab Gmail**, go to <https://script.google.com> → **New project**
   `BZL Print Lab mailer`. Show the manifest as above, then paste
   [`apps-script/mailer/Mailer.gs`](apps-script/mailer/Mailer.gs) into `Code.gs` and
   [`apps-script/mailer/appsscript.json`](apps-script/mailer/appsscript.json) into `appsscript.json`.
3. Paste the Outbox ID into `OUTBOX_ID`, choose **`install`** and press **Run**; approve.

It now sends waiting emails every 5 minutes. A failed email is retried (10 min, 20, 40…), and after
5 tries it's marked failed; the dashboard shows it, with a button to retry. One bad address never
holds up the others.

### How it works

- **A submission** creates a folder in `BZL Print Lab/Submissions/` named `2026-10-19 14.32 · P261019-7K3QX`
  (no names in folder names), containing the original files, `PLATES – <id> – plates.3mf` (a
  **Bambu Studio project** with every piece where the student put it, with the chosen colours and
  profile: open it with **File → Open Project**) and `details.txt` (the print details, no personal data).
  It goes **straight into the queue**, and the student gets one confirmation email with the
  submission number, a tracking link and the estimated ready date.
- **Students track their submission** on the site (*Track a submission*, or the link in the email):
  status, plates printed, place in the queue and the current estimate. No routine update emails; the
  only other emails are the ones a handler chooses to send (ready for pickup, on hold, rejected…).
- **Estimates**: the plates in queue order go to whichever working printer is free first. Prints are
  only *started* Sun–Thu 9:00–22:00 (and not on closed dates), but run through nights and weekends.
  Each plate counts the slicer's time plus 10 min handling. As plates are marked done, the real
  print times are compared with the slicer's and the estimates correct themselves. The site uses
  the same engine to show a student, before submitting, when their print would be ready.
  A date is only shown when it's reliable: every plate sliced, the queue reachable, at least
  2 printers working, and no more than 15 working days away (`SETTINGS.ESTIMATE` in `Code.gs`).
  Otherwise the student sees that a date can't be estimated right now (or "more than 3 weeks"),
  and that they'll be emailed when it's ready.
- **Cost:** prices are hidden for now (`pricing.showCost` in `js/config.js`, `SHOW_COST` in `Code.gs`); the page and emails say Bezalel is working on a pricing policy and printing won't always be free. When prices are shown, students aren't charged yet: the cost is shown as what printing will cost once payment
  is required (`pricing.charging` in `js/config.js` and `CHARGING` in `Code.gs`; set both to `true`
  when payment starts).
- **Plate pictures:** when a student submits, the page renders a picture of each plate as they laid
  it out (a close-up of the pieces, with the whole plate from above in the corner), saved as
  `PREVIEW – plate N.jpg`. The dashboard shows them in each request; click one to enlarge.
- **The dashboard** shows each printer (printing what, until when, what's next, with *Start* /
  *Done* / *Failed* buttons; *Mark down* takes it out of the estimates), the queue with estimated
  start and ready times, deadline-risk flags, and each request's details, files, plates, status
  changes (with an email preview) and lab notes. You can move a request up the queue, download the
  plates of several requests as one ZIP, and set closed dates (holidays).

### The data, and privacy

Everything is in the **Data** sheet (also linked from the dashboard). Don't rename tabs or reorder
columns; add your own columns only to the right of the existing ones, or use another tab.

| Tab | What | Kept |
|---|---|---|
| Requests | one row per submission: dates, status, department, course, profile, plates, estimates, ready/closed times… | always (for analysis) |
| Plates | one row per plate: estimated and actual minutes, printer, attempts, failures | always |
| History | who did what, when | always |
| Contacts | name, ID number, email, phone, student notes | wiped 180 days after the request closes |
| Printers, ClosedDates | the dashboard's settings | |

Students are identified in *Requests* by a **student key** (`S-…`): a keyed hash of their ID number.
The same student always gets the same key, so you can analyse repeat use, but the key can't be turned
back into an ID number. The secret it uses is in the script's *Project Settings → Script
Properties* (`STUDENT_KEY_SECRET`): **don't delete or change it**, or new keys won't match old ones.

Every night the script wipes contact details that are due, deletes model files 365 days after a
request closes (`FILE_RETENTION_DAYS`; 0 keeps them), removes temporary ZIPs, and closes submissions
whose upload never finished. Emails in the Outbox lose their address and body once sent.

### Limits of a free Google account

- **Storage:** 15 GB. Old model files are deleted automatically (above).
- **Email:** about 100 emails a day from the lab Gmail. Past that, emails wait for the next day.
- **Upload size:** 25 MB per file. Students with bigger files should export a coarser mesh.
- **Spam protection:** a hidden honeypot field, a minimum time on the page, server-side validation
  of every field, an allowed-file-type check and a per-email rate limit (6/hour).

### Trying changes locally

`npm test` runs the backend against simulated Google services. `node tools/dashboard-preview.mjs`
serves the dashboard with sample data at <http://localhost:8790>. After editing `js/schedule.js`,
run `npm run build:gs` to update `apps-script/Schedule.gs`.

---

## Settings ([`js/config.js`](js/config.js))

| Setting | Default | |
|---|---|---|
| `appsScriptUrl` | `''` | The *Intake* web app URL (step 2a.6) |
| `centers` | main | The "Send to" choices, shown only when there are two or more (English/Hebrew names). A center can have its own `appsScriptUrl` |
| `pricing.perGram` | `0.05` | ₪ per gram of filament |
| `pricing.perHour` | `5` | ₪ per hour of estimated printing time; warm-up/prepare time is not charged |
| `pricing.minimum` | `10` | ₪ minimum for each plate (a plate costing less is charged this) |
| `maxFiles` | `5` | model files per submission |
| `maxObjects` | `50` | objects on the plate (after splitting) |
| `maxCopies` | `10` | copies of each object |
| `maxFileMB` | `25` | |
| `timeCalibration` | `1.0` | multiplier for the time estimate (see below) |

The lead-time notice ("prints can take up to several weeks") is in `index.html`; the estimated
ready date next to the cost is calculated from the live queue.

## Calibrating the time estimate

The slicer copies Bambu Studio's approach and settings, but it isn't Bambu Studio, so estimates
will differ somewhat. To calibrate:

1. Pick 8–10 typical student models (small and large, with and without supports).
2. Slice each in Bambu Studio with the lab profile, and note the **model printing time**
   (not including the prepare time).
3. Slice the same file, same orientation and profile on the page and note its time.
4. Average the ratio *Bambu ÷ page* and put it in `timeCalibration.default`. If one profile is
   consistently off, add it to `perProfile`, e.g. `{ 'Fine - Bezalel Modelling Center': 1.08 }`.

## Updating the printing profiles

1. In Bambu Studio export the printer preset bundle (`.bbscfg`).
2. Unzip it and replace the contents of `profiles/lab/` with it (`printer/`, `process/`,
   `filament/`, `bundle_structure.json`).
3. If a preset now inherits from a different Bambu system preset, copy that preset's JSON from
   [BambuStudio/resources/profiles/BBL](https://github.com/bambulab/BambuStudio/tree/master/resources/profiles/BBL)
   into `profiles/bambu-base/`.
4. Run `node tools/resolve-profiles.mjs`. This regenerates `js/profiles-data.js` (what the slicer
   uses) and `js/project-presets.js` (the full presets written into the PLATES project file).
5. Students see each preset's own name with the shared suffix removed
   ("Normal - Bezalel Modelling Center" → "Normal"). Add a Hebrew name and a short EN/HE
   description for any new preset in `js/profile-info.js`.

The printable area comes straight from the printer preset (`printable_area` 18–258 mm, i.e. a
240 × 240 mm area, 250 mm high). Models that don't fit (after orientation) can't be submitted.

---

## How the slicer works

`js/slicer/` re-implements the main steps of Bambu Studio / PrusaSlicer, using the lab's resolved
preset values:

- **Slicing:** first layer 0.2 mm, then the profile's layer height; mesh cut at mid-layer and
  closed into polygons (tolerates slightly broken meshes); 0.0125 mm resolution.
- **Walls:** profile wall count and line widths, elephant-foot compensation, thin-wall detection,
  inner walls before the outer wall.
- **Shells:** top/bottom solid layers (incl. `top_shell_thickness`), bridges over air,
  `minimum_sparse_infill_area`.
- **Infill:** monotonic lines for solid areas, a port of Bambu's gyroid for sparse infill.
- **Supports:** an approximation of *tree (auto)*: overhangs past the profile threshold angle,
  build-plate-only, top Z gap, XY gap, 2 interface layers, branches that merge into thicker
  trunks as they go down.
- **Brim:** outer and inner, 5 mm.
- **Time:** a trapezoidal motion planner with Bambu's per-feature speeds and accelerations,
  classic jerk at corners, the filament's max volumetric speed (15 mm³/s for the lab's generic PLA), the
  20 mm/s first layer, overhang slowdowns, retractions, and the minimum layer time for cooling
  (8 s, down to 20 mm/s).
- **Sliced per plate:** each plate is estimated as the student arranged it, all its pieces printed
  together layer by layer, so travel between parts and shared layer time are counted as on the real
  printer (e.g. 4 small parts take much less than 4× one part). Each object is sliced once and reused
  for its copies.
- **Split** works like Bambu Studio's *Split → To objects*: a file is separated into its
  disconnected parts (by shared vertices). Note that a hollow model whose inner wall is a separate
  shell will also come apart, as it does in Bambu Studio.

Known simplifications: supports are an approximation of Bambu's trees, no ironing/fuzzy skin,
no gap-fill between walls, and no arc fitting. The calibration factor absorbs the systematic part
of these differences.

## Development

```bash
npm test                      # slicer, loaders, arrangement and backend tests (Node 18+)
python3 -m http.server 8000   # then open http://localhost:8000
tools/vendor.sh               # rebuild vendor/ (three.js, Clipper) from npm
```

No build step: the page is plain ES modules.

## Third-party code and data

- [three.js](https://threejs.org) r186 — MIT
- Abraham typeface by Daniel Grumer — Bezalel's licensed font, not for reuse outside this site
- [occt-import-js](https://github.com/kovacsv/occt-import-js) 0.0.23 (OpenCascade for the browser, STEP import) — LGPL-2.1, in `vendor/occt/` (the library is unmodified, only wrapped as an ES module)
- [Clipper](https://sourceforge.net/projects/jsclipper/) (JS port) 6.4.2 — Boost Software License
- Base presets in `profiles/bambu-base/` are from [Bambu Studio](https://github.com/bambulab/BambuStudio) — AGPL-3.0
- The gyroid wave generator follows PrusaSlicer/Bambu Studio's `FillGyroid` — AGPL-3.0

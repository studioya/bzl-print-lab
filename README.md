# BZL Print Lab: student 3D print submissions

A single web page where students:

1. add up to **5 model files** (**STL, OBJ or 3MF**, up to 25 MB each) to the plate,
2. manage the **objects** on the plate like in Bambu Studio: **split** a file into its separate parts,
   **remove** objects, and set **copies** (1–10) per object,
3. pick one of the lab's **Bambu Studio printing profiles** and a colour (black/white),
4. **orient** each object (auto-orient, lay on face, rotate) and **resize** it (scale %, size in mm,
   or *Scale to fit the plate* for models that are too big),
5. **arrange the plates** like in Bambu Studio: copies are placed automatically, then students can
   drag pieces around, add plates (*+ Plate*), move a piece to another plate, delete a plate, or press
   *Arrange* (this plate) / *Arrange all* (re-pack everything onto as few plates as possible).
   Pieces that overlap or stick out of the plate turn red and block slicing,
6. **slice in the browser**: *Slice this plate* or *Slice all plates* (each plate's result is kept
   until that plate changes; submitting needs every plate sliced). The estimate shows the total across
   all plates and the time and cost of each plate, and get a Bambu-style toolpath preview plus a **time and cost estimate**,
7. fill in their details and **submit**. The model lands in the lab's Google Drive folder
   `STUDENT 3D SUBMISSIONS`, the details go into a Google Sheet with a Status column, and the
   student gets a confirmation email.

Everything except the submission runs in the student's browser. There is no server to maintain;
the only backend is a free Google Apps Script attached to the lab's Google account.

```
index.html, css/, js/       the page (static, hosted on GitHub Pages)
js/slicer/                  the slicer (runs in a Web Worker)
js/config.js                lab settings: backend URL, price per minute, limits, calibration
js/profile-info.js          student-facing profile names + descriptions (EN/HE)
js/profiles-data.js         GENERATED from profiles/ — don't edit by hand
js/project-presets.js       GENERATED from profiles/ — full presets for the Bambu project file
profiles/                   lab .bbscfg export + Bambu's base presets it inherits from
apps-script/                Google Apps Script backend (Drive + Sheet + email)
tools/                      profile resolver, vendored-library rebuild script
tests/                      Node tests (slicer, loaders, backend with mocked Google services)
vendor/                     three.js and Clipper, vendored so the page needs no CDN
```

---

## Deploying

### 1. Host the page (GitHub Pages)

1. Merge this branch into `main`.
2. On GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/ (root)`**.
3. After a minute the page is live at `https://studioya.github.io/bzl-print-lab/`.

The page works as soon as it's hosted; until step 2 is done, **Submit** shows a message that
submissions aren't set up yet.

### 2. Deploy the submission backend (Google Apps Script)

Do this **while signed in to the lab's Google account**. Files and the Sheet are created in that
account's Drive, and confirmation emails are sent from it.

1. Go to <https://script.google.com> → **New project**. Name it `BZL Print Lab submissions`.
2. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
3. **Project Settings (⚙) → tick "Show 'appsscript.json' manifest file in editor"**, then replace
   `appsscript.json` with [`apps-script/appsscript.json`](apps-script/appsscript.json).
4. Optional: at the top of `Code.gs`, set `LAB_NOTIFY_EMAIL` (email the lab on every submission)
   and `REPLY_TO` (where student replies go).
5. Choose the `setup` function in the toolbar and press **Run**. Approve the permission prompt
   (Google warns that the app is unverified. Click *Advanced → Go to … (unsafe)*: it's your own script).
   This creates the `STUDENT 3D SUBMISSIONS` folder and the log Sheet inside it; the execution
   log prints both links.
6. **Deploy → New deployment → type: Web app**
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
7. Copy the **Web app URL** (ends in `/exec`) into `appsScriptUrl` in [`js/config.js`](js/config.js),
   then commit and push.

To change the script later: edit, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**.
That keeps the same URL. (A *new deployment* gets a new URL, which you'd then have to update in `config.js`.)

### What the lab gets

- **Drive:** `STUDENT 3D SUBMISSIONS/2026-10-06 14.32 · Student Name · P261006-7K3Q/` containing
  - `ORIGINAL – <file>`: each file exactly as the student uploaded it (files whose objects were all
    removed from the plate are not uploaded),
  - `PLATES – plates.3mf`: a **Bambu Studio project** with every piece exactly where the student put
    it, on the same plates, rotated and resized as they chose, with the printer, filament (colour) and
    printing profile they picked. Open it with **File → Open Project** (if you drag it into Bambu
    Studio instead, choose *Open as project*, not *Import geometry only*, or the plates are lost).
  - `<id> – details.txt`: all submission details, including what is on each plate.

  Folder names start with the date, so sorting the folder by **Name, Z→A** (or by *Last modified*)
  lists the newest submissions first. Drive remembers your sort choice.
- **Sheet** (`STUDENT 3D SUBMISSIONS – Log`, in the same folder): one row per submission, newest at the
  top. The *Objects* column lists every object with its copies and size; *Pieces* is the total. The **Status** column has a dropdown (New → In review → Queued → Printing → Ready for pickup →
  Picked up, plus On hold / Rejected / Cancelled), colour-coded. There's also a free **Lab notes**
  column. A row stuck on *Uploading* means the student's upload didn't finish; you can delete it.
- **Email:** the student gets a bilingual confirmation with their submission number and estimate.

### Limits of a free Gmail account

- **Storage:** 15 GB, shared with Gmail. STL files add up; archive or delete old submission
  folders now and then.
- **Email:** about 100 emails per day. Past that, submissions still work but the confirmation
  email is skipped.
- **Upload size:** 25 MB per file (an Apps Script request limit). Students with bigger files should
  export a coarser mesh.
- **Privacy:** the Sheet holds ID numbers, phone numbers and emails. Keep the folder and Sheet
  private to lab staff and never share them "with anyone with the link".
- **Spam protection:** a hidden honeypot field, a minimum time on the page, server-side validation
  of every field, an allowed-file-type check and a per-email rate limit (6/hour).

---

## Settings ([`js/config.js`](js/config.js))

| Setting | Default | |
|---|---|---|
| `appsScriptUrl` | `''` | Web app URL from step 2.7 |
| `pricePerMinute` | `0.5` | ₪ per minute of estimated print time; warm-up/prepare time is not charged |
| `maxFiles` | `5` | model files per submission |
| `maxObjects` | `50` | objects on the plate (after splitting) |
| `maxCopies` | `10` | copies of each object |
| `maxFileMB` | `25` | |
| `timeCalibration` | `1.0` | multiplier for the time estimate (see below) |

The lead-time notice ("prints can take up to several weeks") is in `index.html` and the
confirmation email in `Code.gs`. Change both when you have an average lead time.

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
- [Clipper](https://sourceforge.net/projects/jsclipper/) (JS port) 6.4.2 — Boost Software License
- Base presets in `profiles/bambu-base/` are from [Bambu Studio](https://github.com/bambulab/BambuStudio) — AGPL-3.0
- The gyroid wave generator follows PrusaSlicer/Bambu Studio's `FillGyroid` — AGPL-3.0
